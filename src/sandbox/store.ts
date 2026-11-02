/**
 * The persistence port for the sandbox platform.
 *
 * Separate from `Store` on purpose. The product's `Store` is memory and
 * conversation history; this is execution bookkeeping. They share one SQLite
 * file because that is operationally simpler, but nothing in the session or
 * memory layers depends on these types.
 *
 * The contract that matters for crash recovery:
 *
 *   - `createExecution` is idempotent per `(sandboxId, idempotencyKey)`;
 *   - `transitionExecution` is compare-and-set, so two concurrent paths cannot
 *     both move `RUNNING` to `SUCCEEDED`;
 *   - events are append-only and are written before the state change they
 *     describe, so there is never a terminal execution without a trail;
 *   - permission requests and approvals use the same compare-and-set shape, so
 *     two approvers cannot both create a grant and a duplicated tool call cannot
 *     open two approval queues.
 */

import type {
  ApprovalGrant,
  AuditEvent,
  Execution,
  ExecutionEvent,
  ExecutionState,
  Sandbox,
  SandboxStatus,
  Task,
  Workspace,
  WorkspaceCheckpoint,
} from './types.ts';
import type { CwdOperationRecord } from './cwd/cwd-types.ts';
import type {
  AutoReviewResultRecord,
  HumanApprovalRecord,
  HumanApprovalStatus,
  PermissionDecision,
  PermissionPolicyRecord,
  PermissionRequestRecord,
  PermissionRequestStatus,
  PermissionScopeLevel,
  RiskLevel,
} from './permissions/types.ts';

export interface ExecutionTransitionPatch {
  readonly exitCode?: number | null;
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
  readonly stdout?: string;
  readonly stderr?: string;
}

export interface CreateExecutionResult {
  readonly execution: Execution;
  /** False when the idempotency key already existed; the stored row is returned. */
  readonly created: boolean;
}

/** The compare-and-set input for a task cwd change. */
export interface TaskCwdUpdateInput {
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly cwd: string;
  readonly at: string;
  /** Committed atomically with the cwd change (transactional outbox). */
  readonly audit: AuditEvent;
}

export type TaskCwdUpdateResult =
  | { readonly updated: true; readonly task: Task }
  | {
      readonly updated: false;
      readonly reason: 'not_found' | 'not_active' | 'version_conflict';
      readonly task: Task | null;
    };

export interface PermissionRequestPatch {
  readonly reason?: string;
  readonly riskLevel?: RiskLevel;
  readonly decisionId?: string | null;
  readonly grantId?: string | null;
  readonly approvalRequestId?: string | null;
  readonly autoReview?: AutoReviewResultRecord | null;
  readonly executionId?: string | null;
}

export interface CreatePermissionRequestResult {
  readonly request: PermissionRequestRecord;
  readonly created: boolean;
}

export interface HumanApprovalPatch {
  readonly decidedBy?: string | null;
  readonly decisionReason?: string | null;
  readonly decidedAt?: string | null;
  readonly scope?: HumanApprovalRecord['scope'];
}

export interface GrantFilter {
  readonly taskId?: string;
  readonly sessionId?: string;
  readonly requestId?: string;
  readonly approvalRequestId?: string;
}

/**
 * How an operator narrows the audit trail (ADR 021 §14).
 *
 * Task, sandbox and execution are the three correlation ids the ADR asks to be
 * queryable; `action` answers "show me every cwd change" without a full scan.
 */
export interface AuditQuery {
  readonly taskId?: string;
  readonly sandboxId?: string;
  readonly executionId?: string;
  readonly action?: string;
  readonly limit?: number;
}

export interface SandboxStore {
  // ------------------------------------------------------------------ tasks ---
  /** Idempotent: an existing task is returned unchanged. */
  ensureTask(task: Task): Promise<Task>;
  getTask(taskId: string): Promise<Task | null>;
  getTaskBySession(sessionId: string): Promise<Task | null>;
  updateTask(taskId: string, patch: Partial<Pick<Task, 'status' | 'sandboxId' | 'workspaceId'>>): Promise<Task | null>;

  // ------------------------------------------------------- task cwd (ADR 021) ---
  /**
   * Fill in the cwd columns for a task that predates them, or re-point the
   * workspace root. Never moves an already-initialised cwd: initialisation is a
   * repair, not a silent reset (ADR 021 §16.1).
   */
  initializeTaskCwd(input: {
    readonly taskId: string;
    readonly workspaceRoot: string;
    readonly at: string;
  }): Promise<Task | null>;

  /**
   * Compare-and-set the task cwd, its version and the audit row describing it.
   *
   * All three happen in one database transaction. Writing the audit row outside
   * it would allow the exact failure the ADR forbids: a cwd that changed with no
   * trace, or a trace for a change that was rolled back.
   */
  compareAndSetTaskCwd(input: TaskCwdUpdateInput): Promise<TaskCwdUpdateResult>;

  /**
   * Mark the recorded cwd unusable without changing it (ADR 021 §11.3), or clear
   * the mark once a validation succeeds again (`at: null`).
   */
  setTaskCwdInvalidation(input: {
    readonly taskId: string;
    readonly reason: string | null;
    readonly at: string | null;
  }): Promise<Task | null>;

  /** Idempotency record for one `change_directory` operation (ADR 021 §13). */
  saveCwdOperation(record: CwdOperationRecord): Promise<void>;
  findCwdOperation(operationId: string): Promise<CwdOperationRecord | null>;

  // -------------------------------------------------------------- workspaces ---
  saveWorkspace(workspace: Workspace): Promise<void>;
  getWorkspace(workspaceId: string): Promise<Workspace | null>;
  getWorkspaceForTask(taskId: string): Promise<Workspace | null>;
  updateWorkspaceVersion(workspaceId: string, version: string, at: string): Promise<void>;
  deleteWorkspace(workspaceId: string): Promise<boolean>;

