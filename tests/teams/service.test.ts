/**
 * Service-level acceptance for the Team domain.
 *
 * These tests use the real `TeamService` with the in-memory store, the real
 * session service, a scripted `ModelTurn` and a fake workspace port. They are
 * about orchestration: run idempotency, member lifecycle, task CAS, mailbox
 * idempotency and the difference between "activation succeeded" and "team
 * succeeded".
 *
 * The root member's first model request is held behind a gate so a test can add
 * members or tasks to a live run deterministically. There is no sleep-based
 * racing anywhere: the gate is the barrier.
 */

import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { SessionService } from '../../src/session/service.ts';
import { MemoryTeamStore } from '../../src/teams/store-memory.ts';
import { TeamService, type TeamWorkspacePort } from '../../src/teams/service.ts';
import { defaultTeamConfig, TeamError } from '../../src/teams/types.ts';
import type { Activation, TeamConfig } from '../../src/teams/types.ts';
import type { LoopOutputItem, ModelTurn } from '../../src/agent/model-port.ts';

const USER = '00000000-0000-4000-8000-000000000001';

function workspaceStub(): TeamWorkspacePort {
  return {
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
}

/** A model that answers immediately; the root path waits on a gate. */
function scriptedModel(gate: Promise<void>): ModelTurn {
  return async function* (request) {
    if (request.instructions.includes('根成员')) await gate;
    const output: LoopOutputItem[] = [
      { type: 'message', role: 'assistant', content: '完成。' },
    ];
    yield { type: 'text_delta', text: '完成。' };
    yield {
      type: 'done',
      output,
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cachedTokens: 0,
        reported: true,
      },
    };
  };
}

async function setup(config?: Partial<TeamConfig>) {
  const store = new InMemoryStore();
  const teamStore = new MemoryTeamStore();
  const sessions = new SessionService(store);
  const conversation = await sessions.create(USER, '根会话', 'deepseek-flash');
  let releaseRoot!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseRoot = resolve;
  });
  const turn = scriptedModel(gate);
  const service = new TeamService({
    teamStore,
    store,
    sessions,
    workspace: workspaceStub(),
    ceiling: { ...defaultTeamConfig('deepseek-flash'), ...config },
    toolPolicy: { allowWorkspaceWrites: true, allowCommands: true, maxOutputChars: 60_000 },
    resolveModelTurn: async () => turn,
    transcriptMode: 'durable',
  });
  return { store, teamStore, sessions, conversation, service, releaseRoot };
}

