/**
 * T41 — an approval card is bound to a member, activation/generation and the
 * exact request digest; a stale decision cannot approve a newer action.
 */

import { describe, expect, it } from 'vitest';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { SessionService } from '../../src/session/service.ts';
import { MemoryTeamStore } from '../../src/teams/store-memory.ts';
import { TeamService, type TeamWorkspacePort } from '../../src/teams/service.ts';
import type { TeamApprovalPort, TeamApprovalView } from '../../src/teams/approvals.ts';
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

interface Pending {
  approvalRequestId: string;
  memberId: string;
  status: 'PENDING' | 'APPROVED' | 'DENIED';
  decidedBy: string | null;
}

class FakeApprovals implements TeamApprovalPort {
  readonly pending: Pending[] = [];
  readonly decisions: Array<{ approvalRequestId: string; decision: string; reason: string }> = [];

  view(
    entry: Pending,
    input: { member: { id: string; name: string; workspaceId: string | null }; activationId: string | null; generation: number | null },
  ): TeamApprovalView {
    return {
      approvalRequestId: entry.approvalRequestId,
      requestId: 'req_' + entry.approvalRequestId,
      requestKey: 'digest:' + entry.approvalRequestId,
      memberId: input.member.id,
      memberName: input.member.name,
      activationId: input.activationId,
      generation: input.generation,
      taskId: input.member.workspaceId,
      action: 'workspace.write',
      tool: 'write_file',
      resource: '/workspace/secret.txt',
      reason: '需要写入成员工作区',
      riskLevel: 'medium',
      policyVersion: 'ppv1:test',
      scope: 'execution',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
      status: entry.status,
    };
  }

  async list(input: Parameters<TeamApprovalPort['list']>[0]): Promise<readonly TeamApprovalView[]> {
    return this.pending
      .filter((entry) => entry.status === 'PENDING' && entry.memberId === input.member.id)
      .map((entry) => this.view(entry, input));
  }

  async decide(input: Parameters<TeamApprovalPort['decide']>[0]): Promise<TeamApprovalView> {
    const entry = this.pending.find(
      (item) => item.approvalRequestId === input.approvalRequestId && item.status === 'PENDING',
    );
    if (!entry || entry.memberId !== input.member.id) {
      throw new Error('no pending approval for this member');
    }
    entry.status = input.decision === 'approved' ? 'APPROVED' : 'DENIED';
    entry.decidedBy = input.ownerId;
    this.decisions.push({
      approvalRequestId: input.approvalRequestId,
      decision: input.decision,
      reason: input.reason,
    });
    return this.view(entry, {
      member: input.member,
      activationId: null,
      generation: null,
    });
  }
}

async function setup() {
  const store = new InMemoryStore();
  const teamStore = new MemoryTeamStore();
  const sessions = new SessionService(store);
  const conversation = await sessions.create(USER, '审批', 'deepseek-flash');
  const approvals = new FakeApprovals();
  const turn: ModelTurn = async function* () {
    yield { type: 'done', output: [{ type: 'message', role: 'assistant', content: '等待。' }] };
  };
  const service = new TeamService({
    teamStore,
    store,
    sessions,
    workspace,
    ceiling: defaultTeamConfig('deepseek-flash'),
    toolPolicy: { allowWorkspaceWrites: true, allowCommands: true, maxOutputChars: 60_000 },
    resolveModelTurn: async () => turn,
    transcriptMode: 'legacy',
    approvals,
  });
  const run = await service.createRun({
    ownerId: USER,
    conversationId: conversation.id,
    requestId: 'approval-root',
    message: '审批测试',
  });
  const child = await service.spawnMember({
    ownerId: USER,
    runId: run.run.id,
    parentMemberId: run.rootMember!.id,
    name: '需要审批的成员',
    message: '待命',
  });
  return { store, teamStore, sessions, service, run, child, approvals, conversation };
}

describe('T41 — team approval binding', () => {
  it('exposes member, generation and request digest, then applies the decision once', async () => {
    const h = await setup();
    h.approvals.pending.push({
      approvalRequestId: 'appr_1',
      memberId: h.child.member.id,
      status: 'PENDING',
      decidedBy: null,
    });
    const views = await h.service.listApprovals(USER, h.run.run.id);
    expect(views).toHaveLength(1);
    const view = views[0]!;
    expect(view.memberId).toBe(h.child.member.id);
    expect(view.memberName).toBe('需要审批的成员');
    expect(view.requestKey).toBe('digest:appr_1');
    expect(view.generation).not.toBeNull();
    expect(view.activationId).not.toBeNull();
    expect(view.resource).toBe('/workspace/secret.txt');

    const snapshot = await h.service.snapshot(USER, h.run.run.id);
    expect((snapshot['approvals'] as unknown[]).length).toBe(1);

    const decided = await h.service.decideApproval({
      ownerId: USER,
      runId: h.run.run.id,
      approvalRequestId: 'appr_1',
      decision: 'approved',
      reason: '只批准本次写入',
    });
    expect(decided.status).toBe('APPROVED');
    expect(h.approvals.decisions).toEqual([
      { approvalRequestId: 'appr_1', decision: 'approved', reason: '只批准本次写入' },
    ]);
    // A second click on the same stale card cannot approve again.
    await expect(
      h.service.decideApproval({
        ownerId: USER,
        runId: h.run.run.id,
        approvalRequestId: 'appr_1',
        decision: 'approved',
        reason: '重复',
      }),
    ).rejects.toMatchObject({ code: 'TEAM_TASK_NOT_FOUND' });
  });

  it('refuses an approval from another owner', async () => {
    const h = await setup();
    h.approvals.pending.push({
      approvalRequestId: 'appr_2',
      memberId: h.child.member.id,
      status: 'PENDING',
      decidedBy: null,
    });
    const other = '00000000-0000-4000-8000-000000000002';
    await h.store.ensureUser(other);
    await expect(
      h.service.decideApproval({
        ownerId: other,
        runId: h.run.run.id,
        approvalRequestId: 'appr_2',
        decision: 'approved',
        reason: '越权',
      }),
    ).rejects.toMatchObject({ code: 'TEAM_RUN_NOT_FOUND' });
  });
});
