/**
 * T52 — mid-run steering.
 *
 * A steering instruction is a user-sourced message to the root member. While the
 * root is busy it must be delivered at the next model-step boundary (the same
 * mailbox seam as a peer message), not as a second concurrent root turn.
 */

import { describe, expect, it } from 'vitest';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { SessionService } from '../../src/session/service.ts';
import { MemoryTeamStore } from '../../src/teams/store-memory.ts';
import { TeamService, type TeamWorkspacePort } from '../../src/teams/service.ts';
import { defaultTeamConfig } from '../../src/teams/types.ts';
import type { Activation } from '../../src/teams/types.ts';
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

async function waitTerminal(service: TeamService, activation: Activation): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const current = await service.teamStore.getActivation(activation.id);
    if (current && ['succeeded', 'failed', 'interrupted', 'unknown'].includes(current.status)) return;
    if (Date.now() > deadline) throw new Error('activation stuck');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

describe('T52 — steering is delivered at a step boundary', () => {
  it('injects a user instruction before the next root request and not mid-tool-group', async () => {
    const store = new InMemoryStore();
    const teamStore = new MemoryTeamStore();
    const sessions = new SessionService(store);
    const conversation = await sessions.create(USER, 'steering', 'deepseek-flash');
    const requests: ModelTurnRequest[] = [];
    let signalFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      signalFirst = resolve;
    });
    let proceed!: () => void;
    const gate = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    const turn: ModelTurn = async function* (
      request: ModelTurnRequest,
    ): AsyncGenerator<ModelTurnEvent> {
      requests.push(request);
      if (requests.length === 1) {
        signalFirst();
        await gate;
        const output: LoopOutputItem[] = [
          { type: 'function_call', callId: 'c1', name: 'agent_list', arguments: '{}' },
        ];
        yield { type: 'done', output };
        return;
      }
      yield { type: 'done', output: [{ type: 'message', role: 'assistant', content: '已按要求调整。' }] };
    };
    const service = new TeamService({
      teamStore,
      store,
      sessions,
      workspace,
      ceiling: defaultTeamConfig('deepseek-flash'),
      toolPolicy: { allowWorkspaceWrites: false, allowCommands: false, maxOutputChars: 60_000 },
      resolveModelTurn: async () => turn,
      transcriptMode: 'durable',
    });
    const created = await service.createRun({
      ownerId: USER,
      conversationId: conversation.id,
      requestId: 'steer-root',
      message: '先做一件事',
    });
    await firstStarted;
    const steered = await service.steerRun({
      ownerId: USER,
      runId: created.run.id,
      message: '验收时先看任务 A 的证据',
    });
    expect(steered.message.state).toBe('accepted');
    proceed();
    await waitTerminal(service, created.activation!);

    expect(requests.length).toBe(2);
    expect(JSON.stringify(requests[0]!.input)).not.toContain('验收时先看任务 A 的证据');
    expect(JSON.stringify(requests[1]!.input)).toContain('验收时先看任务 A 的证据');
    const injected = requests[1]!.input.find(
      (item) =>
        item.type === 'message' &&
        JSON.stringify(item).includes('验收时先看任务 A 的证据'),
    );
    expect(injected?.type).toBe('message');
    const messages = await teamStore.listMessages(created.run.id, 0, 10);
    expect(messages.items[0]?.state).toBe('processed');
  });

  it('refuses steering on a terminal run', async () => {
    const store = new InMemoryStore();
    const teamStore = new MemoryTeamStore();
    const sessions = new SessionService(store);
    const conversation = await sessions.create(USER, 'terminal', 'deepseek-flash');
    const turn: ModelTurn = async function* () {
      yield { type: 'done', output: [{ type: 'message', role: 'assistant', content: '完成' }] };
    };
    const service = new TeamService({
      teamStore,
      store,
      sessions,
      workspace,
      ceiling: defaultTeamConfig('deepseek-flash'),
      toolPolicy: { allowWorkspaceWrites: false, allowCommands: false, maxOutputChars: 60_000 },
      resolveModelTurn: async () => turn,
      transcriptMode: 'legacy',
    });
    const created = await service.createRun({
      ownerId: USER,
      conversationId: conversation.id,
      requestId: 'terminal-root',
      message: '结束',
    });
    await waitTerminal(service, created.activation!);
    await service.stopRun(USER, created.run.id, 'test');
    await expect(
      service.steerRun({ ownerId: USER, runId: created.run.id, message: '还在吗' }),
    ).rejects.toMatchObject({ code: 'TEAM_RUN_TERMINAL' });
  });
});

describe('T24 — assigned work is queued even when the owner is busy', () => {
  it('does not drop a task because its owner is mid-activation', async () => {
    const store = new InMemoryStore();
    const teamStore = new MemoryTeamStore();
    const sessions = new SessionService(store);
    const conversation = await sessions.create(USER, 'queue', 'deepseek-flash');
    let releaseRoot!: () => void;
    const rootGate = new Promise<void>((resolve) => {
      releaseRoot = resolve;
    });
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    const rootTurn: ModelTurn = async function* () {
      await rootGate;
      yield { type: 'done', output: [{ type: 'message', role: 'assistant', content: 'ok' }] };
    };
    let childCalls = 0;
    const childTurn: ModelTurn = async function* () {
      childCalls += 1;
      if (childCalls === 1) await childGate;
      yield { type: 'done', output: [{ type: 'message', role: 'assistant', content: 'done' }] };
    };
    const service = new TeamService({
      teamStore,
      store,
      sessions,
      workspace,
      ceiling: defaultTeamConfig('deepseek-flash'),
      toolPolicy: { allowWorkspaceWrites: false, allowCommands: false, maxOutputChars: 60_000 },
      resolveModelTurn: async (member) => (member.role === 'root' ? rootTurn : childTurn),
      transcriptMode: 'legacy',
    });
    const created = await service.createRun({
      ownerId: USER,
      conversationId: conversation.id,
      requestId: 'queue-root',
      message: '排队',
    });
    const child = await service.spawnMember({
      ownerId: USER,
      runId: created.run.id,
      parentMemberId: created.rootMember!.id,
      name: '忙成员',
      message: '保持运行',
    });
    // Wait until the child is actually executing.
    let running = false;
    for (let index = 0; index < 100; index += 1) {
      const member = await teamStore.getMember(child.member.id);
      if (member?.status === 'active') {
        running = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(running).toBe(true);
    const task = await service.createTask(
      { run: await service.getRun(USER, created.run.id), member: null, userId: USER },
      {
        title: '排队任务',
        specification: '',
        acceptance: '一句证据',
        required: true,
        ownerId: child.member.id,
      },
    );
    // The task is claimed and its activation queued behind the running one.
    const claimed = await teamStore.getTask(task.id);
    expect(['running', 'submitted']).toContain(claimed?.status);
    const activations = await teamStore.listActivations(created.run.id, child.member.id);
    expect(activations.length).toBeGreaterThanOrEqual(2);
    expect(activations.some((entry) => entry.status === 'queued' || entry.input.taskId === task.id)).toBe(true);
    releaseChild();
    await waitTerminal(service, child.activation!);
    // Let the queued task activation run and settle.
    for (let index = 0; index < 200; index += 1) {
      const current = await teamStore.getTask(task.id);
      if (current?.status === 'running' || current?.status === 'submitted') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    releaseRoot();
    await waitTerminal(service, created.activation!);
  });
});
