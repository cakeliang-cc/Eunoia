/**
 * The unified Permission Manager.
 *
 * This is the one place a tool execution asks "may I?". It composes the pieces
 * instead of re-implementing them:
 *
 *   policy resolver → rule engine → grant manager → auto-review → human approval
 *
 * The order is the security property. A system denial is checked before a grant
 * can be considered; a grant is checked before a mode's *permissive* branch; a
 * mode can tighten but never lift a structural denial; auto-review only ever runs
 * on a request the policy already decided needs *some* approval.
 *
 * Failure is closed: an unavailable store, an unreadable policy, an expired
 * grant or a permission check that throws all produce `deny` with
 * `layer: 'fail_closed'`, never an allow. The Gateway turns that into a
 * model-visible error and does not start a process.
 */

import { randomUUID } from 'node:crypto';
import type { ApprovalGrant, SandboxPolicy } from '../types.ts';
import type { SandboxStore } from '../store.ts';
import type { AuditLog, SandboxMetrics } from '../audit.ts';
import type { SandboxSettings } from '../config.ts';
import { evaluatePolicy, type PolicyRequest } from '../policy.ts';
import { WORKSPACE_MOUNT_PATH } from '../types.ts';
import type {
  ApprovalDecisionInput,
  ApprovalScopeLevel,
  AutoReviewDecision,
  AutoReviewer,
  EffectivePermissionPolicy,
  HumanApprovalRecord,
  PermissionDecision,
  PermissionEvaluationRequest,
  PermissionMode,
  PermissionPolicyRecord,
  PermissionRequestRecord,
  PermissionRequestStatus,
  PermissionScopeLevel,
  RiskLevel,
} from './types.ts';
import {
  deploymentPermissionPolicy,
  evaluatePermissionRules,
  nextScopePolicy,
  resolveEffectivePermissionPolicy,
  toolAllowedByMode,
  type ScopePolicyOverrides,
} from './policy.ts';
import { assessPermissionRequest, AutoReviewService } from './auto-review.ts';
import { GrantManager } from './grant-manager.ts';
import { PermissionRequestService } from './request-service.ts';
import { HumanApprovalService } from './approval-service.ts';

export interface PermissionManagerDeps {
  readonly store: SandboxStore;
  readonly audit: AuditLog;
  readonly metrics: SandboxMetrics;
  readonly settings: SandboxSettings;
  /** The deployment's structural policy, built from settings by the Gateway. */
  readonly deploymentPolicy: SandboxPolicy;
  readonly now?: () => Date;
  /** Injectable for a deployment that wants a model-backed risk assessor. */
  readonly autoReviewer?: AutoReviewer;
  /**
   * Called after a control-plane policy/mode change. The Gateway marks affected
   * sandboxes `INTERRUPTED` so the Controller rebuilds them under the new config.
   */
  readonly onPolicyChanged?: (input: {
    readonly scopeType: PermissionScopeLevel;
    readonly scopeId: string;
    readonly previousVersion: number;
    readonly policy: PermissionPolicyRecord;
  }) => Promise<void>;
}

export interface ApprovalFlowResult {
  readonly decision: PermissionDecision;
  readonly request?: PermissionRequestRecord;
  readonly approval?: HumanApprovalRecord;
}

export class PermissionManager {
  private readonly store: SandboxStore;
  private readonly audit: AuditLog;
  private readonly metrics: SandboxMetrics;
  private readonly settings: SandboxSettings;
  private readonly deploymentPolicy: SandboxPolicy;
  private readonly now: () => Date;
  private readonly grants: GrantManager;
  private readonly requests: PermissionRequestService;
  private readonly approvals: HumanApprovalService;
  private readonly autoReview: AutoReviewService;
  private readonly onPolicyChanged: PermissionManagerDeps['onPolicyChanged'];