  saveCheckpoint(checkpoint: WorkspaceCheckpoint): Promise<void>;
  listCheckpoints(workspaceId: string): Promise<WorkspaceCheckpoint[]>;

  // --------------------------------------------------------------- sandboxes ---
  saveSandbox(sandbox: Sandbox): Promise<void>;
  getSandbox(sandboxId: string): Promise<Sandbox | null>;
  getSandboxForTask(taskId: string): Promise<Sandbox | null>;
  listSandboxes(statuses?: readonly SandboxStatus[]): Promise<Sandbox[]>;
  updateSandbox(
    sandboxId: string,
    patch: Partial<Pick<Sandbox, 'status' | 'runtimeId' | 'runtimeType' | 'lastHeartbeatAt' | 'configDigest'>>,
  ): Promise<Sandbox | null>;
  touchSandboxHeartbeat(sandboxId: string, at: string): Promise<void>;

  // -------------------------------------------------------------- executions ---
  createExecution(execution: Execution): Promise<CreateExecutionResult>;
  getExecution(executionId: string): Promise<Execution | null>;
  findExecutionByKey(sandboxId: string, idempotencyKey: string): Promise<Execution | null>;
  listUnfinishedExecutions(sandboxId?: string): Promise<Execution[]>;
  transitionExecution(
    executionId: string,
    from: readonly ExecutionState[],
    to: ExecutionState,
    patch?: ExecutionTransitionPatch,
  ): Promise<Execution | null>;

  appendEvent(event: ExecutionEvent): Promise<void>;
  listEvents(executionId: string): Promise<ExecutionEvent[]>;

  // --------------------------------------------------------------- approvals ---
  saveApproval(grant: ApprovalGrant): Promise<void>;
  getApproval(approvalId: string): Promise<ApprovalGrant | null>;
  listApprovals(taskId: string, now: string): Promise<ApprovalGrant[]>;
  revokeApproval(approvalId: string, at: string): Promise<boolean>;

  // ------------------------------------------------------------------ grants ---
  /**
   * Grants for a task and/or session, filtered by the store rather than the
   * caller. `now` is passed in so an "active" list is deterministic under a test
   * clock instead of depending on the wall clock inside SQLite.
   */
  listGrants(filter: GrantFilter, now: string): Promise<ApprovalGrant[]>;
  /** Consume a `once` grant. Returns false when it was already used. */
  markGrantUsed(grantId: string, at: string): Promise<boolean>;
  /** `status` is `expired` or `revoked`; revocation also sets `revoked_at`. */
  setGrantStatus(grantId: string, status: 'active' | 'revoked' | 'expired', at: string): Promise<boolean>;

  // ----------------------------------------------------- permission requests ---
  savePermissionPolicy(record: PermissionPolicyRecord): Promise<void>;
  getPermissionPolicy(
    scopeType: PermissionScopeLevel,
    scopeId: string,
    version: number,
  ): Promise<PermissionPolicyRecord | null>;
  latestPermissionPolicy(
    scopeType: PermissionScopeLevel,
    scopeId: string,
  ): Promise<PermissionPolicyRecord | null>;
  listPermissionPolicies(
    scopeType: PermissionScopeLevel,
    scopeId: string,
  ): Promise<PermissionPolicyRecord[]>;

  /** Idempotent per `requestId`; the caller handles the request-key lookup. */
  createPermissionRequest(request: PermissionRequestRecord): Promise<CreatePermissionRequestResult>;
  getPermissionRequest(requestId: string): Promise<PermissionRequestRecord | null>;
  findOpenPermissionRequest(requestKey: string): Promise<PermissionRequestRecord | null>;
  updatePermissionRequest(
    requestId: string,
    from: readonly PermissionRequestStatus[],
    to: PermissionRequestStatus,
    patch?: PermissionRequestPatch,
  ): Promise<PermissionRequestRecord | null>;
  listPermissionRequests(filter?: {
    readonly taskId?: string;
    readonly sessionId?: string;
    readonly statuses?: readonly PermissionRequestStatus[];
    readonly limit?: number;
  }): Promise<PermissionRequestRecord[]>;

  // -------------------------------------------------------- human approvals ---
  createHumanApproval(record: HumanApprovalRecord): Promise<HumanApprovalRecord>;
  getHumanApproval(approvalRequestId: string): Promise<HumanApprovalRecord | null>;
  listHumanApprovals(filter?: {
    readonly taskId?: string;
    readonly requestId?: string;
    readonly statuses?: readonly HumanApprovalStatus[];
    readonly limit?: number;
  }): Promise<HumanApprovalRecord[]>;
  decideHumanApproval(
    approvalRequestId: string,
    from: readonly HumanApprovalStatus[],
    to: HumanApprovalStatus,
    patch?: HumanApprovalPatch,
  ): Promise<HumanApprovalRecord | null>;

  // --------------------------------------------------- permission decisions ---
  savePermissionDecision(decision: PermissionDecision): Promise<void>;
  getPermissionDecision(decisionId: string): Promise<PermissionDecision | null>;

  // ---------------------------------------------------------------- policies ---
  savePolicy(version: string, scope: string, configuration: unknown, at: string): Promise<void>;
  getPolicy(version: string): Promise<unknown | null>;

  // ------------------------------------------------------------------- audit ---
  appendAudit(event: AuditEvent): Promise<void>;
  /** A number keeps the old "latest N" behaviour; a filter narrows by id. */
  listAudit(query?: number | AuditQuery): Promise<AuditEvent[]>;
}
