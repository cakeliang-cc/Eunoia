/**
 * T18 — crash points around mailbox injection.
 *
 * An injected-but-not-processed message must be returned to the queue when the
 * activation cannot complete a step, and must never be delivered twice.
 */

import { describe, expect, it } from 'vitest';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { SessionService } from '../../src/session/service.ts';
import { MemoryTeamStore } from '../../src/teams/store-memory.ts';
import { TeamService, type TeamWorkspacePort } from '../../src/teams/service.ts';
import { defaultTeamConfig } from '../../src/teams/types.ts';
import type { ModelTurn } from '../../src/agent/model-port.ts';

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

async function setup() {
  const store = new InMemoryStore();
  const teamStore = new MemoryTeamStore();
  const sessions = new SessionService(store);
  const conversation = await sessions.create(USER, 'mailbox', 'deepseek-flash');
  const turn: ModelTurn = async function* () {
    await new Promise<void>(() => undefined);
    yield { type: 'done', output: [] };
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
  const run = await service.createRun({
    ownerId: USER,
    conversationId: conversation.id,
    requestId: 'mailbox-root',
    message: '保持运行',
  });
  const root = (await teamStore.getMember(run.rootMember!.id))!;
  const activation = (await teamStore.listActivations(run.run.id, root.id))[0]!;
  return { store, teamStore, sessions, service, run, root, activation };
}

describe('T18 — mailbox reconciliation', () => {
  it('requeues an injected message when the step never completes, then delivers once', async () => {
    const h = await setup();
    const sent = await h.service.sendMessage({
      ownerId: USER,
      runId: h.run.run.id,
      senderId: USER,
      senderKind: 'user',
      recipientId: h.root.id,
      clientMessageId: 'crash-1',
      body: '这条消息不能丢',
    });
    expect(sent.message.state).toBe('accepted');

    const delivery = await h.service.takeMailbox(h.root, h.activation);
    expect(delivery.items).toHaveLength(1);
    const injected = (await h.teamStore.listMessages(h.run.run.id, 0, 10)).items[0]!;
    expect(injected.state).toBe('injected');
    expect(injected.activationId).toBe(h.activation.id);

    // Simulate a crash before the step recorded the injection.
    await delivery.requeue();
    const afterRequeue = (await h.teamStore.listMessages(h.run.run.id, 0, 10)).items;
    expect(afterRequeue).toHaveLength(1);
    expect(afterRequeue[0]!.state).toBe('accepted');
    expect(afterRequeue[0]!.activationId).toBeNull();

    // A retry delivers the same row exactly once and marks it processed.
    const retry = await h.service.takeMailbox(h.root, h.activation);
    expect(retry.items).toHaveLength(1);
    await retry.markProcessed();
    const processed = (await h.teamStore.listMessages(h.run.run.id, 0, 10)).items;
    expect(processed).toHaveLength(1);
    expect(processed[0]!.state).toBe('processed');
    expect((await h.service.takeMailbox(h.root, h.activation)).items).toHaveLength(0);
  });
});