  constructor(deps: PermissionManagerDeps) {
    this.store = deps.store;
    this.audit = deps.audit;
    this.metrics = deps.metrics;
    this.settings = deps.settings;
    this.deploymentPolicy = deps.deploymentPolicy;
    this.now = deps.now ?? (() => new Date());
    this.onPolicyChanged = deps.onPolicyChanged;
    this.grants = new GrantManager({ store: this.store, audit: this.audit, now: this.now });
    this.requests = new PermissionRequestService({
      store: this.store,
      audit: this.audit,
      now: this.now,
      requestTtlMs: this.settings.permission.requestTtlMs,
      approvalTtlMs: this.settings.permission.approvalTtlMs,
    });
    this.autoReview = new AutoReviewService(deps.autoReviewer);
    this.approvals = new HumanApprovalService({
      store: this.store,
      audit: this.audit,
      grants: this.grants,
      now: this.now,
      approvalTtlMs: this.settings.permission.approvalTtlMs,
      effectiveFor: (request) => this.effectivePolicyForRequest(request),
    });
  }

  // ---------------------------------------------------------------- evaluation ---

  async evaluate(request: PermissionEvaluationRequest): Promise<PermissionDecision> {
    const now = this.now();
    try {
      return await this.evaluateUnsafe(request, now);
    } catch (error) {
      this.metrics.increment('permission_fail_closed');
      const decision = this.decisionOf(request, {
        effect: 'deny',
        layer: 'fail_closed',
        reason: `permission check failed closed: ${error instanceof Error ? error.message : String(error)}`,
        mode: request.permissionMode ?? this.settings.permission.mode,
        policyVersion: 'unresolved',
        requestId: request.requestId,
      });
      await this.recordDecision(decision, null).catch(() => undefined);
      return decision;
    }
  }

  private async evaluateUnsafe(
    request: PermissionEvaluationRequest,
    now: Date,
  ): Promise<PermissionDecision> {
    const effective = await this.effectivePolicy(
      request.taskId,
      request.sessionId,
      request.sandboxId ?? null,
      now,
    );
    const structural = structuralRequestOf(request);
    const base = evaluatePolicy(effective.sandboxPolicy, structural, { now });
    const rules = evaluatePermissionRules(effective.rules, request);
    const risk = assessPermissionRequest(request, now);

    // ---- system layer: never overridable -----------------------------------
    if (base.decision === 'DENY' && base.layer === 'system') {
      return this.denyDecision(request, effective, 'system', base.reason, risk.level);
    }
    if (rules.effect === 'deny') {
      return this.denyDecision(request, effective, 'policy', rules.reason, risk.level);
    }

    const restrictedDenied =
      effective.mode === 'restricted' &&
      !toolAllowedByMode(effective.mode, effective.restricted, request.action.tool);
    const readOnlyDenied = effective.mode === 'read-only' && request.action.operation === 'fs.write';
    const baseDenied = base.decision === 'DENY';

    // ---- an existing grant, checked before any permissive branch -----------
    const grant = await this.grants.findValidGrant(request, effective);
    if (grant) {
      const expandable = !baseDenied || isGrantExpandable(effective, request, base.layer);
      // A human may widen a restricted allow-list (ADR 020 §3.5); auto-review
      // may never create such a grant in the first place.
      const humanExtension = grant.source === 'human_approval';
      if (expandable && (!restrictedDenied || humanExtension) && !readOnlyDenied) {
        // A `once` grant is consumed by the Gateway after revalidation; doing it
        // here would make the revalidation that follows see a used grant.
        return this.allow(request, effective, 'grant', `grant ${grant.approvalId} covers this request`, {
          grantId: grant.approvalId,
          riskLevel: risk.level,
        });
      }
    }

    if (readOnlyDenied) {
      return this.denyDecision(request, effective, 'mode', 'read-only mode does not permit writes', risk.level);
    }

    if (baseDenied) {
      if (!isGrantExpandable(effective, request, base.layer)) {
        return this.denyDecision(request, effective, 'policy', base.reason, risk.level);
      }
      // Restricted path/tool denials can only be extended by a human; ordinary
      // shell disablement may go through auto-review in `auto` mode.
      return this.approvalFlow(request, effective, {
        reason: base.reason,
        risk,
        humanOnly: effective.mode === 'restricted' || request.action.operation !== 'process.exec',
      });
    }

    if (restrictedDenied) {
      return this.approvalFlow(request, effective, {
        reason: `tool ${request.action.tool} is not in the restricted allow-list`,
        risk,
        humanOnly: true,
      });
    }

    if (rules.effect === 'approval_required') {
      if (effective.mode === 'read-only') {
        return this.denyDecision(
          request,
          effective,
          'mode',
          `read-only mode does not permit permission extension: ${rules.reason}`,
          risk.level,
        );
      }
      return this.approvalFlow(request, effective, {
        reason: rules.reason,
        risk,
        humanOnly: effective.mode === 'restricted',
      });
    }

    const switchApproval = this.requiresOperatorApproval(request);
    if (switchApproval) {
      if (effective.mode === 'read-only') {
        return this.denyDecision(request, effective, 'mode', switchApproval, risk.level);
      }
      return this.approvalFlow(request, effective, {
        reason: switchApproval,
        risk,
        humanOnly: false,
      });
    }

    return this.allow(request, effective, 'policy', base.reason, { riskLevel: risk.level });
  }

