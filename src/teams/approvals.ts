/**
 * Team-scoped approval binding.
 *
 * The sandbox owns the approval record (action, resource, policy version,
 * expiry). This adapter only answers the Team questions:
 *
 *   - which member's workspace owns the approval;
 *   - which activation/generation was running when it was requested;
 *   - that the human decision is applied to the exact approval id, so a stale
 *     card from an older generation cannot approve a newer action.
 *
 * A member is never handed the sandbox credential or the raw request; the view
 * exposes the request digest (`requestKey`), not the parameters.
 */

import type { SandboxPlatform } from '../sandbox/index.ts';
import type { HumanApprovalRecord, PermissionRequestRecord } from '../sandbox/permissions/types.ts';
import type { Member } from './types.ts';

export interface TeamApprovalView {
  readonly approvalRequestId: string;
  readonly requestId: string;
  readonly requestKey: string;
  readonly memberId: string;
  readonly memberName: string;
  readonly activationId: string | null;
  readonly generation: number | null;
  readonly taskId: string | null;
  readonly action: string | null;
  readonly tool: string | null;
  readonly resource: string | null;
  readonly reason: string;
  readonly riskLevel: string | null;
  readonly policyVersion: string | null;
  readonly scope: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly status: string;
}

export interface TeamApprovalPort {
  list(input: {
    readonly ownerId: string;
    readonly runId: string;
    readonly member: Member;
    readonly activationId: string | null;
    readonly generation: number | null;
  }): Promise<readonly TeamApprovalView[]>;
  decide(input: {
    readonly ownerId: string;
    readonly runId: string;
    readonly member: Member;
    readonly approvalRequestId: string;
    readonly decision: 'approved' | 'denied';
    readonly reason: string;
  }): Promise<TeamApprovalView>;
}

/** Production adapter over the sandbox gateway. */
export function createSandboxApprovalPort(sandbox: SandboxPlatform): TeamApprovalPort {
  const contextFor = (ownerId: string, member: Member) => ({
    taskId: member.workspaceId as string,
    sessionId: member.internalConversationId,
    userId: ownerId,
  });

  const toView = (
    approval: HumanApprovalRecord,
    request: PermissionRequestRecord | undefined,
    member: Member,
    activationId: string | null,
    generation: number | null,
  ): TeamApprovalView => ({
    approvalRequestId: approval.approvalRequestId,
    requestId: approval.requestId,
    requestKey: request?.requestKey ?? approval.requestId,
    memberId: member.id,
    memberName: member.name,
    activationId,
    generation,
    taskId: member.workspaceId,
    action: request?.action ?? null,
    tool: request?.toolName ?? null,
    resource: request?.resourceIdentifier ?? null,
    reason: request?.reason ?? '',
    riskLevel: request?.riskLevel ?? null,
    policyVersion: request?.permissionPolicyVersion ?? null,
    scope: approval.scope,
    expiresAt: approval.expiresAt,
    createdAt: approval.createdAt,
    status: approval.status,
  });

  return {
    async list(input) {
      if (!input.member.workspaceId) return [];
      let status: Record<string, unknown>;
      try {
        status = await sandbox.gateway.permissionStatus(contextFor(input.ownerId, input.member));
      } catch {
        return [];
      }
      const requests = (status['requests'] ?? []) as readonly PermissionRequestRecord[];
      const approvals = (status['approvals'] ?? []) as readonly HumanApprovalRecord[];
      return approvals
        .filter((approval) => approval.status === 'PENDING')
        .map((approval) =>
          toView(
            approval,
            requests.find(
              (request) =>
                request.approvalRequestId === approval.approvalRequestId ||
                request.requestId === approval.requestId,
            ),
            input.member,
            input.activationId,
            input.generation,
          ),
        );
    },

    async decide(input) {
      if (!input.member.workspaceId) {
        throw new Error('member has no workspace');
      }
      const context = contextFor(input.ownerId, input.member);
      const before = await sandbox.gateway.permissionStatus(context);
      const approvals = (before['approvals'] ?? []) as readonly HumanApprovalRecord[];
      const approval = approvals.find(
        (entry) => entry.approvalRequestId === input.approvalRequestId,
      );
      if (!approval) {
        throw new Error('approval not found for this member');
      }
      const result =
        input.decision === 'approved'
          ? await sandbox.gateway.approvePermissionRequest(context, {
              approvalRequestId: input.approvalRequestId,
              decidedBy: input.ownerId,
              ...(input.reason ? { reason: input.reason } : {}),
            })
          : null;
      if (input.decision === 'denied') {
        await sandbox.gateway.denyPermissionRequest(context, {
          approvalRequestId: input.approvalRequestId,
          decidedBy: input.ownerId,
          ...(input.reason ? { reason: input.reason } : {}),
        });
      }
      const after = await sandbox.gateway.permissionStatus(context);
      const requests = (after['requests'] ?? []) as readonly PermissionRequestRecord[];
      const decided = ((after['approvals'] ?? []) as readonly HumanApprovalRecord[]).find(
        (entry) => entry.approvalRequestId === input.approvalRequestId,
      );
      if (!decided) {
        throw new Error('approval disappeared after decision');
      }
      return toView(
        result?.approval ?? decided,
        requests.find(
          (request) =>
            request.approvalRequestId === decided.approvalRequestId ||
            request.requestId === decided.requestId,
        ),
        input.member,
        null,
        null,
      );
    },
  };
}
