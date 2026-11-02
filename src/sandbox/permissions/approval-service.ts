/**
 * Human Approval Service.
 *
 * The approval object is a specific permission request, never "let the agent
 * continue". A human chooses one of:
 *
 *   - once    — the next authorized action consumes the grant;
 *   - task    — the grant lives as long as the task, bounded by a TTL;
 *   - session — the grant is bound to the session as well as the task.
 *
 * Persistent grants are not offered: the ADR makes them opt-in and this product
 * has no UI to warn a person about one.
 *
 * Two properties are load-bearing:
 *
 *   - **identity**: an agent id, an empty id or the requesting principal cannot
 *     approve. There is no cryptographic check in a local CLI, but the decision
 *     is attributed and audited, and self-approval is refused outright.
 *   - **no widening**: the chosen scope must not exceed what was requested; the
 *     grant manager additionally refuses a scope wider than the request.
 */

import type { SandboxStore } from '../store.ts';
import type { AuditLog } from '../audit.ts';
import type { ApprovalGrant } from '../types.ts';
import type {
  ApprovalDecisionInput,
  EffectivePermissionPolicy,
  HumanApprovalRecord,
  PermissionRequestRecord,
} from './types.ts';
import type { GrantManager } from './grant-manager.ts';

export interface ApprovalServiceDeps {
  readonly store: SandboxStore;
  readonly audit: AuditLog;
  readonly grants: GrantManager;
  readonly now?: () => Date;
  readonly approvalTtlMs: number;
  /** Loads the policy in force for the request; used for version revalidation. */
  readonly effectiveFor: (
    request: PermissionRequestRecord,
  ) => Promise<EffectivePermissionPolicy>;
}

export class ApprovalError extends Error {
  override readonly name = 'ApprovalError';
}

export interface ApprovalOutcome {
  readonly approval: HumanApprovalRecord;
  readonly grant: ApprovalGrant | null;
}

const AGENT_ID = /^(agent|model|assistant|system)(:|$)/i;

export class HumanApprovalService {
  private readonly store: SandboxStore;
  private readonly audit: AuditLog;
  private readonly grants: GrantManager;
  private readonly now: () => Date;
  private readonly approvalTtlMs: number;
  private readonly effectiveFor: ApprovalServiceDeps['effectiveFor'];

  constructor(deps: ApprovalServiceDeps) {
    this.store = deps.store;
    this.audit = deps.audit;
    this.grants = deps.grants;
    this.now = deps.now ?? (() => new Date());
    this.approvalTtlMs = deps.approvalTtlMs;
    this.effectiveFor = deps.effectiveFor;
  }