  /**
   * Re-check a decision immediately before execution (ADR 020 §10.2).
   *
   * The Gateway already checked sandbox ownership; this checks the permission
   * side: the grant still exists and still covers the request, and the policy
   * version has not changed since the decision was made.
   */
  async revalidate(
    decision: PermissionDecision,
    request: PermissionEvaluationRequest,
  ): Promise<PermissionDecision> {
    if (decision.effect !== 'allow') return decision;
    try {
      const effective = await this.effectivePolicy(
        request.taskId,
        request.sessionId,
        request.sandboxId ?? null,
        this.now(),
      );
      if (decision.permissionPolicyVersion !== effective.version) {
        return this.decisionOf(request, {
          effect: 'deny',
          layer: 'fail_closed',
          reason: 'the permission policy changed after this decision was made',
          mode: effective.mode,
          policyVersion: effective.version,
          requestId: decision.requestId,
        });
      }
      if (decision.grantId) {
        const validation = await this.grants.revalidate(decision.grantId, request, effective);
        if (!validation.valid) {
          return this.decisionOf(request, {
            effect: 'deny',
            layer: 'fail_closed',
            reason: `grant revalidation failed: ${validation.reason}`,
            mode: effective.mode,
            policyVersion: effective.version,
            requestId: decision.requestId,
          });
        }
      }
      return decision;
    } catch (error) {
      return this.decisionOf(request, {
        effect: 'deny',
        layer: 'fail_closed',
        reason: `permission revalidation failed closed: ${error instanceof Error ? error.message : String(error)}`,
        mode: decision.mode,
        policyVersion: decision.permissionPolicyVersion,
        requestId: decision.requestId,
      });
    }
  }

  // ---------------------------------------------------------------- policies ---

  async effectivePolicy(
    taskId: string,
    sessionId: string,
    sandboxId: string | null = null,
    now: Date = this.now(),
  ): Promise<EffectivePermissionPolicy> {
    const deployment = deploymentPermissionPolicy({
      settings: this.settings.permission,
      policy: this.deploymentPolicy,
      now,
    });
    const [session, task, sandbox] = await Promise.all([
      this.store.latestPermissionPolicy('session', sessionId),
      this.store.latestPermissionPolicy('task', taskId),
      sandboxId ? this.store.latestPermissionPolicy('sandbox', sandboxId) : Promise.resolve(null),
    ]);
    return resolveEffectivePermissionPolicy({
      deployment,
      deploymentPolicy: this.deploymentPolicy,
      scopes: { session, task, sandbox },
      now,
    });
  }

  async effectivePolicyForRequest(
    request: PermissionRequestRecord,
  ): Promise<EffectivePermissionPolicy> {
    return this.effectivePolicy(
      request.taskId,
      request.sessionId,
      request.sandboxId,
      this.now(),
    );
  }

  async currentMode(input: {
    readonly taskId: string;
    readonly sessionId: string;
    readonly sandboxId?: string | null;
  }): Promise<PermissionMode> {
    const effective = await this.effectivePolicy(
      input.taskId,
      input.sessionId,
      input.sandboxId ?? null,
    );
    return effective.mode;
  }

