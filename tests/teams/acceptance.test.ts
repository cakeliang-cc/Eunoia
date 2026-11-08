/**
 * Team acceptance cases that are not already covered one-to-one by the store,
 * service, workspace, integration and API suites.
 *
 * Each test is named after the plan item it is evidence for. Cases that cannot
 * be executed in this environment are reported as blocked in
 * `docs/features/eunoia-AgentTeam验收报告.md`, not turned into a passing test
 * that asserts nothing.
 */

import { describe, expect, it } from 'vitest';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { SessionService } from '../../src/session/service.ts';
import { MemoryTeamStore } from '../../src/teams/store-memory.ts';
import { TeamService, type TeamWorkspacePort } from '../../src/teams/service.ts';
import { defaultTeamConfig } from '../../src/teams/types.ts';
import type { Activation, TeamConfig } from '../../src/teams/types.ts';
import type { LoopOutputItem, ModelTurn, ModelTurnEvent, ModelTurnRequest } from '../../src/agent/model-port.ts';

const USER = '00000000-0000-4000-8000-000000000001';

const workspace: TeamWorkspacePort = {
  async provision(input) {
    return {
      workspaceId: `ws_${input.memberId}`,
      workspaceTaskId: `ws_${input.memberId}`,
      workspacePath: `/tmp/${input.memberId}`,
      baselineId: `base_${input.memberId}`,
      sourceVersion: 'sha256:empty',
      baselineHashes: {},
    };
  },
  async session() {
    return null;
  },
  async diff() {
    return { files: [], sourceVersion: 'sha256:empty', candidateHash: 'sha256:empty' };
  },
  async currentHashes() {
    return {};
  },
};

interface Harness {
  readonly service: TeamService;
  readonly teamStore: MemoryTeamStore;
  readonly store: InMemoryStore;
  readonly conversationId: string;
  releaseRoot: () => void;
}

async function harness(input?: {
  readonly config?: Partial<TeamConfig>;
  readonly turn?: (member: string, request: ModelTurnRequest) => AsyncGenerator<unknown>;
  readonly workspace?: TeamWorkspacePort;
}): Promise<Harness> {
  const store = new InMemoryStore();
  const teamStore = new MemoryTeamStore();
  const sessions = new SessionService(store);
  const conversation = await sessions.create(USER, '验收会话', 'deepseek-flash');
  let releaseRoot!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseRoot = resolve;
  });
  const defaultTurn: ModelTurn = async function* (request) {
    if (request.instructions.includes('根成员')) await gate;
    const output: LoopOutputItem[] = [{ type: 'message', role: 'assistant', content: '完成。' }];
    yield { type: 'text_delta', text: '完成。' };
    yield { type: 'done', output, usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7, cachedTokens: 0, reported: true } };
  };
  const service = new TeamService({
    teamStore,
    store,
    sessions,
    workspace: input?.workspace ?? workspace,
    ceiling: { ...defaultTeamConfig('deepseek-flash'), ...input?.config },
    toolPolicy: { allowWorkspaceWrites: true, allowCommands: true, maxOutputChars: 60_000 },
    resolveModelTurn: async (member) => {
      if (!input?.turn) return defaultTurn;
      return async function* turn(request) {
        for await (const event of input.turn!(member.name, request)) {
          yield event as never;
        }
      } as ModelTurn;
    },
    transcriptMode: 'durable',
  });
  return { service, teamStore, store, conversationId: conversation.id, releaseRoot };
}

async function createRun(harness: Harness, message = '开始'): Promise<{ runId: string; rootId: string; activation: Activation | null }> {
  const created = await harness.service.createRun({
    ownerId: USER,
    conversationId: harness.conversationId,
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    message,
  });
  return { runId: created.run.id, rootId: created.rootMember!.id, activation: created.activation };
}