  async approve(input: ApprovalDecisionInput): Promise<ApprovalOutcome> {
    const approval = await this.requireApproval(input.approvalRequestId);
    const decidedBy = verifyHumanIdentity(input.decidedBy, approval);

    if (approval.status === 'APPROVED') {
      // A repeated decision is a lookup, not a second grant.
      const request = await this.store.getPermissionRequest(approval.requestId);
      const grant = request?.grantId ? await this.store.getApproval(request.grantId) : null;
      return { approval, grant };
    }
    if (approval.status !== 'PENDING') {
      throw new ApprovalError(`approval ${approval.approvalRequestId} is ${approval.status}`);
    }
    if (Date.parse(approval.expiresAt) <= this.now().getTime()) {
      await this.expire(approval, 'approval TTL elapsed');
      throw new ApprovalError('approval expired before this decision');
    }

    const request = await this.store.getPermissionRequest(approval.requestId);
    if (!request) throw new ApprovalError(`permission request ${approval.requestId} is missing`);
    if (request.status !== 'PENDING') {
      throw new ApprovalError(`permission request ${request.requestId} is ${request.status}`);
    }
    const effective = await this.effectiveFor(request);
    if (request.permissionPolicyVersion !== effective.version) {
      // Consent was requested under rules that have since changed. It cannot be
      // reused; a fresh request is the only honest path (ADR 020 §12.3).
      await this.denyRequest(request, approval, 'policy changed while the approval was pending', decidedBy);
      throw new ApprovalError('the permission policy changed while this approval was pending');
    }

    const scope = input.scope ?? approval.scope;
    const ttlSeconds = this.ttlFor(input.ttlSeconds, approval, effective);
    const decidedAt = this.now().toISOString();
    const approved = await this.store.decideHumanApproval(
      approval.approvalRequestId,
      ['PENDING'],
      'APPROVED',
      {
        decidedBy,
        decisionReason: input.reason ?? null,
        decidedAt,
        scope,
      },
    );
    if (!approved) {
      // Another approver won the compare-and-set. Return their grant if any.
      const current = await this.requireApproval(approval.approvalRequestId);
      const currentRequest = await this.store.getPermissionRequest(current.requestId);
      const grant = currentRequest?.grantId
        ? await this.store.getApproval(currentRequest.grantId)
        : null;
      return { approval: current, grant };
    }

    let grant: ApprovalGrant;
    try {
      grant = await this.grants.create({
        request: evaluateRequestOf(request),
        effective,
        source: 'human_approval',
        scope,
        ttlSeconds,
        approvedBy: decidedBy,
        requestId: request.requestId,
        approvalRequestId: approval.approvalRequestId,
        resourceScope: request.resourceScope,
      });
    } catch (error) {
      // The approval CAS already happened. Fail closed: the request is denied and
      // recovery will not invent a grant from an approved-but-grantless row.
      await this.store.updatePermissionRequest(request.requestId, ['PENDING'], 'DENIED', {
        reason: `grant creation failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      await this.audit.record({
        taskId: request.taskId,
        sessionId: request.sessionId,
        sandboxId: request.sandboxId,
        policyVersion: request.permissionPolicyVersion,
        approvalId: approval.approvalRequestId,
        action: 'permission.human_approval.denied',
        outcome: 'denied',
        detail: { reason: 'grant creation failed', error: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }

    await this.store.updatePermissionRequest(request.requestId, ['PENDING'], 'GRANT_CREATED', {
      grantId: grant.approvalId,
    });
    await this.audit.record({
      taskId: request.taskId,
      sessionId: request.sessionId,
      sandboxId: request.sandboxId,
      policyVersion: request.permissionPolicyVersion,
      approvalId: grant.approvalId,
      action: 'permission.human_approval.approved',
      outcome: 'allowed',
      detail: {
        request_id: request.requestId,
        approval_request_id: approval.approvalRequestId,
        grant_id: grant.approvalId,
        scope: scope,
        decided_by: decidedBy,
        expires_at: grant.expiresAt,
      },
    });
    return { approval: approved, grant };
  }

  async deny(input: ApprovalDecisionInput): Promise<ApprovalOutcome> {
    const approval = await this.requireApproval(input.approvalRequestId);
    const decidedBy = verifyHumanIdentity(input.decidedBy, approval);
    if (approval.status === 'DENIED') return { approval, grant: null };
    if (approval.status === 'APPROVED') {
      // Revoking is a grant operation, not a second approval decision. Denying
      // here would leave an approved row with a live grant behind it.
      throw new ApprovalError('this approval is already approved; revoke its grant instead');
    }
    if (approval.status !== 'PENDING') {
      throw new ApprovalError(`approval ${approval.approvalRequestId} is ${approval.status}`);
    }
    const request = await this.store.getPermissionRequest(approval.requestId);
    if (!request) throw new ApprovalError('permission request is missing');
    await this.denyRequest(request, approval, input.reason ?? 'denied by a human', decidedBy);
    const current = await this.requireApproval(approval.approvalRequestId);
    return { approval: current, grant: null };
  }

  async cancel(approvalRequestId: string, reason: string): Promise<HumanApprovalRecord> {
    const approval = await this.requireApproval(approvalRequestId);
    if (approval.status !== 'PENDING') return approval;
    const cancelled = await this.store.decideHumanApproval(
      approval.approvalRequestId,
      ['PENDING'],
      'CANCELLED',
      { decisionReason: reason, decidedAt: this.now().toISOString() },
    );
    const request = await this.store.getPermissionRequest(approval.requestId);
    if (request && request.status === 'PENDING') {
      await this.store.updatePermissionRequest(request.requestId, ['PENDING'], 'CANCELLED', {
        reason,
      });
    }
    return cancelled ?? approval;
  }

  private async denyRequest(
    request: PermissionRequestRecord,
    approval: HumanApprovalRecord,
    reason: string,
    decidedBy: string,
  ): Promise<void> {
    const decidedAt = this.now().toISOString();
    await this.store.decideHumanApproval(approval.approvalRequestId, ['PENDING', 'APPROVED'], 'DENIED', {
      decidedBy,
      decisionReason: reason,
      decidedAt,
    });
    const target = request.status === 'PENDING' ? 'DENIED' : request.status;
    if (target === 'DENIED') {
      await this.store.updatePermissionRequest(request.requestId, ['PENDING'], 'DENIED', { reason });
    }
    await this.audit.record({
      taskId: request.taskId,
      sessionId: request.sessionId,
      sandboxId: request.sandboxId,
      policyVersion: request.permissionPolicyVersion,
      approvalId: approval.approvalRequestId,
      action: 'permission.human_approval.denied',
      outcome: 'denied',
      detail: {
        request_id: request.requestId,
        approval_request_id: approval.approvalRequestId,
        reason,
        decided_by: decidedBy,
      },
    });
  }

  private async expire(approval: HumanApprovalRecord, reason: string): Promise<void> {
    await this.store.decideHumanApproval(approval.approvalRequestId, ['PENDING'], 'EXPIRED', {
      decisionReason: reason,
      decidedAt: this.now().toISOString(),
    });
    const request = await this.store.getPermissionRequest(approval.requestId);
    if (request && request.status === 'PENDING') {
      await this.store.updatePermissionRequest(request.requestId, ['PENDING'], 'EXPIRED', { reason });
    }
    await this.audit.record({
      taskId: approval.taskId,
      sessionId: approval.sessionId,
      sandboxId: approval.sandboxId,
      action: 'permission.human_approval.expired',
      outcome: 'denied',
      detail: { approval_request_id: approval.approvalRequestId, reason },
    });
  }

  private ttlFor(
    requested: number | undefined,
    approval: HumanApprovalRecord,
    effective: EffectivePermissionPolicy,
  ): number {
    const ceiling = Math.floor(effective.approval.maxTtlMs / 1_000);
    const remaining = Math.max(
      1,
      Math.floor((Date.parse(approval.expiresAt) - this.now().getTime()) / 1_000),
    );
    const fallback = Math.max(1, Math.floor(this.approvalTtlMs / 1_000));
    const ttl = requested ?? Math.min(fallback, remaining);
    if (ttl < 1) throw new ApprovalError('grant TTL must be positive');
    if (ttl > ceiling) {
      throw new ApprovalError(`grant TTL ${ttl}s exceeds the approval ceiling (${ceiling}s)`);
    }
    return ttl;
  }

  private async requireApproval(approvalRequestId: string): Promise<HumanApprovalRecord> {
    const approval = await this.store.getHumanApproval(approvalRequestId);
    if (!approval) throw new ApprovalError(`approval ${approvalRequestId} does not exist`);
    return approval;
  }
}

function verifyHumanIdentity(decidedBy: string, approval: HumanApprovalRecord): string {
  const value = decidedBy.trim();
  if (value.length === 0) throw new ApprovalError('an approval must name the person who decided it');
  if (AGENT_ID.test(value)) throw new ApprovalError('an agent cannot approve its own request');
  if (value === approval.requestedBy) {
    throw new ApprovalError('the requesting principal cannot approve its own request');
  }
  return value;
}

/**
 * Rebuild the evaluation request shape from a persisted request.
 *
 * The grant manager only needs the identity/action/resource fields; the original
 * context (command text) is deliberately not replayed from a database row.
 */
function evaluateRequestOf(request: PermissionRequestRecord) {
  return {
    requestId: request.requestId,
    organizationId: request.organizationId,
    projectId: request.projectId,
    sessionId: request.sessionId,
    taskId: request.taskId,
    sandboxId: request.sandboxId,
    executionId: request.executionId,
    principal: { type: request.principalType, id: request.principalId },
    action: { tool: request.toolName, operation: request.action },
    resource: {
      type: request.resourceType,
      identifier: request.resourceIdentifier,
      scope: request.resourceScope,
    },
  } as const;
}