  /**
   * Set the mode (and optionally the restricted allow-list) for a scope.
   *
   * Only a trusted control-plane caller reaches this: the CLI, or the local UI
   * over a loopback-only, token-gated route. No tool can. The new policy version
   * invalidates grants issued under the old one, and the callback makes the
   * Gateway rebuild affected containers.
   */
  async setMode(input: {
    readonly scopeType: Exclude<PermissionScopeLevel, 'organization' | 'project'>;
    readonly scopeId: string;
    readonly mode?: PermissionMode;
    readonly overrides?: ScopePolicyOverrides;
    readonly ttlMs?: number;
    readonly actor: string;
  }): Promise<PermissionPolicyRecord> {
    const at = this.now();
    const deployment = deploymentPermissionPolicy({
      settings: this.settings.permission,
      policy: this.deploymentPolicy,
      now: at,
    });
    if (input.mode && !this.settings.permission.allowedModes.includes(input.mode)) {
      throw new PermissionPolicyError(
        `mode ${input.mode} is not allowed by the deployment (${this.settings.permission.allowedModes.join(', ')})`,
      );
    }
    const previous = await this.store.latestPermissionPolicy(input.scopeType, input.scopeId);
    const expiresAt =
      input.overrides?.expiresAt !== undefined
        ? input.overrides.expiresAt
        : input.ttlMs === undefined
          ? (previous?.expiresAt ?? null)
          : new Date(at.getTime() + Math.max(1_000, input.ttlMs)).toISOString();
    const next = nextScopePolicy({
      previous,
      deployment,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      overrides: {
        ...input.overrides,
        ...(input.mode ? { mode: input.mode } : {}),
        expiresAt,
      },
      now: at,
    });
    await this.store.savePermissionPolicy(next);
    await this.audit.record({
      taskId: input.scopeType === 'task' ? input.scopeId : null,
      sessionId: input.scopeType === 'session' ? input.scopeId : null,
      sandboxId: input.scopeType === 'sandbox' ? input.scopeId : null,
      action: 'permission.mode.changed',
      outcome: 'allowed',
      detail: {
        scope_type: input.scopeType,
        scope_id: input.scopeId,
        previous_mode: previous?.mode ?? null,
        mode: next.mode,
        previous_version: previous?.version ?? 0,
        version: next.version,
        expires_at: next.expiresAt,
        by: input.actor,
      },
    });
    await this.audit.record({
      taskId: input.scopeType === 'task' ? input.scopeId : null,
      sessionId: input.scopeType === 'session' ? input.scopeId : null,
      sandboxId: input.scopeType === 'sandbox' ? input.scopeId : null,
      action: 'permission.policy.changed',
      outcome: 'allowed',
      detail: { scope_type: input.scopeType, scope_id: input.scopeId, version: next.version },
    });
    if (this.onPolicyChanged) {
      await this.onPolicyChanged({
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        previousVersion: previous?.version ?? 0,
        policy: next,
      });
    }
    return next;
  }

  // -------------------------------------------------------- requests/approvals ---

  async approve(input: ApprovalDecisionInput): Promise<{ approval: HumanApprovalRecord; grantId: string | null }> {
    const outcome = await this.approvals.approve(input);
    this.metrics.increment('permission_human_approved');
    return { approval: outcome.approval, grantId: outcome.grant?.approvalId ?? null };
  }

  async deny(input: ApprovalDecisionInput): Promise<HumanApprovalRecord> {
    const outcome = await this.approvals.deny(input);
    this.metrics.increment('permission_human_denied');
    return outcome.approval;
  }

  async listRequests(
    taskId: string,
    statuses?: readonly PermissionRequestStatus[],
  ): Promise<PermissionRequestRecord[]> {
    return this.requests.listForTask(taskId, statuses);
  }

  async listApprovals(taskId: string): Promise<HumanApprovalRecord[]> {
    return this.requests.listApprovalsForTask(taskId);
  }

  async listGrants(taskId: string, sessionId?: string): Promise<readonly ApprovalGrant[]> {
    const now = this.now().toISOString();
    const byTask = await this.store.listGrants({ taskId }, now);
    if (!sessionId) return byTask;
    const bySession = await this.store.listGrants({ sessionId }, now);
    const seen = new Set<string>();
    return [...byTask, ...bySession].filter((grant) => {
      if (seen.has(grant.approvalId)) return false;
      seen.add(grant.approvalId);
      return true;
    });
  }

  async revokeGrant(grantId: string, actor: string, reason = 'revoked by an operator'): Promise<boolean> {
    return this.grants.revoke(grantId, reason, actor);
  }