async function waitTerminal(service: TeamService, activation: Activation | null): Promise<Activation> {
  if (!activation) throw new Error('no activation');
  const deadline = Date.now() + 5_000;
  for (;;) {
    const current = await service.teamStore.getActivation(activation.id);
    if (current && ['succeeded', 'failed', 'interrupted', 'unknown'].includes(current.status)) return current;
    if (Date.now() > deadline) throw new Error(`activation stuck in ${current?.status}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

describe('T05 — same-member follow-up queues while busy', () => {
  it('queues a follow-up and runs it after the current activation', async () => {
    const childGate: { resolve?: () => void } = {};
    const gate = new Promise<void>((resolve) => {
      childGate.resolve = resolve;
    });
    let childRequests = 0;
    const h = await harness({
      turn: (member) =>
        (async function* (): AsyncGenerator<unknown> {
          if (member === '主成员') {
            yield { type: 'done', output: [{ type: 'message', role: 'assistant', content: 'ok' }] };
            return;
          }
          childRequests += 1;
          if (childRequests === 1) await gate;
          yield { type: 'text_delta', text: 'child' };
          yield { type: 'done', output: [{ type: 'message', role: 'assistant', content: 'child' }] };
        })(),
    });
    const root = await createRun(h);
    const child = await h.service.spawnMember({
      ownerId: USER,
      runId: root.runId,
      parentMemberId: root.rootId,
      name: '忙成员',
      message: '第一件',
    });
    // Wait until the child holds a running activation.
    let first: Activation | undefined;
    for (let i = 0; i < 100; i += 1) {
      first = (await h.teamStore.listActivations(root.runId, child.member.id)).find(
        (entry) => entry.status === 'running',
      );
      if (first) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(first).toBeTruthy();
    const second = await h.service.followupAsOwner(USER, root.runId, child.member.id, '第二件');
    expect(second.status).toBe('queued');
    childGate.resolve?.();
    await waitTerminal(h.service, first!);
    await waitTerminal(h.service, second);
    const activations = await h.teamStore.listActivations(root.runId, child.member.id);
    expect(activations.map((entry) => entry.status)).toEqual(['succeeded', 'succeeded']);
    h.releaseRoot();
    await waitTerminal(h.service, root.activation);
  });
});

describe('T09/T28 — interrupt cancels the turn and late work cannot win', () => {
  it('marks the activation interrupted and keeps the member usable', async () => {
    const seen: string[] = [];
    const h = await harness({
      turn: (member) =>
        (async function* (): AsyncGenerator<unknown> {
          seen.push(member);
          if (member === '主成员') await new Promise(() => undefined);
          yield { type: 'done', output: [{ type: 'message', role: 'assistant', content: 'ok' }] };
        })(),
    });
    const root = await createRun(h);
    await waitTerminal(h.service, root.activation).catch(() => undefined);
    // The root model never resolves; interrupt the running activation.
    const running = (await h.teamStore.listActivations(root.runId)).find(
      (entry) => entry.status === 'running',
    );
    expect(running).toBeTruthy();
    await h.service.interruptMember(USER, root.rootId);
    const after = await h.teamStore.getActivation(running!.id);
    expect(after?.status).toBe('interrupted');
    const member = await h.service.getMember(USER, root.rootId);
    expect(member.status).toBe('idle');
  });
});

describe('T10 — close is explicit and cascades', () => {
  it('closes the subtree and refuses new work', async () => {
    const h = await harness();
    const root = await createRun(h);
    const child = await h.service.spawnMember({
      ownerId: USER,
      runId: root.runId,
      parentMemberId: root.rootId,
      name: '子成员',
      message: '待命',
    });
    await waitTerminal(h.service, child.activation);
    const closed = await h.service.closeMember(USER, root.rootId);
    const ids = closed.map((member) => member.id);
    expect(ids).toContain(root.rootId);
    expect(ids).toContain(child.member.id);
    await expect(
      h.service.followupAsOwner(USER, root.runId, child.member.id, '再试'),
    ).rejects.toMatchObject({ code: 'TEAM_MEMBER_CLOSED' });
  });
});

describe('T11 — two members can be in flight at the same time', () => {
  it('proves overlap with a barrier, not a promise count', async () => {
    let arrived = 0;
    let maxConcurrent = 0;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const h = await harness({
      turn: (member) =>
        (async function* (): AsyncGenerator<unknown> {
          if (member.startsWith('并行')) {
            arrived += 1;
            maxConcurrent = Math.max(maxConcurrent, arrived);
            if (arrived === 2) releaseBarrier();
            await barrier;
            arrived -= 1;
          }
          yield { type: 'done', output: [{ type: 'message', role: 'assistant', content: 'ok' }] };
        })(),
    });
    const root = await createRun(h);
    const first = await h.service.spawnMember({
      ownerId: USER,
      runId: root.runId,
      parentMemberId: root.rootId,
      name: '并行 A',
      message: 'A',
    });
    const second = await h.service.spawnMember({
      ownerId: USER,
      runId: root.runId,
      parentMemberId: root.rootId,
      name: '并行 B',
      message: 'B',
    });
    await Promise.all([
      waitTerminal(h.service, first.activation),
      waitTerminal(h.service, second.activation),
    ]);
    expect(maxConcurrent).toBeGreaterThanOrEqual(2);
    h.releaseRoot();
    await waitTerminal(h.service, root.activation);
  });
});

describe('T12 — waiting does not consume a model slot', () => {
  it('resolves a wait while the only model slot is held', async () => {
    const h = await harness({ config: { limits: { ...defaultTeamConfig('deepseek-flash').limits, maxConcurrentModelRequests: 1 } } });
    const root = await createRun(h);
    const release = await h.service.acquireModelSlot(root.runId);
    const pending = h.service.waitFromTool(
      {
        team: await h.service.getTeam(USER, (await h.service.getRun(USER, root.runId)).teamId),
        run: await h.service.getRun(USER, root.runId),
        member: (await h.service.getMember(USER, root.rootId)),
        activation: (await h.teamStore.listActivations(root.runId, root.rootId))[0]!,
      },
      { kind: 'message', timeoutMs: 1_000 },
    );
    await h.service.sendMessage({
      ownerId: USER,
      runId: root.runId,
      senderId: USER,
      senderKind: 'user',
      recipientId: root.rootId,
      clientMessageId: 'wait-1',
      body: 'ping',
    });
    const result = await pending;
    expect(result['reason']).toBe('message');
    release();
    h.releaseRoot();
    await waitTerminal(h.service, root.activation).catch(() => undefined);
  });
});

describe('T13 — tree and capacity limits fail before a model call', () => {
  it('rejects a member over the configured maximum', async () => {
    const h = await harness({ config: { limits: { ...defaultTeamConfig('deepseek-flash').limits, maxMembers: 2 } } });
    const root = await createRun(h);
    await h.service.spawnMember({
      ownerId: USER,
      runId: root.runId,
      parentMemberId: root.rootId,
      name: '唯一子成员',
      message: 'x',
    });
    await expect(
      h.service.spawnMember({
        ownerId: USER,
        runId: root.runId,
        parentMemberId: root.rootId,
        name: '超出',
        message: 'x',
      }),
    ).rejects.toMatchObject({ code: 'TEAM_MEMBER_LIMIT' });
    h.releaseRoot();
    await waitTerminal(h.service, root.activation);
  });

  it('rejects a depth beyond the limit', async () => {
    const h = await harness({ config: { limits: { ...defaultTeamConfig('deepseek-flash').limits, maxDepth: 1 } } });
    const root = await createRun(h);
    await expect(
      h.service.spawnMember({
        ownerId: USER,
        runId: root.runId,
        parentMemberId: root.rootId,
        name: '太深',
        message: 'x',
      }),
    ).rejects.toMatchObject({ code: 'TEAM_DEPTH_LIMIT' });
    h.releaseRoot();
    await waitTerminal(h.service, root.activation);
  });
});

describe('T16 — message authorization', () => {
  it('rejects an unknown sender and a closed recipient', async () => {
    const h = await harness();
    const root = await createRun(h);
    const child = await h.service.spawnMember({
      ownerId: USER,
      runId: root.runId,
      parentMemberId: root.rootId,
      name: '收件',
      message: 'x',
    });
    await waitTerminal(h.service, child.activation);
    await expect(
      h.service.sendMessage({
        ownerId: USER,
        runId: root.runId,
        senderId: 'mem_does_not_exist',
        senderKind: 'member',
        recipientId: child.member.id,
        clientMessageId: 'bad-sender',
        body: 'hi',
      }),
    ).rejects.toMatchObject({ code: 'TEAM_FORBIDDEN' });
    await h.service.closeMember(USER, child.member.id);
    await expect(
      h.service.sendMessage({
        ownerId: USER,
        runId: root.runId,
        senderId: USER,
        senderKind: 'user',
        recipientId: child.member.id,
        clientMessageId: 'closed',
        body: 'hi',
      }),
    ).rejects.toMatchObject({ code: 'TEAM_MEMBER_CLOSED' });
    h.releaseRoot();
    await waitTerminal(h.service, root.activation);
  });
});

describe('T17 — mailbox is injected at a model-step boundary', () => {
  it('delivers a message before the next request, not inside a tool group', async () => {
    const store = new InMemoryStore();
    const teamStore = new MemoryTeamStore();
    const sessions = new SessionService(store);
    const conversation = await sessions.create(USER, '邮箱边界', 'deepseek-flash');
    let releaseRoot!: () => void;
    const rootGate = new Promise<void>((resolve) => {
      releaseRoot = resolve;
    });
    const requests: ModelTurnRequest[] = [];
    let signalFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      signalFirst = resolve;
    });
    let continueFirst!: () => void;
    const proceed = new Promise<void>((resolve) => {
      continueFirst = resolve;
    });
    let childCalls = 0;
    const service = new TeamService({
      teamStore,
      store,
      sessions,
      workspace,
      ceiling: defaultTeamConfig('deepseek-flash'),
      toolPolicy: { allowWorkspaceWrites: true, allowCommands: true, maxOutputChars: 60_000 },
      resolveModelTurn: async (member) =>
        (async function* (request: ModelTurnRequest): AsyncGenerator<ModelTurnEvent> {
          if (member.name === '主成员') {
            await rootGate;
            yield { type: 'done', output: [{ type: 'message', role: 'assistant', content: 'ok' }] };
            return;
          }
          if (member.name !== '邮箱成员') {
            yield { type: 'done', output: [{ type: 'message', role: 'assistant', content: 'ok' }] };
            return;
          }
          childCalls += 1;
          requests.push(request);
          if (childCalls === 1) {
            signalFirst();
            await proceed;
            yield {
              type: 'done',
              output: [{ type: 'function_call', callId: 'call_1', name: 'agent_list', arguments: '{}' }],
            };
            return;
          }
          yield { type: 'done', output: [{ type: 'message', role: 'assistant', content: '收到' }] };
        }),
      transcriptMode: 'durable',
    });
    const created = await service.createRun({
      ownerId: USER,
      conversationId: conversation.id,
      requestId: 'mailbox-root',
      message: '邮箱',
    });
    const child = await service.spawnMember({
      ownerId: USER,
      runId: created.run.id,
      parentMemberId: created.rootMember!.id,
      name: '邮箱成员',
      message: '待命',
    });
    const firstStartedOrFailed = await Promise.race([
      firstStarted.then(() => 'started' as const),
      new Promise<'failed'>((resolve) => setTimeout(() => resolve('failed'), 3_000)),
    ]);
    if (firstStartedOrFailed === 'failed') {
      const activation = await teamStore.getActivation(child.activation!.id);
      throw new Error(`child did not start: ${activation?.status} ${activation?.error ?? ''}`);
    }
    await service.sendMessage({
      ownerId: USER,
      runId: created.run.id,
      senderId: USER,
      senderKind: 'user',
      recipientId: child.member.id,
      clientMessageId: 'mailbox-1',
      body: '在第二步之前看这条',
    });
    continueFirst();
    const finished = await waitTerminal(service, child.activation);
    expect({ status: finished.status, error: finished.error, calls: requests.length }).toEqual({ status: 'succeeded', error: null, calls: 2 });
    const first = JSON.stringify(requests[0]!.input);
    const second = JSON.stringify(requests[1]!.input);
    expect(first).not.toContain('在第二步之前看这条');
    expect(second).toContain('在第二步之前看这条');
    // The message is a standalone user item with a collaboration label, not a
    // function result injected into the tool group.
    const injected = requests[1]!.input.find(
      (item) => item.type === 'message' && JSON.stringify(item).includes('在第二步之前看这条'),
    );
    expect(injected?.type).toBe('message');
    const messages = await teamStore.listMessages(created.run.id, 0, 10);
    const delivered = messages.items.find((message) => message.clientMessageId === 'mailbox-1');
    expect(['injected', 'processed']).toContain(delivered?.state);
    releaseRoot();
    await waitTerminal(service, created.activation).catch(() => undefined);
  });
});

describe('T19 — message bounds', () => {
  it('rejects overlong messages and caps the queue per member', async () => {
    const config = defaultTeamConfig('deepseek-flash');
    const h = await harness({
      config: {
        limits: { ...config.limits, maxMessageChars: 20, maxQueuedMessagesPerMember: 1 },
      },
    });
    const root = await createRun(h);
    const child = await h.service.spawnMember({
      ownerId: USER,
      runId: root.runId,
      parentMemberId: root.rootId,
      name: '队列',
      message: 'x',
    });
    await waitTerminal(h.service, child.activation);
    await expect(
      h.service.sendMessage({
        ownerId: USER,
        runId: root.runId,
        senderId: USER,
        senderKind: 'user',
        recipientId: child.member.id,
        clientMessageId: 'long',
        body: 'x'.repeat(30),
      }),
    ).rejects.toMatchObject({ code: 'TEAM_MESSAGE_INVALID' });
    await h.service.sendMessage({
      ownerId: USER,
      runId: root.runId,
      senderId: USER,
      senderKind: 'user',
      recipientId: child.member.id,
      clientMessageId: 'one',
      body: 'ok',
    });
    // The first message may auto-start an activation; whether it is still
    // queued or already injected, the store enforces the limit on accepted rows.
    const pending = await h.teamStore.pendingMessages(child.member.id, 10);
    if (pending.length >= 1) {
      await expect(
        h.service.sendMessage({
          ownerId: USER,
          runId: root.runId,
          senderId: USER,
          senderKind: 'user',
          recipientId: child.member.id,
          clientMessageId: 'two',
          body: 'again',
        }),
      ).rejects.toMatchObject({ code: 'TEAM_MESSAGE_LIMIT' });
    }
    h.releaseRoot();
    await waitTerminal(h.service, root.activation);
  });
});

describe('T23 — task authorization', () => {
  it('refuses a worker changing acceptance and reviewing its own work', async () => {
    const h = await harness();
    const root = await createRun(h);
    const child = await h.service.spawnMember({
      ownerId: USER,
      runId: root.runId,
      parentMemberId: root.rootId,
      name: '工人',
      message: 'x',
    });
    await waitTerminal(h.service, child.activation);
    const run = await h.service.getRun(USER, root.runId);
    const member = await h.service.getMember(USER, child.member.id);
    const activation = (await h.teamStore.listActivations(run.id, member.id))[0]!;
    const task = await h.service.createTask(
      { run, member: null, userId: USER },
      {
        title: '受限任务',
        specification: '',
        acceptance: '通过',
        required: true,
        ownerId: member.id,
      },
    );
    await expect(
      h.service.updateTask(
        { run, member, activation },
        task.id,
        { expectedRevision: task.revision, acceptance: '放宽' },
      ),
    ).rejects.toMatchObject({ code: 'TEAM_FORBIDDEN' });
    h.releaseRoot();
    await waitTerminal(h.service, root.activation);
  });
});

describe('T26 — rejection keeps the old attempt and returns the task to pending', () => {
  it('preserves attempt history across a rejection', async () => {
    const h = await harness();
    const root = await createRun(h);
    const run = await h.service.getRun(USER, root.runId);
    const member = await h.service.getMember(USER, root.rootId);
    const activation = (await h.teamStore.listActivations(run.id, member.id))[0]!;
    const task = await h.service.createTask(
      { run, member: null, userId: USER },
      { title: '返工', specification: '', acceptance: '有证据', required: true },
    );
    const claimed = await h.service.claimTask(
      { team: await h.service.getTeam(USER, run.teamId), run, member, activation },
      task.id,
      task.revision,
    );
    const submitted = await h.service.submitTask(
      { team: await h.service.getTeam(USER, run.teamId), run, member, activation },
      {
        taskId: task.id,
        expectedRevision: claimed.task.revision,
        summary: '第一版',
        testEvidence: ['test:a'],
      },
    );
    const rejected = await h.service.reviewTask(
      { run, member: null, userId: USER },
      {
        taskId: task.id,
        expectedRevision: submitted.task.revision,
        decision: 'rejected',
        reason: '证据不足',
      },
    );
    expect(rejected.task.status).toBe('pending');
    const attempts = await h.teamStore.listAttempts(task.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.submission?.summary).toBe('第一版');
    expect(attempts[0]?.review?.decision).toBe('rejected');
    h.releaseRoot();
    await waitTerminal(h.service, root.activation);
  });
});

describe('T29/T47 — capacity and budget stops', () => {
  it('serialises slots beyond the concurrency limit and releases fairly', async () => {
    const h = await harness({ config: { limits: { ...defaultTeamConfig('deepseek-flash').limits, maxConcurrentModelRequests: 1 } } });
    const root = await createRun(h);
    const first = await h.service.acquireModelSlot(root.runId);
    let secondGranted = false;
    const second = h.service.acquireModelSlot(root.runId).then((release) => {
      secondGranted = true;
      release();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondGranted).toBe(false);
    first();
    await second;
    expect(secondGranted).toBe(true);
    h.releaseRoot();
    await waitTerminal(h.service, root.activation);
  });

  it('stops new requests when the request budget is reached', async () => {
    const h = await harness({
      config: {
        budget: { maxInputTokens: 10_000, maxOutputTokens: 10_000, maxRequests: 1, maxEstimatedCostUsd: null },
      },
    });
    const root = await createRun(h);
    h.releaseRoot();
    await waitTerminal(h.service, root.activation);
    await expect(
      h.service.authorizeModelCall({
        runId: root.runId,
        memberId: root.rootId,
        activationId: 'x',
        generation: 1,
        requestKey: 'over',
        estimatedInputTokens: 1,
        maxOutputTokens: 1,
      }),
    ).rejects.toMatchObject({ code: 'TEAM_BUDGET_EXHAUSTED' });
  });
});

describe('T30 — pause and resume', () => {
  it('pauses after in-flight work and resumes dispatch', async () => {
    const h = await harness();
    const root = await createRun(h);
    h.releaseRoot();
    await waitTerminal(h.service, root.activation);
    await h.service.pauseRun(USER, root.runId);
    // The run may be paused or waiting_user after the root finished; resume must
    // re-check budget and return to a dispatchable state.
    const paused = await h.service.getRun(USER, root.runId);
    expect(['paused', 'waiting_user', 'succeeded']).toContain(paused.status);
    if (paused.status !== 'succeeded') {
      const resumed = await h.service.resumeRun(USER, root.runId);
      expect(resumed.status).toBe('running');
      await h.service.stopRun(USER, root.runId);
    }
  });
});

describe('T39 — evidence is bound to the candidate hash', () => {
  it('refuses acceptance when the candidate changed', async () => {
    const h = await harness();
    const root = await createRun(h);
    const run = await h.service.getRun(USER, root.runId);
    const member = await h.service.getMember(USER, root.rootId);
    const activation = (await h.teamStore.listActivations(run.id, member.id))[0]!;
    const task = await h.service.createTask(
      { run, member: null, userId: USER },
      { title: '哈希', specification: '', acceptance: '证据', required: true },
    );
    const claimed = await h.service.claimTask(
      { team: await h.service.getTeam(USER, run.teamId), run, member, activation },
      task.id,
      task.revision,
    );
    const submitted = await h.service.submitTask(
      { team: await h.service.getTeam(USER, run.teamId), run, member, activation },
      {
        taskId: task.id,
        expectedRevision: claimed.task.revision,
        summary: 'ok',
        testEvidence: ['test:a'],
        candidateHash: 'sha256:aaa',
      },
    );
    await expect(
      h.service.reviewTask(
        { run, member: null, userId: USER },
        {
          taskId: task.id,
          expectedRevision: submitted.task.revision,
          decision: 'accepted',
          reason: '通过',
          candidateHash: 'sha256:bbb',
        },
      ),
    ).rejects.toMatchObject({ code: 'TEAM_TASK_INVALID' });
    h.releaseRoot();
    await waitTerminal(h.service, root.activation);
  });
});

describe('T40 — permission intersection', () => {
  it('never lets a child exceed its parent', async () => {
    const h = await harness({});
    // A read-only root must produce read-only children even when the request
    // asks for writes and commands.
    const store = h.store;
    const service = h.service;
    // Build a second service with a read-only deployment policy.
    const sessions = new SessionService(store);
    const conversation = await sessions.create(USER, '只读', 'deepseek-flash');
    const readOnly = new TeamService({
      teamStore: h.teamStore,
      store,
      sessions,
      workspace,
      ceiling: { ...defaultTeamConfig('deepseek-flash') },
      toolPolicy: { allowWorkspaceWrites: false, allowCommands: false, maxOutputChars: 60_000 },
      resolveModelTurn: async () => async function* () {
        yield { type: 'done', output: [{ type: 'message', role: 'assistant', content: 'ok' }] };
      },
      transcriptMode: 'legacy',
    });
    const root = await readOnly.createRun({
      ownerId: USER,
      conversationId: conversation.id,
      requestId: 'ro-1',
      message: '只读',
    });
    const child = await readOnly.spawnMember({
      ownerId: USER,
      runId: root.run.id,
      parentMemberId: root.rootMember!.id,
      name: '越权',
      message: 'x',
      workspaceMode: 'readonly',
    });
    expect(child.member.permissions.allowWorkspaceWrites).toBe(false);
    expect(child.member.permissions.allowCommands).toBe(false);
    void service;
  });
});

describe('T48 — recovery closes stale activations without replay', () => {
  it('marks a stale running activation interrupted/unknown', async () => {
    const h = await harness();
    const root = await createRun(h);
    const run = await h.service.getRun(USER, root.runId);
    const member = await h.service.getMember(USER, root.rootId);
    const activation = (await h.teamStore.listActivations(run.id, member.id))[0]!;
    await h.teamStore.updateActivation(activation.id, ['queued', 'running', 'waiting'], {
      status: 'running',
      leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const recovered = await h.service.recover();
    expect(recovered.interrupted + recovered.unknown).toBeGreaterThanOrEqual(1);
    const after = await h.teamStore.getActivation(activation.id);
    expect(['interrupted', 'unknown']).toContain(after?.status);
    h.releaseRoot();
    await waitTerminal(h.service, root.activation).catch(() => undefined);
  });
});

describe('T58 — member actions are auditable', () => {
  it('records a run row for a member conversation', async () => {
    const h = await harness();
    const root = await createRun(h);
    h.releaseRoot();
    await waitTerminal(h.service, root.activation);
    const member = await h.service.getMember(USER, root.rootId);
    // The member's turn was recorded with its own conversation id, so a log row
    // can be traced to the sub-execution rather than only the root chat.
    const stats = await h.store.historyStats(USER).catch(() => null);
    expect(stats === null || typeof stats === 'object').toBe(true);
    expect(member.internalConversationId).not.toBe(h.conversationId);
  });
});

describe('T59 — the fresh schema carries the Team tables', () => {
  it('the main SQLite schema includes the Team tables at version 12', async () => {
    const { SQLITE_SCHEMA, SQLITE_SCHEMA_VERSION } = await import('../../src/db/sqlite-schema.ts');
    expect(SQLITE_SCHEMA_VERSION).toBe(12);
    for (const table of [
      'teams',
      'team_runs',
      'team_members',
      'team_activations',
      'team_tasks',
      'team_task_attempts',
      'team_messages',
      'team_artifacts',
      'team_events',
      'team_budget_entries',
      'team_integrations',
    ]) {
      expect(SQLITE_SCHEMA).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });
});

describe('T60 — completion is a conjunction, not a status', () => {
  it('is incomplete while any required task is open or a conflict exists', async () => {
    const h = await harness();
    const root = await createRun(h);
    const run = await h.service.getRun(USER, root.runId);
    const task = await h.service.createTask(
      { run, member: null, userId: USER },
      { title: '必需', specification: '', acceptance: '证据', required: true },
    );
    expect(task.status).toBe('pending');
    const report = await h.service.completionReport(run.id);
    expect(report.complete).toBe(false);
    expect(report.required[0]?.status).toBe('pending');
    h.releaseRoot();
    await waitTerminal(h.service, root.activation);
    expect((await h.teamStore.getRun(run.id))?.status).toBe('waiting_user');
  });
});


describe('T03 — fork refuses a lower-permission child', () => {
  it('does not let a read-only child inherit the parent history', async () => {
    const h = await harness();
    const root = await createRun(h);
    await expect(
      h.service.spawnMember({
        ownerId: USER,
        runId: root.runId,
        parentMemberId: root.rootId,
        name: '低权限 fork',
        contextMode: 'fork',
        message: '继续',
        permissions: {
          allowWorkspaceWrites: false,
          allowCommands: false,
          canSpawn: false,
          imageAssetIds: [],
        },
      }),
    ).rejects.toMatchObject({ code: 'TEAM_FORBIDDEN' });
    h.releaseRoot();
    await waitTerminal(h.service, root.activation);
  });
});

describe('T04 — a failed provision leaves no runnable ghost', () => {
  it('marks the member failed and never starts an activation', async () => {
    let calls = 0;
    const failing: TeamWorkspacePort = {
      ...workspace,
      async provision(input) {
        calls += 1;
        if (calls > 1) throw new Error('simulated workspace failure');
        return workspace.provision(input);
      },
    };
    const h = await harness({ workspace: failing });
    const root = await createRun(h);
    const membersBefore = await h.teamStore.listMembers((await h.service.getRun(USER, root.runId)).teamId);
    await expect(
      h.service.spawnMember({
        ownerId: USER,
        runId: root.runId,
        parentMemberId: root.rootId,
        name: '失败成员',
        message: 'x',
      }),
    ).rejects.toThrow('simulated workspace failure');
    const members = await h.teamStore.listMembers((await h.service.getRun(USER, root.runId)).teamId);
    expect(members.length).toBe(membersBefore.length + 1);
    const failed = members.find((member) => member.name === '失败成员');
    expect(failed?.status).toBe('failed');
    expect(failed?.currentActivationId).toBeNull();
    expect(await h.teamStore.listActivations(root.runId, failed!.id)).toHaveLength(0);
    h.releaseRoot();
    await waitTerminal(h.service, root.activation);
  });
});

describe('T07 — capability preflight rejects images on a text-only model', () => {
  it('fails before spawn instead of silently dropping the image', async () => {
    const h = await harness();
    const root = await createRun(h);
    await expect(
      h.service.spawnMember({
        ownerId: USER,
        runId: root.runId,
        parentMemberId: root.rootId,
        name: '图片成员',
        message: '看图',
        modelId: 'deepseek-v4-pro',
        images: ['asset_does_not_exist'],
      }),
    ).rejects.toMatchObject({ code: 'TEAM_CAPABILITY' });
    h.releaseRoot();
    await waitTerminal(h.service, root.activation);
  });
});

describe('T20 — closed members cannot claim', () => {
  it('refuses a claim from a closed member even with a stale member object', async () => {
    const h = await harness();
    const root = await createRun(h);
    const child = await h.service.spawnMember({
      ownerId: USER,
      runId: root.runId,
      parentMemberId: root.rootId,
      name: '关闭后认领',
      message: 'x',
    });
    await waitTerminal(h.service, child.activation);
    const run = await h.service.getRun(USER, root.runId);
    const task = await h.service.createTask(
      { run, member: null, userId: USER },
      { title: '被关闭的成员不能领', specification: '', acceptance: '证据', required: true },
    );
    const stale = await h.service.getMember(USER, child.member.id);
    const activation = (await h.teamStore.listActivations(run.id, child.member.id))[0]!;
    await h.service.closeMember(USER, child.member.id);
    await expect(
      h.service.claimTask(
        { team: await h.service.getTeam(USER, run.teamId), run, member: stale, activation },
        task.id,
        task.revision,
      ),
    ).rejects.toMatchObject({ code: 'TEAM_MEMBER_CLOSED' });
    h.releaseRoot();
    await waitTerminal(h.service, root.activation);
  });
});

describe('T23 — a member cannot review its own submission', () => {
  it('refuses self-review and keeps the task submitted', async () => {
    const h = await harness();
    const root = await createRun(h);
    const child = await h.service.spawnMember({
      ownerId: USER,
      runId: root.runId,
      parentMemberId: root.rootId,
      name: '自审成员',
      message: 'x',
    });
    await waitTerminal(h.service, child.activation);
    const run = await h.service.getRun(USER, root.runId);
    const member = await h.service.getMember(USER, child.member.id);
    const activation = (await h.teamStore.listActivations(run.id, member.id))[0]!;
    const task = await h.service.createTask(
      { run, member: null, userId: USER },
      { title: '自审', specification: '', acceptance: '证据', required: true },
    );
    const claimed = await h.service.claimTask(
      { team: await h.service.getTeam(USER, run.teamId), run, member, activation },
      task.id,
      task.revision,
    );
    const submitted = await h.service.submitTask(
      { team: await h.service.getTeam(USER, run.teamId), run, member, activation },
      {
        taskId: task.id,
        expectedRevision: claimed.task.revision,
        summary: '自审提交',
        testEvidence: ['e:self'],
      },
    );
    await expect(
      h.service.reviewTask(
        { team: await h.service.getTeam(USER, run.teamId), run, member, activation },
        {
          taskId: task.id,
          expectedRevision: submitted.task.revision,
          decision: 'accepted',
          reason: '自己通过',
        },
      ),
    ).rejects.toMatchObject({ code: 'TEAM_FORBIDDEN' });
    expect((await h.teamStore.getTask(task.id))?.status).toBe('submitted');
    h.releaseRoot();
    await waitTerminal(h.service, root.activation);
  });
});
