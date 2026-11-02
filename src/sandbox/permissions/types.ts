/**
 * The permission layer's vocabulary.
 *
 * ADR 020 separates two questions that the sandbox platform used to answer with
 * one switch:
 *
 *   - **what may the agent do at all?** — the structural sandbox policy
 *     (`src/sandbox/policy.ts`), enforced by the container baseline;
 *   - **what may it do *now*, under this mode, for this scope?** — this module.
 *
 * The types here are deliberately independent of the gateway, the controller and
 * the runtime. A permission decision is a value; a request is a persisted state
 * machine; a grant is a scoped, expiring, policy-versioned record. Nothing in
 * this file can start a process.
 *
 * Precedence (ADR 020 §4.2), strongest first:
 *
 *     System deny
 *       > Organization policy
 *       > Project policy
 *       > Session policy
 *       > Task policy
 *       > Execution grant
 *
 * A lower layer may narrow a higher one or *request* an extension; it can never
 * silently widen it, and no layer can lift a system denial.
 */

import type { ApprovalGrant, SandboxPolicy } from '../types.ts';

// ------------------------------------------------------------------- modes ---

export const PERMISSION_MODES = ['read-only', 'auto', 'on-request', 'restricted'] as const;

/** How much the agent may do without a fresh human decision. */
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * The mode a deployment uses when no narrower scope says otherwise.
 *
 * `auto` is the developer default from ADR 020 §3.3: ordinary workspace work runs
 * without interruption, and anything that needs more goes through auto-review.
 */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'auto';

// ----------------------------------------------------------------- actions ---

/** The operations a tool call can be reduced to for a permission decision. */
export const PERMISSION_ACTIONS = [
  'fs.read',
  'fs.list',
  'fs.write',
  'process.exec',
  'network.connect',
  'tool',
] as const;

export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

export function isPermissionAction(value: string): value is PermissionAction {
  return (PERMISSION_ACTIONS as readonly string[]).includes(value);
}

// ------------------------------------------------------------------- scope ---

/** Where a policy or a grant applies. Broader scopes are resolved first. */
export const PERMISSION_SCOPE_LEVELS = [
  'organization',
  'project',
  'session',
  'task',
  'sandbox',
] as const;

export type PermissionScopeLevel = (typeof PERMISSION_SCOPE_LEVELS)[number];

/** How long a human approval lasts. Persistent grants are opt-in only. */
export type ApprovalScopeLevel = 'once' | 'task' | 'session';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export const RISK_LEVELS: readonly RiskLevel[] = ['low', 'medium', 'high', 'critical'];

export interface PermissionPrincipal {
  readonly type: 'agent' | 'user' | 'system';
  readonly id: string;
}

export interface PermissionResource {
  /** `path`, `domain`, `tool` or `command`; a label for auditing, not a parser. */
  readonly type: 'path' | 'domain' | 'tool' | 'command' | 'other';
  readonly identifier: string;
  /** The scope the operation applies to (usually the same path or domain). */
  readonly scope?: readonly string[];
}

export interface PermissionActionDescriptor {
  readonly tool: string;
  readonly operation: PermissionAction;
}

export interface PermissionEvaluationRequest {
  /** Client-supplied idempotency handle; the service derives its own request key. */
  readonly requestId: string;

  readonly organizationId?: string;
  readonly projectId?: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly sandboxId?: string | null;
  readonly executionId?: string | null;

  /**
   * A *hint*, never an authority. The effective mode is resolved from the
   * control plane (deployment settings + persisted scope policies), because an
   * agent that could name its own mode would be approving itself.
   */
  readonly permissionMode?: PermissionMode;

  readonly principal: PermissionPrincipal;
  readonly action: PermissionActionDescriptor;
  readonly resource: PermissionResource;