  /**
   * The operator-facing `approve` path (CLI).
   *
   * It is a grant like any other: it names the action, the scope, the policy
   * version and an expiry, so it can be revalidated and revoked. It is never a
   * blanket "the agent may do things now".
   */
  async createOperatorGrant(input: {
    readonly taskId: string;
    readonly sessionId: string;
    readonly sandboxId?: string | null;
    readonly action: PermissionEvaluationRequest['action']['operation'];
    readonly resourceScope: readonly string[];
    readonly ttlMs: number;
    readonly approvedBy: string;
  }): Promise<ApprovalGrant> {
    const effective = await this.effectivePolicy(
      input.taskId,
      input.sessionId,
      input.sandboxId ?? null,
    );
    const request: PermissionEvaluationRequest = {
      requestId: `op_${randomUUID()}`,
      organizationId: this.settings.permission.organizationId,
      projectId: this.settings.permission.projectId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      sandboxId: input.sandboxId ?? null,
      principal: { type: 'agent', id: `agent:${input.taskId}` },
      action: {
        tool:
          input.action === 'process.exec'
            ? 'bash'
            : input.action === 'fs.write'
              ? 'write'
              : 'read',
        operation: input.action,
      },
      resource: {
        type: input.action === 'network.connect' ? 'domain' : 'path',
        identifier: input.resourceScope[0] ?? WORKSPACE_MOUNT_PATH,
        scope: [...input.resourceScope],
      },
    };
    return this.grants.create({
      request,
      effective,
      source: 'human_approval',
      scope: 'task',
      ttlSeconds: Math.max(1, Math.floor(input.ttlMs / 1_000)),
      approvedBy: input.approvedBy,
      requestId: request.requestId,
      resourceScope: input.resourceScope,
    });
  }

  /**
   * Consume a `once` grant at the authorization point.
   *
   * It happens here rather than inside `evaluate` because the Gateway must still
   * revalidate the grant first; consuming before revalidation would make the
   * revalidation see an already-used grant and fail a correct decision.
   */
  async consume(decision: PermissionDecision): Promise<boolean> {
    if (!decision.grantId) return true;
    const grant = await this.store.getApproval(decision.grantId);
    if (!grant) return false;
    return this.grants.consume(grant);
  }

  async cancelTask(taskId: string, reason: string): Promise<{ requests: number; approvals: number; grants: number }> {
    const cancelled = await this.requests.cancelTask(taskId, reason);
    const grants = await this.grants.revokeTaskGrants(taskId, reason, 'system');
    await this.audit.record({
      taskId,
      action: 'permission.execution.blocked',
      outcome: 'denied',
      detail: { reason, requests: cancelled.requests, approvals: cancelled.approvals, grants },
    });
    return { ...cancelled, grants };
  }

  /** Expire requests, approvals and grants. Safe to call repeatedly. */
  async sweep(): Promise<{
    requests: number;
    approvals: number;
    expiredGrants: number;
    staleGrants: number;
  }> {
    const pending = await this.requests.expirePending(this.now());
    const grants = await this.grants.expire({
      effectiveFor: (grant) =>
        this.effectivePolicy(grant.taskId, grant.sessionId ?? '', grant.sandboxId ?? null),
    });
    return {
      requests: pending.requests,
      approvals: pending.approvals,
      expiredGrants: grants.expired,
      staleGrants: grants.stale,
    };
  }

  /** Per-task view for the CLI and `/health`. */
  async status(input: {
    readonly taskId: string;
    readonly sessionId: string;
    readonly sandboxId?: string | null;
  }): Promise<Record<string, unknown>> {
    const effective = await this.effectivePolicy(
      input.taskId,
      input.sessionId,
      input.sandboxId ?? null,
    );
    const [requests, approvals, grants] = await Promise.all([
      this.requests.listForTask(input.taskId),
      this.requests.listApprovalsForTask(input.taskId),
      this.listGrants(input.taskId, input.sessionId),
    ]);
    return {
      mode: effective.mode,
      permission_policy_version: effective.version,
      scopes: effective.scopes,
      auto_review: effective.autoReview,
      approval: effective.approval,
      restricted: effective.restricted,
      requests,
      approvals,
      grants,
    };
  }

  // ---------------------------------------------------------------- internals ---

