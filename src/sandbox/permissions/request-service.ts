/**
 * Permission Request Service: the persisted "may I?" record.
 *
 * One request is opened per (principal, action, resource, policy version). A
 * retry of the same denied tool call finds the open request instead of creating
 * a second one, and a repeated human decision does not produce a second grant.
 * Both properties are enforced by the state machine plus a store lookup, not by
 * hoping the caller is careful.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { SandboxStore } from '../store.ts';
import type { AuditLog } from '../audit.ts';
import type {
  ApprovalScopeLevel,
  EffectivePermissionPolicy,
  HumanApprovalRecord,
  PermissionEvaluationRequest,
  PermissionRequestRecord,
  PermissionRequestStatus,
  RiskLevel,
} from './types.ts';
import { canTransitionPermissionRequest, REQUEST_STATES_REQUIRING_SWEEP } from './state.ts';

export interface RequestServiceDeps {
  readonly store: SandboxStore;
  readonly audit: AuditLog;
  readonly now?: () => Date;
  readonly requestTtlMs: number;
  readonly approvalTtlMs: number;
  readonly defaultApprovalScope?: ApprovalScopeLevel;
}

export interface OpenRequestInput {
  readonly request: PermissionEvaluationRequest;
  readonly effective: EffectivePermissionPolicy;
  readonly riskLevel: RiskLevel;
  readonly reason: string;
}

export class PermissionConflictError extends Error {
  override readonly name = 'PermissionConflictError';
}

export class PermissionRequestService {
  private readonly store: SandboxStore;
  private readonly audit: AuditLog;
  private readonly now: () => Date;
  private readonly requestTtlMs: number;
  private readonly approvalTtlMs: number;
  private readonly defaultApprovalScope: ApprovalScopeLevel;

  constructor(deps: RequestServiceDeps) {
    this.store = deps.store;
    this.audit = deps.audit;
    this.now = deps.now ?? (() => new Date());
    this.requestTtlMs = deps.requestTtlMs;
    this.approvalTtlMs = deps.approvalTtlMs;
    this.defaultApprovalScope = deps.defaultApprovalScope ?? 'once';
  }

  /** Derive the idempotency key a retry of the same ask will reproduce. */
  requestKeyOf(request: PermissionEvaluationRequest, effective: EffectivePermissionPolicy): string {
    return `pk_${createHash('sha256')
      .update(
        JSON.stringify({
          task: request.taskId,
          principal: request.principal.id,
          action: request.action.operation,
          tool: request.action.tool,
          resource: request.resource.identifier,
          policy: effective.version,
        }),
      )
      .digest('hex')}`;
  }

  async open(input: OpenRequestInput): Promise<{ request: PermissionRequestRecord; created: boolean }> {
    const key = this.requestKeyOf(input.request, input.effective);
    const existing = await this.store.findOpenPermissionRequest(key);
    if (existing) {
      const nowMs = this.now().getTime();
      const grant = existing.grantId ? await this.store.getApproval(existing.grantId) : null;
      const grantStillWorks =
        grant !== null &&
        grant.status === 'active' &&
        grant.revokedAt === null &&
        Date.parse(grant.expiresAt) > nowMs &&
        grant.policyVersion === input.effective.version &&
        !(grant.scope === 'once' && grant.usedAt);
      if (Date.parse(existing.expiresAt) > nowMs && (!existing.grantId || grantStillWorks)) {
        return { request: existing, created: false };
      }
      // Expired, or its grant is no longer usable (TTL, revocation, consumed
      // once grant, policy change). Close it so this attempt can open a fresh
      // request instead of inheriting a dead authorization.
      await this.transition(
        existing.requestId,
        ['CREATED', 'EVALUATING', 'PENDING', 'APPROVED', 'GRANT_CREATED', 'REVALIDATING'],
        'EXPIRED',
        { reason: 'request or its grant is no longer valid' },
      );
    }

    const now = this.now();
    const at = now.toISOString();
    const request: PermissionRequestRecord = {
      requestId: `preq_${randomUUID()}`,
      requestKey: key,
      organizationId: input.request.organizationId ?? 'default',
      projectId: input.request.projectId ?? 'default',
      sessionId: input.request.sessionId,
      taskId: input.request.taskId,
      sandboxId: input.request.sandboxId ?? null,
      executionId: input.request.executionId ?? null,
      mode: input.effective.mode,
      principalType: input.request.principal.type,
      principalId: input.request.principal.id,
      action: input.request.action.operation,
      toolName: input.request.action.tool,
      resourceType: input.request.resource.type,
      resourceIdentifier: input.request.resource.identifier,
      resourceScope: [...(input.request.resource.scope ?? [input.request.resource.identifier])],
      status: 'CREATED',
      reason: input.reason,
      riskLevel: input.riskLevel,
      permissionPolicyVersion: input.effective.version,
      decisionId: null,
      grantId: null,
      approvalRequestId: null,
      autoReview: null,
      expiresAt: new Date(now.getTime() + this.requestTtlMs).toISOString(),
      createdAt: at,
      updatedAt: at,
    };
    const { request: stored } = await this.store.createPermissionRequest(request);
    const evaluating = await this.transition(stored.requestId, ['CREATED'], 'EVALUATING', {
      reason: input.reason,
    });
    await this.audit.record({
      taskId: stored.taskId,
      sessionId: stored.sessionId,
      sandboxId: stored.sandboxId,
      executionId: stored.executionId,
      policyVersion: stored.permissionPolicyVersion,
      action: 'permission.request.created',
      outcome: 'allowed',
      detail: {
        request_id: stored.requestId,
        action: stored.action,
        tool: stored.toolName,
        resource: stored.resourceIdentifier,
        mode: stored.mode,
        risk: stored.riskLevel,
      },
    });
    return { request: evaluating ?? stored, created: true };
  }

  async transition(
    requestId: string,
    from: readonly PermissionRequestStatus[],
    to: PermissionRequestStatus,
    patch: {
      readonly reason?: string;
      readonly decisionId?: string | null;
      readonly grantId?: string | null;
      readonly approvalRequestId?: string | null;
      readonly autoReview?: PermissionRequestRecord['autoReview'];
      readonly riskLevel?: RiskLevel;
      readonly executionId?: string | null;
    } = {},
  ): Promise<PermissionRequestRecord | null> {
    const current = await this.store.getPermissionRequest(requestId);
    if (!current) throw new PermissionConflictError(`permission request ${requestId} does not exist`);
    if (!from.includes(current.status)) {
      throw new PermissionConflictError(
        `permission request ${requestId} is ${current.status}, not ${from.join('/')}`,
      );
    }
    if (!canTransitionPermissionRequest(current.status, to)) {
      throw new PermissionConflictError(
        `invalid permission request transition ${current.status} -> ${to}`,
      );
    }
    return this.store.updatePermissionRequest(requestId, [current.status], to, patch);
  }

  /** Open a human approval queue entry for a request. Idempotent per request. */
  async requestHumanApproval(input: {
    readonly requestId: string;
    readonly scope?: ApprovalScopeLevel;
    readonly ttlSeconds?: number;
    readonly requestedBy: string;
    readonly reason?: string;
  }): Promise<HumanApprovalRecord> {
    const request = await this.store.getPermissionRequest(input.requestId);
    if (!request) throw new PermissionConflictError(`permission request ${input.requestId} does not exist`);
    if (request.approvalRequestId) {
      const existing = await this.store.getHumanApproval(request.approvalRequestId);
      if (existing) return existing;
    }
    const now = this.now();
    const scope = input.scope ?? this.defaultApprovalScope;
    const ttlSeconds = Math.min(
      Math.max(input.ttlSeconds ?? Math.floor(this.approvalTtlMs / 1_000), 1),
      Math.floor(this.approvalTtlMs / 1_000),
    );
    const record: HumanApprovalRecord = {
      approvalRequestId: `papr_${randomUUID()}`,
      requestId: request.requestId,
      taskId: request.taskId,
      sessionId: request.sessionId,
      sandboxId: request.sandboxId,
      scope,
      status: 'PENDING',
      requestedBy: input.requestedBy,
      decidedBy: null,
      decisionReason: input.reason ?? null,
      expiresAt: new Date(now.getTime() + ttlSeconds * 1_000).toISOString(),
      decidedAt: null,
      createdAt: now.toISOString(),
    };
    const stored = await this.store.createHumanApproval(record);
    await this.transition(request.requestId, ['EVALUATING'], 'PENDING', {
      approvalRequestId: stored.approvalRequestId,
    });
    await this.audit.record({
      taskId: request.taskId,
      sessionId: request.sessionId,
      sandboxId: request.sandboxId,
      executionId: request.executionId,
      policyVersion: request.permissionPolicyVersion,
      action: 'permission.approval.required',
      outcome: 'approval_required',
      detail: {
        request_id: request.requestId,
        approval_request_id: stored.approvalRequestId,
        action: request.action,
        resource: request.resourceIdentifier,
        scope: stored.scope,
        expires_at: stored.expiresAt,
      },
    });
    return stored;
  }

  /** Cancel every pending request/approval for a task; used on destroy/cancel. */
  async cancelTask(taskId: string, reason: string): Promise<{ requests: number; approvals: number }> {
    const open = await this.store.listPermissionRequests({
      taskId,
      statuses: ['CREATED', 'EVALUATING', 'PENDING', 'APPROVED', 'GRANT_CREATED', 'REVALIDATING'],
      limit: 1_000,
    });
    let requests = 0;
    let approvals = 0;
    for (const request of open) {
      const cancelled = await this.store.updatePermissionRequest(request.requestId, [request.status], 'CANCELLED', {
        reason,
      });
      if (cancelled) requests += 1;
      if (request.approvalRequestId) {
        const decided = await this.store.decideHumanApproval(
          request.approvalRequestId,
          ['PENDING'],
          'CANCELLED',
          { decisionReason: reason, decidedAt: this.now().toISOString() },
        );
        if (decided) approvals += 1;
      }
    }
    return { requests, approvals };
  }

  /**
   * Expire requests and approvals whose TTL passed.
   *
   * This is the only way a pending human approval leaves `PENDING` without a
   * decision, and it only ever goes to `EXPIRED`. Recovery calls the same method.
   */
  async expirePending(now: Date = this.now()): Promise<{ requests: number; approvals: number }> {
    const nowIso = now.toISOString();
    const pendingApprovals = await this.store.listHumanApprovals({
      statuses: ['PENDING'],
      limit: 1_000,
    });
    let approvals = 0;
    for (const approval of pendingApprovals) {
      if (Date.parse(approval.expiresAt) > now.getTime()) continue;
      const expired = await this.store.decideHumanApproval(
        approval.approvalRequestId,
        ['PENDING'],
        'EXPIRED',
        { decisionReason: 'approval TTL elapsed', decidedAt: nowIso },
      );
      if (!expired) continue;
      approvals += 1;
      await this.audit.record({
        taskId: approval.taskId,
        sessionId: approval.sessionId,
        sandboxId: approval.sandboxId,
        action: 'permission.human_approval.expired',
        outcome: 'denied',
        detail: { approval_request_id: approval.approvalRequestId, expires_at: approval.expiresAt },
      });
      const request = await this.store.getPermissionRequest(approval.requestId);
      if (request && request.status === 'PENDING') {
        await this.store.updatePermissionRequest(request.requestId, ['PENDING'], 'EXPIRED', {
          reason: 'approval TTL elapsed',
        });
      }
    }

    const openRequests = await this.store.listPermissionRequests({
      statuses: REQUEST_STATES_REQUIRING_SWEEP,
      limit: 1_000,
    });
    let requests = 0;
    for (const request of openRequests) {
      if (Date.parse(request.expiresAt) > now.getTime()) continue;
      // A still-valid grant keeps its request from expiring: a retry that the
      // grant legitimately covers should reuse the open record, not open a new
      // one and then find the grant anyway.
      if (request.grantId) {
        const grant = await this.store.getApproval(request.grantId);
        if (
          grant &&
          grant.status === 'active' &&
          grant.revokedAt === null &&
          Date.parse(grant.expiresAt) > now.getTime()
        ) {
          continue;
        }
      }
      const expired = await this.store.updatePermissionRequest(request.requestId, [request.status], 'EXPIRED', {
        reason: 'request TTL elapsed',
      });
      if (expired) requests += 1;
    }
    return { requests, approvals };
  }

  async listForTask(taskId: string, statuses?: readonly PermissionRequestStatus[]): Promise<PermissionRequestRecord[]> {
    return this.store.listPermissionRequests({
      taskId,
      ...(statuses ? { statuses } : {}),
      limit: 500,
    });
  }

  async listApprovalsForTask(taskId: string): Promise<HumanApprovalRecord[]> {
    return this.store.listHumanApprovals({ taskId, limit: 500 });
  }
}
