/**
 * Permission Recovery (ADR 020 §13).
 *
 * Recovery answers "what permission state was actually in force?" without
 * guessing, and the rules are narrower than the sandbox recovery ones:
 *
 *   - a `PENDING` approval is never restored as approved;
 *   - an `APPROVED` approval with no grant is not "probably fine": the request
 *     is denied, because nobody can prove a grant was issued;
 *   - an expired or revoked grant is not resurrected;
 *   - a grant whose policy version no longer matches is expired;
 *   - a request whose grant disappeared is denied.
 *
 * Everything here is fail-closed. The one thing recovery does *not* do is create
 * a grant a human did not decide.
 */

import type { SandboxStore } from '../store.ts';
import type { AuditLog, SandboxMetrics } from '../audit.ts';
import type { EffectivePermissionPolicy, HumanApprovalRecord } from './types.ts';
import type { GrantManager } from './grant-manager.ts';
import type { PermissionRequestService } from './request-service.ts';

export interface PermissionRecoveryDeps {
  readonly store: SandboxStore;
  readonly audit: AuditLog;
  readonly metrics: SandboxMetrics;
  readonly requests: PermissionRequestService;
  readonly grants: GrantManager;
  readonly effectiveFor: (input: {
    readonly taskId: string;
    readonly sessionId: string;
    readonly sandboxId: string | null;
  }) => Promise<EffectivePermissionPolicy>;
  readonly now?: () => Date;
}

export interface PermissionRecoveryReport {
  readonly approvalsChecked: number;
  readonly approvalsExpired: number;
  readonly requestsDenied: number;
  readonly requestsRestored: number;
  readonly grantsExpired: number;
  readonly grantsStale: number;
  readonly details: readonly string[];
}

export class PermissionRecovery {
  private readonly deps: PermissionRecoveryDeps;
  private readonly now: () => Date;

  constructor(deps: PermissionRecoveryDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  async recoverAll(): Promise<PermissionRecoveryReport> {
    const details: string[] = [];
    const expired = await this.deps.requests.expirePending(this.now());
    if (expired.approvals > 0) details.push(`expired ${expired.approvals} pending approval(s)`);
    if (expired.requests > 0) details.push(`expired ${expired.requests} pending request(s)`);

    const approvals = await this.deps.store.listHumanApprovals({
      statuses: ['PENDING', 'APPROVED'],
      limit: 1_000,
    });
    let requestsDenied = 0;
    let requestsRestored = 0;

    for (const approval of approvals) {
      const grant = await this.grantForApproval(approval);
      const request = await this.deps.store.getPermissionRequest(approval.requestId);
      if (!request) {
        details.push(`approval ${approval.approvalRequestId}: request missing`);
        continue;
      }
      if (grant) {
        // The grant is the proof that the decision was carried out. If the
        // request did not get updated before the crash, finish that bookkeeping.
        if (request.status === 'PENDING' || request.status === 'APPROVED') {
          if (request.status === 'PENDING') {
            await this.deps.store.updatePermissionRequest(
              request.requestId,
              ['PENDING'],
              'APPROVED',
              { grantId: grant.approvalId },
            );
          }
          const restored = await this.deps.store.updatePermissionRequest(
            request.requestId,
            ['APPROVED'],
            'GRANT_CREATED',
            { grantId: grant.approvalId },
          );
          if (restored) requestsRestored += 1;
        }
        if (approval.status === 'PENDING') {
          await this.deps.store.decideHumanApproval(approval.approvalRequestId, ['PENDING'], 'APPROVED', {
            decisionReason: 'recovered from a persisted grant',
            decidedAt: this.now().toISOString(),
          });
        }
        continue;
      }

      if (approval.status === 'APPROVED') {
        // An approval without a grant is not an authorization. Fail closed and
        // leave a reason an operator can read.
        const denied = await this.deps.store.updatePermissionRequest(
          request.requestId,
          ['PENDING', 'APPROVED', 'GRANT_CREATED', 'REVALIDATING'],
          'DENIED',
          { reason: 'recovery found an approved request without a grant; denied' },
        );
        if (denied) {
          requestsDenied += 1;
          details.push(`request ${request.requestId}: approved without a grant -> DENIED`);
        }
        await this.deps.audit.record({
          taskId: request.taskId,
          sessionId: request.sessionId,
          sandboxId: request.sandboxId,
          policyVersion: request.permissionPolicyVersion,
          approvalId: approval.approvalRequestId,
          action: 'permission.human_approval.denied',
          outcome: 'denied',
          detail: { reason: 'recovery: approved without grant' },
        });
      }
    }

    // A request that claims a grant but has no grant row is a lie in the
    // database; deny it rather than letting a later evaluation resurrect it.
    const claimed = await this.deps.store.listPermissionRequests({
      statuses: ['APPROVED', 'GRANT_CREATED', 'REVALIDATING'],
      limit: 1_000,
    });
    for (const request of claimed) {
      if (!request.grantId) {
        const denied = await this.deps.store.updatePermissionRequest(
          request.requestId,
          [request.status],
          'DENIED',
          { reason: 'recovery: request has no grant' },
        );
        if (denied) requestsDenied += 1;
        continue;
      }
      const grant = await this.deps.store.getApproval(request.grantId);
      if (!grant || grant.status === 'revoked' || Date.parse(grant.expiresAt) <= this.now().getTime()) {
        const denied = await this.deps.store.updatePermissionRequest(
          request.requestId,
          [request.status],
          'DENIED',
          { reason: 'recovery: the grant behind this request is not valid' },
        );
        if (denied) requestsDenied += 1;
      }
    }

    const grantSweep = await this.deps.grants.expire({
      effectiveFor: (grant) =>
        this.deps.effectiveFor({
          taskId: grant.taskId,
          sessionId: grant.sessionId ?? '',
          sandboxId: grant.sandboxId ?? null,
        }),
    });

    const report: PermissionRecoveryReport = {
      approvalsChecked: approvals.length,
      approvalsExpired: expired.approvals,
      requestsDenied,
      requestsRestored,
      grantsExpired: grantSweep.expired,
      grantsStale: grantSweep.stale,
      details,
    };
    await this.deps.audit.record({
      action: 'permission.execution.resumed',
      outcome: requestsDenied > 0 ? 'failed' : 'succeeded',
      detail: { ...report, details: undefined, phase: 'permission-recovery' },
    });
    if (requestsDenied > 0) this.deps.metrics.increment('permission_fail_closed');
    return report;
  }

  private async grantForApproval(approval: HumanApprovalRecord) {
    const grants = await this.deps.store.listGrants(
      { approvalRequestId: approval.approvalRequestId },
      this.now().toISOString(),
    );
    return grants.find((grant) => grant.status !== 'revoked') ?? null;
  }
}