  private async allow(
    request: PermissionEvaluationRequest,
    effective: EffectivePermissionPolicy,
    layer: PermissionDecision['layer'],
    reason: string,
    options: { grantId?: string; riskLevel?: RiskLevel } = {},
  ): Promise<PermissionDecision> {
    const decision = this.decisionOf(request, {
      effect: 'allow',
      layer,
      reason,
      mode: effective.mode,
      policyVersion: effective.version,
      requestId: request.requestId,
      riskLevel: options.riskLevel,
      ...(options.grantId ? { grantId: options.grantId } : {}),
    });
    await this.recordDecision(decision, null);
    this.metrics.increment('permission_allowed');
    return decision;
  }

  private async denyDecision(
    request: PermissionEvaluationRequest,
    effective: EffectivePermissionPolicy,
    layer: PermissionDecision['layer'],
    reason: string,
    riskLevel: RiskLevel,
  ): Promise<PermissionDecision> {
    const decision = this.decisionOf(request, {
      effect: 'deny',
      layer,
      reason,
      mode: effective.mode,
      policyVersion: effective.version,
      requestId: request.requestId,
      riskLevel,
    });
    await this.recordDecision(decision, null);
    this.metrics.increment('permission_denied');
    await this.audit.record({
      taskId: request.taskId,
      sessionId: request.sessionId,
      sandboxId: request.sandboxId ?? null,
      policyVersion: effective.version,
      action: 'permission.execution.blocked',
      outcome: 'denied',
      detail: { action: request.action.operation, resource: request.resource.identifier, reason },
    });
    return decision;
  }

  /**
   * Approval-required branch.
   *
   * `humanOnly` is true for a restricted allow-list miss or a path extension:
   * the ADR forbids auto-review from widening a restricted policy, and a path a
   * live mount cannot honour is not something an automated reviewer may promise.
   */
  private async approvalFlow(
    request: PermissionEvaluationRequest,
    effective: EffectivePermissionPolicy,
    input: { readonly reason: string; readonly risk: ReturnType<typeof assessPermissionRequest>; readonly humanOnly: boolean },
  ): Promise<PermissionDecision> {
    const { request: permissionRequest } = await this.requests.open({
      request,
      effective,
      riskLevel: input.risk.level,
      reason: input.reason,
    });

    // A retry of the same ask found its open request. Do not run auto-review
    // again and do not create a second approval; report the state it is in.
    if (permissionRequest.status === 'PENDING') {
      const approval = permissionRequest.approvalRequestId
        ? await this.store.getHumanApproval(permissionRequest.approvalRequestId)
        : null;
      if (approval && approval.status === 'PENDING') {
        return this.decisionOf(request, {
          effect: 'approval_required',
          layer: 'human_approval',
          reason: input.reason,
          mode: effective.mode,
          policyVersion: effective.version,
          requestId: permissionRequest.requestId,
          approvalRequestId: approval.approvalRequestId,
          riskLevel: input.risk.level,
        });
      }
    }
    if (
      permissionRequest.status === 'GRANT_CREATED' ||
      permissionRequest.status === 'REVALIDATING' ||
      permissionRequest.status === 'APPROVED'
    ) {
      return this.denyDecision(
        request,
        effective,
        'grant',
        'the grant for this request is no longer valid; request it again',
        input.risk.level,
      );
    }

    const autoEligible =
      effective.mode === 'auto' &&
      effective.autoReview.enabled &&
      !input.humanOnly &&
      !input.risk.forbidden;

    if (autoEligible) {
      await this.audit.record({
        taskId: request.taskId,
        sessionId: request.sessionId,
        sandboxId: request.sandboxId ?? null,
        policyVersion: effective.version,
        action: 'permission.auto_review.started',
        outcome: 'approval_required',
        detail: {
          request_id: permissionRequest.requestId,
          action: request.action.operation,
          resource: request.resource.identifier,
          risk: input.risk.level,
        },
      });
      const outcome = await this.autoReview.review({
        request,
        effective,
        permissionRequestId: permissionRequest.requestId,
        grantIds: [],
        now: this.now(),
      });
      await this.store.updatePermissionRequest(
        permissionRequest.requestId,
        ['EVALUATING'],
        'EVALUATING',
        {
          autoReview: {
            result: outcome.decision.result,
            reason: outcome.decision.reason,
            riskLevel: outcome.riskLevel,
          },
        },
      ).catch(() => undefined);
      await this.audit.record({
        taskId: request.taskId,
        sessionId: request.sessionId,
        sandboxId: request.sandboxId ?? null,
        policyVersion: effective.version,
        action: 'permission.auto_review.completed',
        outcome: outcome.decision.result === 'approve'
          ? 'allowed'
          : outcome.decision.result === 'deny'
            ? 'denied'
            : 'approval_required',
        detail: {
          request_id: permissionRequest.requestId,
          result: outcome.decision.result,
          risk: outcome.riskLevel,
          reason: outcome.decision.reason,
        },
      });

      if (outcome.decision.result === 'approve') {
        return this.grantFromAutoReview(request, effective, permissionRequest, outcome.decision);
      }
      if (outcome.decision.result === 'deny') {
        await this.requests.transition(permissionRequest.requestId, ['EVALUATING'], 'DENIED', {
          reason: outcome.decision.reason,
          riskLevel: outcome.riskLevel,
        });
        this.metrics.increment('permission_auto_denied');
        const denied = this.decisionOf(request, {
          effect: 'deny',
          layer: 'auto_review',
          reason: outcome.decision.reason,
          mode: effective.mode,
          policyVersion: effective.version,
          requestId: permissionRequest.requestId,
          riskLevel: outcome.riskLevel,
        });
        await this.recordDecision(denied, permissionRequest);
        return denied;
      }
    }

    const approval = await this.requests.requestHumanApproval({
      requestId: permissionRequest.requestId,
      scope: 'once',
      requestedBy: request.principal.id,
      reason: input.reason,
    });
    this.metrics.increment('permission_escalated');
    const decision = this.decisionOf(request, {
      effect: 'approval_required',
      layer: 'human_approval',
      reason: input.reason,
      mode: effective.mode,
      policyVersion: effective.version,
      requestId: permissionRequest.requestId,
      approvalRequestId: approval.approvalRequestId,
      riskLevel: input.risk.level,
    });
    await this.recordDecision(decision, permissionRequest);
    return decision;
  }