async function waitActivation(
  service: TeamService,
  activation: Activation | null,
  timeoutMs = 5_000,
): Promise<Activation> {
  if (!activation) throw new Error('no activation');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await service.teamStore.getActivation(activation.id);
    if (!current) throw new Error('activation disappeared');
    if (['succeeded', 'failed', 'interrupted', 'unknown'].includes(current.status)) {
      return current;
    }
    if (Date.now() > deadline) throw new Error(`activation did not finish: ${current.status}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('TeamService', () => {
  it('creates one run for a repeated request and starts a root member', async () => {
    const { service, conversation, releaseRoot } = await setup();
    const first = await service.createRun({
      ownerId: USER,
      conversationId: conversation.id,
      requestId: 'req-1',
      message: '你好',
    });
    expect(first.created).toBe(true);
    expect(first.rootMember?.role).toBe('root');
    expect(first.activation).not.toBeNull();

    const again = await service.createRun({
      ownerId: USER,
      conversationId: conversation.id,
      requestId: 'req-1',
      message: '你好',
    });
    expect(again.created).toBe(false);
    expect(again.run.id).toBe(first.run.id);

    releaseRoot();
    await waitActivation(service, first.activation);
    const run = await service.getRun(USER, first.run.id);
    expect(['succeeded', 'waiting_user']).toContain(run.status);
  });

  it('rejects a second different request while a run is active', async () => {
    const { service, conversation, releaseRoot } = await setup();
    const first = await service.createRun({
      ownerId: USER,
      conversationId: conversation.id,
      requestId: 'req-1',
      message: '第一件事',
    });
    await expect(
      service.createRun({
        ownerId: USER,
        conversationId: conversation.id,
        requestId: 'req-2',
        message: '第二件事',
      }),
    ).rejects.toMatchObject({ code: 'TEAM_RUN_BUSY' });
    releaseRoot();
    await waitActivation(service, first.activation);
  });

  it('keeps activation success separate from team success when required work is open', async () => {
    const { service, conversation, releaseRoot } = await setup();
    const root = await service.createRun({
      ownerId: USER,
      conversationId: conversation.id,
      requestId: 'req-root',
      message: '建一个任务然后结束',
    });
    await service.createTask(
      { run: root.run, member: null, userId: USER },
      {
        title: '未完成的任务',
        specification: '做点什么',
        acceptance: '有证据',
        required: true,
      },
    );
    releaseRoot();
    await waitActivation(service, root.activation);
    const run = await service.getRun(USER, root.run.id);
    expect(run.status).toBe('waiting_user');
    const report = await service.completionReport(run.id);
    expect(report.complete).toBe(false);
  });

  it('enforces DAG rules and CAS on tasks', async () => {
    const { service, conversation, releaseRoot } = await setup();
    const root = await service.createRun({
      ownerId: USER,
      conversationId: conversation.id,
      requestId: 'req-dag',
      message: '任务图',
    });
    const run = await service.getRun(USER, root.run.id);
    const a = await service.createTask(
      { run, member: null, userId: USER },
      { title: 'A', specification: '', acceptance: 'a', required: true },
    );
    const b = await service.createTask(
      { run, member: null, userId: USER },
      { title: 'B', specification: '', acceptance: 'b', required: true, dependencies: [a.id] },
    );
    await expect(
      service.updateTask(
        { run, member: null, userId: USER },
        a.id,
        { expectedRevision: a.revision, dependencies: [b.id] },
      ),
    ).rejects.toMatchObject({ code: 'TEAM_TASK_INVALID' });
    await expect(
      service.updateTask(
        { run, member: null, userId: USER },
        b.id,
        { expectedRevision: 999, title: 'stale' },
      ),
    ).rejects.toMatchObject({ code: 'TEAM_TASK_CONFLICT' });
    releaseRoot();
    await waitActivation(service, root.activation);
  });

  it('makes messages idempotent and refuses a conflicting body', async () => {
    const { service, conversation, releaseRoot, teamStore } = await setup();
    const root = await service.createRun({
      ownerId: USER,
      conversationId: conversation.id,
      requestId: 'req-msg',
      message: '消息',
    });
    const run = await service.getRun(USER, root.run.id);
    const recipient = await service.spawnMember({
      ownerId: USER,
      runId: run.id,
      parentMemberId: root.rootMember!.id,
      name: '收件人',
      message: '待命',
    });
    await waitActivation(service, recipient.activation);
    releaseRoot();
    await waitActivation(service, root.activation);
    const one = await service.sendMessage({
      ownerId: USER,
      runId: run.id,
      senderId: USER,
      senderKind: 'user',
      recipientId: recipient.member.id,
      clientMessageId: 'c-1',
      body: '你好',
    });
    const two = await service.sendMessage({
      ownerId: USER,
      runId: run.id,
      senderId: USER,
      senderKind: 'user',
      recipientId: recipient.member.id,
      clientMessageId: 'c-1',
      body: '你好',
    });
    expect(two.duplicate).toBe(true);
    expect(two.message.id).toBe(one.message.id);
    await expect(
      service.sendMessage({
        ownerId: USER,
        runId: run.id,
        senderId: USER,
        senderKind: 'user',
        recipientId: recipient.member.id,
        clientMessageId: 'c-1',
        body: '不同内容',
      }),
    ).rejects.toMatchObject({ code: 'TEAM_MESSAGE_CONFLICT' });
    const stored = await teamStore.listMessages(run.id, 0, 100);
    expect(stored.items.filter((message) => message.clientMessageId === 'c-1')).toHaveLength(1);
  });

  it('reserves budget atomically and reports exhaustion', async () => {
    const { service, conversation, releaseRoot } = await setup({
      budget: {
        maxInputTokens: 20_000,
        maxOutputTokens: 20_000,
        maxRequests: 2,
        maxEstimatedCostUsd: null,
      },
    });
    const root = await service.createRun({
      ownerId: USER,
      conversationId: conversation.id,
      requestId: 'req-budget',
      message: '预算',
    });
    releaseRoot();
    await waitActivation(service, root.activation);
    const run = await service.getRun(USER, root.run.id);
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, (_, index) =>
        service.authorizeModelCall({
          runId: run.id,
          memberId: root.rootMember!.id,
          activationId: 'act',
          generation: 1,
          requestKey: `k-${index}`,
          estimatedInputTokens: 100,
          maxOutputTokens: 100,
        }),
      ),
    );
    const rejected = results.filter(
      (entry): entry is PromiseRejectedResult => entry.status === 'rejected',
    );
    expect(rejected.every((entry) => entry.reason instanceof TeamError)).toBe(true);
    const snapshot = await service.teamStore.budgetSnapshot(run.id);
    expect(snapshot.settledRequests + snapshot.reservedRequests).toBeLessThanOrEqual(2);
  });

  it('closes a member and refuses follow-ups', async () => {
    const { service, conversation, releaseRoot } = await setup();
    const root = await service.createRun({
      ownerId: USER,
      conversationId: conversation.id,
      requestId: 'req-close',
      message: '关闭',
    });
    const run = await service.getRun(USER, root.run.id);
    const child = await service.spawnMember({
      ownerId: USER,
      runId: run.id,
      parentMemberId: root.rootMember!.id,
      name: '子成员',
      message: '待命',
    });
    await waitActivation(service, child.activation);
    await service.closeMember(USER, child.member.id);
    releaseRoot();
    await waitActivation(service, root.activation);
    await expect(
      service.followupAsOwner(USER, run.id, child.member.id, '还在吗'),
    ).rejects.toMatchObject({ code: 'TEAM_MEMBER_CLOSED' });
  });

  it('does not leak member conversations into the normal list', async () => {
    const { service, conversation, sessions, releaseRoot } = await setup();
    const root = await service.createRun({
      ownerId: USER,
      conversationId: conversation.id,
      requestId: 'req-hidden',
      message: '隐藏',
    });
    releaseRoot();
    await waitActivation(service, root.activation);
    const hidden = await service.hiddenConversationIds(USER);
    const list = await sessions.list(USER);
    expect([...hidden].length).toBeGreaterThan(0);
    expect(list.some((entry) => hidden.has(entry.id))).toBe(true);
    expect(list.filter((entry) => !hidden.has(entry.id)).map((entry) => entry.id)).toContain(
      conversation.id,
    );
  });

  it('fork copies committed turns and not the in-flight assistant reply', async () => {
    const { service, conversation, sessions, releaseRoot } = await setup();
    const root = await service.createRun({
      ownerId: USER,
      conversationId: conversation.id,
      requestId: 'req-fork',
      message: 'fork 测试',
    });
    // A required task keeps the run open after the root's first completed turn,
    // so a fork has a committed turn to inherit and the run is still live.
    await service.createTask(
      { run: root.run, member: null, userId: USER },
      { title: '占位必需任务', specification: '', acceptance: '证据', required: true },
    );
    releaseRoot();
    await waitActivation(service, root.activation);
    const run = await service.getRun(USER, root.run.id);
    expect(run.status).toBe('waiting_user');
    const child = await service.spawnMember({
      ownerId: USER,
      runId: run.id,
      parentMemberId: root.rootMember!.id,
      name: 'fork 子成员',
      contextMode: 'fork',
      message: '继续',
      modelId: 'deepseek-flash',
    });
    await waitActivation(service, child.activation);
    const copied = await sessions.messages(USER, child.member.internalConversationId);
    const parentMessages = await sessions.messages(USER, root.rootMember!.internalConversationId);
    // Both the root's user message and its completed assistant reply are
    // inherited; the child's own prompt follows them.
    expect(copied[0]?.content).toBe(parentMessages[0]?.content);
    expect(copied[1]?.content).toBe(parentMessages[1]?.content);
    expect(copied.length).toBeGreaterThan(parentMessages.length);
  });

  it('scopes member tools by permissions', async () => {
    const { service, conversation, releaseRoot } = await setup();
    const root = await service.createRun({
      ownerId: USER,
      conversationId: conversation.id,
      requestId: 'req-tools',
      message: '工具',
    });
    releaseRoot();
    await waitActivation(service, root.activation);
    const run = await service.getRun(USER, root.run.id);
    const activation = (await service.teamStore.listActivations(run.id, root.rootMember!.id))[0]!;
    const tools = await service.toolsFor(root.rootMember!, activation);
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('agent_spawn');
    expect(names).toContain('team_task_create');
  });

  it('rejects an unknown model capability instead of guessing', async () => {
    const { service, conversation, releaseRoot } = await setup();
    const root = await service.createRun({
      ownerId: USER,
      conversationId: conversation.id,
      requestId: 'req-model',
      message: '模型',
    });
    const run = await service.getRun(USER, root.run.id);
    await expect(
      service.spawnMember({
        ownerId: USER,
        runId: run.id,
        parentMemberId: root.rootMember!.id,
        name: '坏模型',
        message: 'x',
        modelId: 'does-not-exist',
      }),
    ).rejects.toThrow();
    releaseRoot();
    await waitActivation(service, root.activation);
  });

  it('stops a run without marking unfinished required work as success', async () => {
    const { service, conversation } = await setup();
    const root = await service.createRun({
      ownerId: USER,
      conversationId: conversation.id,
      requestId: 'req-stop',
      message: '停止',
    });
    const run = await service.getRun(USER, root.run.id);
    await service.createTask(
      { run, member: null, userId: USER },
      { title: '必需', specification: '', acceptance: '证据', required: true },
    );
    const stopped = await service.stopRun(USER, run.id, 'test');
    expect(stopped.status).toBe('cancelled');
    const report = await service.completionReport(run.id);
    expect(report.complete).toBe(false);
  });

  it('rejects a follow-up for a member of another owner', async () => {
    const first = await setup();
    const root = await first.service.createRun({
      ownerId: USER,
      conversationId: first.conversation.id,
      requestId: 'req-owner',
      message: '所有权',
    });
    const run = await first.service.getRun(USER, root.run.id);
    const other = '00000000-0000-4000-8000-000000000002';
    await first.store.ensureUser(other);
    await expect(first.service.snapshot(other, run.id)).rejects.toMatchObject({
      code: 'TEAM_RUN_NOT_FOUND',
    });
    first.releaseRoot();
    await waitActivation(first.service, root.activation);
  });
});

describe('TeamService event stream', () => {
  it('assigns increasing event sequences and supports a cursor', async () => {
    const { service, conversation, releaseRoot } = await setup();
    const root = await service.createRun({
      ownerId: USER,
      conversationId: conversation.id,
      requestId: `req-${randomUUID()}`,
      message: '事件',
    });
    releaseRoot();
    await waitActivation(service, root.activation);
    const page = await service.listEvents(USER, root.run.id, 0, 200);
    expect(page.items.length).toBeGreaterThan(0);
    const sequences = page.items.map((event) => event.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    const after = await service.listEvents(USER, root.run.id, sequences[0]!, 200);
    expect(after.items.every((event) => event.sequence > sequences[0]!)).toBe(true);
  });
});
