/**
 * T46 — usage settlement does not double-count cache and never treats missing
 * usage or price as free.
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
  const conversation = await sessions.create(USER, '预算', 'deepseek-flash');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const turn: ModelTurn = async function* () {
    await gate;
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
    requestId: 'budget-root',
    message: '预算',
  });
  return { service, teamStore, run, release };
}

describe('T46 — usage settlement and unknown states', () => {
  it('uses reported input once, keeps missing usage conservative, and exposes entries', async () => {
    const h = await setup();
    const first = await h.service.authorizeModelCall({
      runId: h.run.run.id,
      memberId: h.run.rootMember!.id,
      activationId: 'a1',
      generation: 1,
      requestKey: 'k1',
      estimatedInputTokens: 100,
      maxOutputTokens: 100,
    });
    await first.settle({
      inputTokens: 100,
      outputTokens: 10,
      totalTokens: 110,
      cachedTokens: 40,
      reported: true,
      cacheReported: true,
    });
    const second = await h.service.authorizeModelCall({
      runId: h.run.run.id,
      memberId: h.run.rootMember!.id,
      activationId: 'a1',
      generation: 1,
      requestKey: 'k2',
      estimatedInputTokens: 100,
      maxOutputTokens: 100,
    });
    await second.settle(undefined);

    const snapshot = await h.teamStore.budgetSnapshot(h.run.run.id);
    // Cache is part of input, not an additional amount.
    expect(snapshot.settledInputTokens).toBe(100);
    expect(snapshot.settledOutputTokens).toBe(10);
    expect(snapshot.incompleteEntries).toBe(1);
    // The incomplete reservation is still counted against the request limit.
    expect(snapshot.settledRequests + snapshot.reservedRequests).toBe(2);
    const entries = await h.teamStore.listBudgetEntries(h.run.run.id);
    expect(entries).toHaveLength(2);
    expect(entries.some((entry) => entry.status === 'incomplete')).toBe(true);
    expect(entries.find((entry) => entry.status === 'settled')?.cachedTokens).toBe(40);
    // No price configured: cost stays unknown/null, never a fabricated zero bill.
    expect(entries.every((entry) => entry.priceVersion === null)).toBe(true);
    expect(entries.every((entry) => entry.estimatedCostUsd === null)).toBe(true);
    h.release();
  });
});