  readonly context?: {
    readonly riskLevel?: RiskLevel;
    readonly reason?: string;
    readonly cwd?: string;
    readonly command?: string;
    /** Ignored by the rule engine; scanned only as untrusted text by auto-review. */
    readonly metadata?: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------- decisions ---

export type PermissionDecisionEffect = 'allow' | 'deny' | 'approval_required';

export type PermissionDecisionLayer =
  | 'system'
  | 'policy'
  | 'grant'
  | 'mode'
  | 'auto_review'
  | 'human_approval'
  | 'fail_closed';

export interface PermissionDecision {
  readonly effect: PermissionDecisionEffect;
  /** Stable id, persisted and copied into the execution and audit rows. */
  readonly decisionId: string;
  readonly requestId: string;
  readonly mode: PermissionMode;
  readonly permissionPolicyVersion: string;
  readonly layer: PermissionDecisionLayer;
  readonly reason: string;
  readonly resources: readonly string[];
  readonly grantId?: string;
  readonly approvalRequestId?: string;
  readonly riskLevel?: RiskLevel;
  // Correlation ids, copied here so a decision row is self-describing.
  readonly taskId?: string;
  readonly sessionId?: string;
  readonly sandboxId?: string | null;
  readonly createdAt?: string;
}

// ------------------------------------------------------------------ policy ---

export interface PermissionRule {
  readonly ruleId: string;
  readonly effect: 'allow' | 'deny' | 'approval_required';
  readonly action: readonly PermissionAction[];
  readonly resource: {
    readonly type: 'path' | 'domain' | 'tool' | 'command' | 'any';
    /** Path prefixes, domain suffixes or exact tool names. `*` matches all. */
    readonly patterns: readonly string[];
  };
  readonly conditions?: {
    readonly riskLevel?: readonly RiskLevel[];
    readonly environment?: readonly string[];
    readonly taskType?: readonly string[];
  };
}

export interface AutoReviewSettings {
  readonly enabled: boolean;
  readonly allowedRiskLevels: readonly RiskLevel[];
  readonly maxTtlMs: number;
}

export interface ApprovalSettings {
  readonly allowed: boolean;
  readonly requireHumanForRiskLevels: readonly RiskLevel[];
  readonly maxTtlMs: number;
}

/** The explicit whitelist `restricted` mode is built from (ADR 020 §3.5). */
export interface RestrictedAllowlist {
  readonly allowedTools: readonly string[];
  readonly filesystem: {
    readonly read: readonly string[];
    readonly write: readonly string[];
  };
  readonly network: {
    readonly mode: 'none' | 'proxy_only';
    readonly allowedDomains: readonly string[];
    readonly allowedPorts: readonly number[];
  };
}

/** One persisted policy layer. Stored in `permission_policies`. */
export interface PermissionPolicyRecord {
  readonly policyId: string;
  readonly scopeType: PermissionScopeLevel;
  readonly scopeId: string;
  readonly version: number;
  readonly mode: PermissionMode;
  readonly rules: readonly PermissionRule[];
  readonly autoReview: AutoReviewSettings;
  readonly approval: ApprovalSettings;
  readonly restricted: RestrictedAllowlist;
  /** Deployment ceiling for control-plane mode switches; set on the org layer. */
  readonly allowedModes?: readonly PermissionMode[];
  /** ISO timestamp; an expired scope policy falls back to its parent. */
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The resolved, intersected view the evaluator works on. */
export interface EffectivePermissionPolicy {
  readonly mode: PermissionMode;
  /**
   * The composite version string every grant and decision records.
   *
   * It changes whenever any scope's policy, mode or the deployment settings
   * change, which is what makes old grants fail revalidation (ADR 020 §12.3).
   */
  readonly version: string;
  readonly permissionVersion: number;
  readonly rules: readonly PermissionRule[];
  readonly autoReview: AutoReviewSettings;
  readonly approval: ApprovalSettings;
  readonly restricted: RestrictedAllowlist;
  /** Structural policy after mode narrowing; what the runtime is compiled from. */
  readonly sandboxPolicy: SandboxPolicy;
  readonly scopes: readonly EffectivePolicyScope[];
}

export interface EffectivePolicyScope {
  readonly scopeType: PermissionScopeLevel;
  readonly scopeId: string;
  readonly version: number;
  readonly mode: PermissionMode;
  readonly expiresAt: string | null;
}

// ---------------------------------------------------------------- requests ---

/**
 * The persisted request state machine (ADR 020 §9.1).
 *
 * `EXECUTING` means the request was authorized; the actual execution state lives
 * in `executions`. `DENIED`, `EXPIRED` and `CANCELLED` are terminal.
 */
export const PERMISSION_REQUEST_STATES = [
  'CREATED',
  'EVALUATING',
  'PENDING',
  'APPROVED',
  'GRANT_CREATED',
  'REVALIDATING',
  'EXECUTING',
  'DENIED',
  'EXPIRED',
  'CANCELLED',
] as const;

export type PermissionRequestStatus = (typeof PERMISSION_REQUEST_STATES)[number];

export interface PermissionRequestRecord {
  readonly requestId: string;
  /** Derived from actor + action + resource + policy version; makes retries idempotent. */
  readonly requestKey: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly sandboxId: string | null;
  readonly executionId: string | null;

  readonly mode: PermissionMode;
  readonly principalType: PermissionPrincipal['type'];
  readonly principalId: string;
  readonly action: PermissionAction;
  readonly toolName: string;
  readonly resourceType: PermissionResource['type'];
  readonly resourceIdentifier: string;
  readonly resourceScope: readonly string[];

  readonly status: PermissionRequestStatus;
  readonly reason: string;
  readonly riskLevel: RiskLevel;
  readonly permissionPolicyVersion: string;

  readonly decisionId: string | null;
  readonly grantId: string | null;
  readonly approvalRequestId: string | null;
  readonly autoReview: AutoReviewResultRecord | null;

  readonly expiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AutoReviewResultRecord {
  readonly result: AutoReviewDecision['result'];
  readonly reason: string;
  readonly riskLevel: RiskLevel;
}

// ----------------------------------------------------------------- approval ---

export const HUMAN_APPROVAL_STATES = [
  'PENDING',
  'APPROVED',
  'DENIED',
  'EXPIRED',
  'CANCELLED',
] as const;

export type HumanApprovalStatus = (typeof HUMAN_APPROVAL_STATES)[number];

export interface HumanApprovalRecord {
  readonly approvalRequestId: string;
  readonly requestId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly sandboxId: string | null;
  readonly scope: ApprovalScopeLevel;
  readonly status: HumanApprovalStatus;
  readonly requestedBy: string;
  readonly decidedBy: string | null;
  readonly decisionReason: string | null;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
  readonly createdAt: string;
}

// -------------------------------------------------------------- auto review ---

/**
 * What auto-review is allowed to answer (ADR 020 §6.3).
 *
 * The result is a closed union on purpose: a free-text "sounds fine to me" is
 * how an LLM ends up granting a permission in prose that nobody validates.
 */
export type AutoReviewDecision =
  | {
      readonly result: 'approve';
      readonly reason: string;
      readonly riskLevel: RiskLevel;
      readonly approvedScope: PermissionScope;
      readonly expiresAt: string;
    }
  | {
      readonly result: 'deny';
      readonly reason: string;
      readonly riskLevel: RiskLevel;
    }
  | {
      readonly result: 'escalate';
      readonly reason: string;
      readonly riskLevel: RiskLevel;
    };

export interface PermissionScope {
  readonly action: PermissionAction;
  readonly resource: string;
  readonly scope: readonly string[];
  readonly durationSeconds: number;
}

export interface AutoReviewRequest {
  readonly permissionRequestId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly taskDescription: string;
  readonly requestedPermission: PermissionScope;
  readonly currentPermissions: {
    readonly mode: PermissionMode;
    readonly permissionPolicyVersion: string;
    readonly grantIds: readonly string[];
  };
  readonly executionContext: {
    readonly toolName: string;
    readonly command?: string;
    readonly workingDirectory?: string;
    readonly networkTargets?: readonly string[];
  };
  readonly policyConstraints: {
    readonly allowedRiskLevels: readonly RiskLevel[];
    readonly maxTtlSeconds: number;
    readonly humanRequiredRiskLevels: readonly RiskLevel[];
    readonly restricted: boolean;
  };
  /**
   * Text that must never be treated as an instruction: the agent's reason, tool
   * output, file contents, web/MCP text. Kept in one field so a reviewer cannot
   * accidentally read it as a policy input.
   */
  readonly untrusted: readonly string[];
}

/**
 * The injectable auto-review port.
 *
 * The default implementation is deterministic (`src/sandbox/permissions/
 * auto-review.ts`); a deployment may plug in a model-backed one, but it must
 * return this union and it is still checked against policy afterwards.
 */
export interface AutoReviewer {
  review(request: AutoReviewRequest): Promise<AutoReviewDecision>;
}

// ------------------------------------------------------------------- grants ---

/**
 * A request that asks for a human decision.
 *
 * `scope` is the only thing a human may choose; it can make a grant narrower,
 * never wider than what was requested (ADR 020 §7.3).
 */
export interface HumanApprovalInput {
  readonly approvalRequestId?: string;
  readonly requestId: string;
  readonly scope?: ApprovalScopeLevel;
  readonly ttlSeconds?: number;
  readonly requestedBy?: string;
}

export interface ApprovalDecisionInput {
  readonly approvalRequestId: string;
  readonly decision: 'approve' | 'deny';
  readonly decidedBy: string;
  readonly scope?: ApprovalScopeLevel;
  readonly ttlSeconds?: number;
  readonly reason?: string;
}

/** ADR 020's name for `ApprovalGrant`; one persisted grant type, two names. */
export type PermissionGrant = ApprovalGrant;

// -------------------------------------------------------------------- audit ---

/** The audit actions ADR 020 §14.1 requires. */
export const PERMISSION_AUDIT_EVENTS = [
  'permission.request.created',
  'permission.decision.allow',
  'permission.decision.deny',
  'permission.approval.required',
  'permission.auto_review.started',
  'permission.auto_review.completed',
  'permission.human_approval.approved',
  'permission.human_approval.denied',
  'permission.human_approval.expired',
  'permission.grant.created',
  'permission.grant.revoked',
  'permission.grant.expired',
  'permission.mode.changed',
  'permission.policy.changed',
  'permission.execution.resumed',
  'permission.execution.blocked',
] as const;

export type PermissionAuditEvent = (typeof PERMISSION_AUDIT_EVENTS)[number];