  private async grantFromAutoReview(
    request: PermissionEvaluationRequest,
    effective: EffectivePermissionPolicy,
    permissionRequest: PermissionRequestRecord,
    decision: Extract<AutoReviewDecision, { result: 'approve' }>,
  ): Promise<PermissionDecision> {
    const decisionId = `dec_${randomUUID()}`;
    const grant = await this.grants.create({
      request,
      effective,
      source: 'auto_review',
      scope: 'task',
      ttlSeconds: decision.approvedScope.durationSeconds,
      approvedBy: 'auto-review',
      requestId: permissionRequest.requestId,
      resourceScope: decision.approvedScope.scope,
    });
    await this.requests.transition(permissionRequest.requestId, ['EVALUATING'], 'APPROVED', {
      decisionId,
      riskLevel: decision.riskLevel,
    });
    await this.requests.transition(permissionRequest.requestId, ['APPROVED'], 'GRANT_CREATED', {
      grantId: grant.approvalId,
    });
    const revalidating = await this.requests.transition(
      permissionRequest.requestId,
      ['GRANT_CREATED'],
      'REVALIDATING',
    );
    if (revalidating) {
      await this.requests.transition(permissionRequest.requestId, ['REVALIDATING'], 'EXECUTING');
    }
    this.metrics.increment('permission_auto_approved');
    const allowed = this.decisionOf(request, {
      effect: 'allow',
      layer: 'auto_review',
      reason: decision.reason,
      mode: effective.mode,
      policyVersion: effective.version,
      requestId: permissionRequest.requestId,
      grantId: grant.approvalId,
      riskLevel: decision.riskLevel,
    });
    await this.recordDecision(allowed, permissionRequest);
    return allowed;
  }

  private requiresOperatorApproval(request: PermissionEvaluationRequest): string | null {
    if (request.action.operation === 'fs.write' && !this.settings.allowWrites) {
      return 'workspace writes are disabled for this deployment (WORKSPACE_WRITES)';
    }
    if (request.action.operation === 'process.exec' && !this.settings.allowCommands) {
      return 'commands are disabled for this deployment (WORKSPACE_COMMANDS)';
    }
    return null;
  }

