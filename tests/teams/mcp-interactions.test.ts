/**
 * T42 — Team binding for MCP approvals/elicitations.
 *
 * The member owns the MCP conversation, but the Team owner decides. The Team
 * view must expose the pending interaction with its member, and a decision must
 * be applied to that exact interaction once.
 */

import { describe, expect, it } from 'vitest';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { SessionService } from '../../src/session/service.ts';
import { MemoryTeamStore } from '../../src/teams/store-memory.ts';
import { TeamService, type TeamWorkspacePort } from '../../src/teams/service.ts';
import { defaultTeamConfig } from '../../src/teams/types.ts';
import type { McpService } from '../../src/mcp/service.ts';
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
  async session() { return null; },
  async diff() { return { files: [], sourceVersion: 'sha256:empty', candidateHash: 'sha256:empty' }; },
  async currentHashes() { return {}; },
};

class FakeMcp {
  pending: Array<Record<string, unknown>> = [];
  decisions: Array<{ id: string; action: string; response: unknown }> = [];
  conversationId: string | null = null;

  async listInteractions(_userId: string, conversationId: string): Promise<Array<Record<string, unknown>>> {
    if (conversationId !== this.conversationId) return [];
    return this.pending.filter((entry) => entry['status'] === 'pending');
  }

  async resolveInteraction(input: {
    userId: string;
    interactionId: string;
    action: string;
    response?: unknown;
  }): Promise<Record<string, unknown>> {
    const entry = this.pending.find((item) => item['id'] === input.interactionId);
    if (!entry) throw new Error('not found');
    entry['status'] = input.action === 'accept' ? 'accepted' : 'rejected';
    this.decisions.push({
      id: input.interactionId,
      action: input.action,
      response: input.response,
    });
    return entry;
  }

  tasks: Array<Record<string, unknown>> = [];
  async listTasks(_userId: string, conversationId: string): Promise<Array<Record<string, unknown>>> {
    if (conversationId !== this.conversationId) return [];
    return this.tasks;
  }

  async cancelTask(_userId: string, taskId: string): Promise<Record<string, unknown>> {
    const task = this.tasks.find((entry) => entry['id'] === taskId);
    if (!task) throw new Error('not found');
    task['status'] = 'cancelled';
    return task;
  }

  async releaseBrowser(): Promise<void> { /* No containers in this protocol fixture. */ }

  async toolsForTurn(): Promise<{
    tools: [];
    guidelines: string;
    catalogs: [];
    diagnostics: [];
  }> {
    return { tools: [], guidelines: '', catalogs: [], diagnostics: [] };
  }

  permissionPort(): never {
    throw new Error('not used');
  }
}

async function setup() {
  const store = new InMemoryStore();
  const teamStore = new MemoryTeamStore();
  const sessions = new SessionService(store);
  const conversation = await sessions.create(USER, 'mcp-team', 'deepseek-flash');
  const fake = new FakeMcp();
  const turn: ModelTurn = async function* () {
    yield { type: 'done', output: [{ type: 'message', role: 'assistant', content: '等待。' }] };
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
    mcp: fake as unknown as McpService,
  });
  const run = await service.createRun({
    ownerId: USER,
    conversationId: conversation.id,
    requestId: 'mcp-root',
    message: 'MCP',
  });
  const child = await service.spawnMember({
    ownerId: USER,
    runId: run.run.id,
    parentMemberId: run.rootMember!.id,
    name: 'MCP 成员',
    message: '待命',
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  fake.conversationId = child.member.internalConversationId;
  fake.pending = [
    {
      id: '11111111-1111-4111-8111-111111111111',
      kind: 'approval',
      status: 'pending',
      summary: 'Playwright · browser_navigate',
      payload: { tool: 'browser_navigate', argumentsDigest: 'sha256:abc' },
      conversationId: child.member.internalConversationId,
    },
  ];
  return { service, run, child, fake };
}

describe('T42 — Team-scoped MCP interactions', () => {
  it('lists a member interaction and applies one decision', async () => {
    const h = await setup();
    const list = await h.service.listMcpInteractions(USER, h.run.run.id);
    expect(list).toHaveLength(1);
    expect(list[0]?.memberId).toBe(h.child.member.id);
    expect(list[0]?.summary).toContain('browser_navigate');

    const snapshot = await h.service.snapshot(USER, h.run.run.id);
    expect((snapshot['mcpInteractions'] as unknown[]).length).toBe(1);

    const decided = await h.service.decideMcpInteraction({
      ownerId: USER,
      runId: h.run.run.id,
      interactionId: '11111111-1111-4111-8111-111111111111',
      action: 'accept',
      response: { approve: true },
    });
    expect(decided?.['status']).toBe('accepted');
    expect(h.fake.decisions).toEqual([
      {
        id: '11111111-1111-4111-8111-111111111111',
        action: 'accept',
        response: { approve: true },
      },
    ]);
    // Already accepted: a second card cannot decide it again.
    await expect(
      h.service.decideMcpInteraction({
        ownerId: USER,
        runId: h.run.run.id,
        interactionId: '11111111-1111-4111-8111-111111111111',
        action: 'accept',
      }),
    ).rejects.toMatchObject({ code: 'TEAM_TASK_NOT_FOUND' });
  });

  it('binds elicitation responses and remote MCP task cancellation', async () => {
    const h = await setup();
    h.fake.pending = [
      {
        id: '22222222-2222-4222-8222-222222222222',
        kind: 'elicitation',
        status: 'pending',
        summary: '需要确认部署环境',
        payload: { question: '选择目标环境' },
        conversationId: h.child.member.internalConversationId,
      },
    ];
    const list = await h.service.listMcpInteractions(USER, h.run.run.id);
    expect(list[0]?.kind).toBe('elicitation');
    await h.service.decideMcpInteraction({
      ownerId: USER,
      runId: h.run.run.id,
      interactionId: '22222222-2222-4222-8222-222222222222',
      action: 'accept',
      response: { answer: 'staging' },
    });
    expect(h.fake.decisions[0]?.response).toEqual({ answer: 'staging' });

    h.fake.tasks = [
      { id: '33333333-3333-4333-8333-333333333333', status: 'working', remoteTaskId: 'r1' },
    ];
    const tasks = await h.service.listMcpTasks(USER, h.run.run.id);
    expect(tasks).toHaveLength(1);
    const cancelled = await h.service.cancelMcpTask({
      ownerId: USER,
      runId: h.run.run.id,
      taskId: '33333333-3333-4333-8333-333333333333',
    });
    expect(cancelled['status']).toBe('cancelled');
  });

  it('refuses a decision from another owner', async () => {
    const h = await setup();
    const other = '00000000-0000-4000-8000-000000000002';
    await h.service.teamStore.listTeams(USER); // no-op; store user below
    await expect(
      h.service.decideMcpInteraction({
        ownerId: other,
        runId: h.run.run.id,
        interactionId: '11111111-1111-4111-8111-111111111111',
        action: 'accept',
      }),
    ).rejects.toMatchObject({ code: 'TEAM_RUN_NOT_FOUND' });
  });
});