  private decisionOf(
    request: PermissionEvaluationRequest,
    input: {
      readonly effect: PermissionDecision['effect'];
      readonly layer: PermissionDecision['layer'];
      readonly reason: string;
      readonly mode: PermissionMode;
      readonly policyVersion: string;
      readonly requestId: string;
      readonly grantId?: string;
      readonly approvalRequestId?: string;
      readonly riskLevel?: RiskLevel;
    },
  ): PermissionDecision {
    return {
      effect: input.effect,
      decisionId: `dec_${randomUUID()}`,
      requestId: input.requestId,
      mode: input.mode,
      permissionPolicyVersion: input.policyVersion,
      layer: input.layer,
      reason: input.reason,
      resources: [request.resource.identifier],
      ...(input.grantId ? { grantId: input.grantId } : {}),
      ...(input.approvalRequestId ? { approvalRequestId: input.approvalRequestId } : {}),
      ...(input.riskLevel ? { riskLevel: input.riskLevel } : {}),
      taskId: request.taskId,
      sessionId: request.sessionId,
      sandboxId: request.sandboxId ?? null,
      createdAt: this.now().toISOString(),
    };
  }

  private async recordDecision(
    decision: PermissionDecision,
    permissionRequest: PermissionRequestRecord | null,
  ): Promise<void> {
    await this.store.savePermissionDecision(decision).catch(() => undefined);
    const action =
      decision.effect === 'allow'
        ? 'permission.decision.allow'
        : decision.effect === 'deny'
          ? 'permission.decision.deny'
          : 'permission.approval.required';
    await this.audit.record({
      taskId: decision.taskId ?? permissionRequest?.taskId ?? null,
      sessionId: decision.sessionId ?? permissionRequest?.sessionId ?? null,
      sandboxId: decision.sandboxId ?? permissionRequest?.sandboxId ?? null,
      policyVersion: decision.permissionPolicyVersion,
      action,
      outcome:
        decision.effect === 'allow'
          ? 'allowed'
          : decision.effect === 'deny'
            ? 'denied'
            : 'approval_required',
      detail: {
        decision_id: decision.decisionId,
        request_id: decision.requestId,
        effect: decision.effect,
        layer: decision.layer,
        mode: decision.mode,
        reason: decision.reason,
        grant_id: decision.grantId ?? null,
        approval_request_id: decision.approvalRequestId ?? null,
        risk: decision.riskLevel ?? null,
      },
    });
  }
}

export class PermissionPolicyError extends Error {
  override readonly name = 'PermissionPolicyError';
}

function structuralRequestOf(request: PermissionEvaluationRequest): PolicyRequest {
  const operation = request.action.operation;
  const cwd = request.context?.cwd;
  const resources =
    operation === 'process.exec'
      ? [cwd ?? WORKSPACE_MOUNT_PATH]
      : [request.resource.identifier];
  return {
    action: operation,
    resources,
    ...(request.action.tool ? { toolName: request.action.tool } : {}),
    ...(request.context?.command ? { command: request.context.command } : {}),
    ...(cwd ? { cwd } : {}),
  };
}

/**
 * Can a grant lift this structural denial?
 *
 * A live container cannot acquire a new mount at runtime, so "write outside the
 * workspace" and "new network domain" are not grants: they are policy changes.
 * A restricted allow-list is enforced by the permission layer on top of a mount
 * that is already writable, so a human *can* extend it within the workspace.
 */
function isGrantExpandable(
  effective: EffectivePermissionPolicy,
  request: PermissionEvaluationRequest,
  layer: string,
): boolean {
  if (layer === 'system') return false;
  const operation = request.action.operation;
  if (operation === 'process.exec') return true;
  if (
    operation === 'fs.write' ||
    operation === 'fs.read' ||
    operation === 'fs.list' ||
    operation === 'fs.chdir'
  ) {
    if (effective.mode !== 'restricted') return false;
    const identifier = request.resource.identifier;
    const insideWorkspace =
      identifier === WORKSPACE_MOUNT_PATH || identifier.startsWith(`${WORKSPACE_MOUNT_PATH}/`);
    if (!insideWorkspace) return false;
    return operation === 'fs.write'
      ? effective.sandboxPolicy.filesystem.write.length > 0
      : effective.sandboxPolicy.filesystem.read.length > 0;
  }
  return false;
}

export type { ApprovalScopeLevel };
