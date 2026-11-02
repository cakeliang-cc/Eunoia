/**
 * The task working-directory vocabulary (ADR 021).
 *
 * The model of the platform is:
 *
 *   **stateless execution + stateful task context + runtime-managed cwd.**
 *
 * A bash call never remembers its own directory, because every call is a new
 * process in a new container exec. What persists is the *task's* current
 * directory, owned by the runtime, versioned, and read at the moment an
 * execution is created. `cd` changes one process; `change_directory` changes the
 * task, and it is the only way to do so.
 *
 * Types here are pure values. They carry no I/O so a unit test can reason about
 * versioning, boundaries and error codes without a container or a filesystem.
 */

/** Where a task's files are mounted. The workspace root is never agent-supplied. */
export const TASK_CWD_ROOT = '/workspace';

/** The task states that permit a directory change. */
export type TaskCwdStatus = 'active' | 'paused' | 'completed' | 'cancelled';

/**
 * The durable task execution context.
 *
 * `workspaceRoot` comes from the Workspace Manager and is fixed for the life of
 * the task. `cwd` is always an absolute container path inside it. `cwdVersion`
 * increments on every successful change and is the compare-and-set token that
 * makes concurrent changes detectable instead of silently last-write-wins.
 */
export interface TaskExecutionContext {
  readonly taskId: string;
  readonly sandboxId: string | null;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly cwd: string;
  readonly cwdVersion: number;
  readonly status: TaskCwdStatus;
  /** Set when a validation pass found the recorded cwd unusable (ADR 021 §11.3). */
  readonly invalidatedAt: string | null;
  readonly invalidReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What one execution froze at creation time. Immutable for its lifetime. */
export interface ExecutionContextSnapshot {
  readonly executionId?: string;
  readonly taskId: string;
  readonly sandboxId: string;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly cwd: string;
  readonly cwdVersion: number;
  readonly policyVersion: string;
}

/** Stable error codes, reported to the model and asserted by tests. */
export type CwdErrorCode =
  | 'TASK_NOT_FOUND'
  | 'TASK_NOT_ACTIVE'
  | 'SANDBOX_NOT_FOUND'
  | 'WORKSPACE_NOT_AVAILABLE'
  | 'DIRECTORY_NOT_FOUND'
  | 'NOT_A_DIRECTORY'
  | 'PATH_OUTSIDE_WORKSPACE'
  | 'SYMLINK_ESCAPE'
  | 'PERMISSION_DENIED'
  | 'CWD_VERSION_CONFLICT'
  | 'CWD_VERSION_MISMATCH'
  | 'CWD_INVALID'
  | 'EXECUTION_CONTEXT_INVALID'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_PATH';

export class CwdError extends Error {
  override readonly name: string = 'CwdError';
  readonly code: CwdErrorCode;

  constructor(code: CwdErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** The compare-and-set lost: someone else changed the task cwd first. */
export class CwdVersionConflictError extends CwdError {
  override readonly name: string = 'CwdVersionConflictError';

  constructor(message = 'the task working directory changed since this request read it') {
    super('CWD_VERSION_CONFLICT', message);
  }
}

export interface InitializeTaskContextInput {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly sandboxId: string | null;
  readonly workspaceRoot: string;
  readonly now: string;
}

export interface UpdateTaskCwdInput {
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly newCwd: string;
  readonly now: string;
  /** Correlation for the audit trail; never a trusted path source. */
  readonly operationId?: string | null;
  readonly toolCallId?: string | null;
  readonly actorType?: 'agent' | 'user' | 'system';
  readonly actorId?: string;
}

export interface CwdResult {
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly cwdVersion: number;
}

export interface ChangeDirectoryInput {
  readonly taskId: string;
  /** Absolute container path or a path relative to the task's current cwd. */
  readonly path: string;
  /** Optional stale-read guard supplied by a caller that already read the cwd. */
  readonly expectedCwdVersion?: number;
  /** Idempotency handle; the same value with a different path is a conflict. */
  readonly operationId?: string | null;
  readonly toolCallId?: string | null;
  readonly sessionId?: string | null;
  readonly actorType?: 'agent' | 'user' | 'system';
  readonly actorId?: string;
}

export interface ChangeDirectorySuccess {
  readonly success: true;
  readonly previousCwd: string;
  readonly cwd: string;
  readonly cwdVersion: number;
  readonly workspaceRoot: string;
}

export interface ChangeDirectoryFailure {
  readonly success: false;
  readonly error: CwdErrorCode;
  readonly message: string;
}

export type ChangeDirectoryResult = ChangeDirectorySuccess | ChangeDirectoryFailure;

/** One persisted `change_directory` operation, for retry idempotency (§13). */
export interface CwdOperationRecord {
  readonly operationId: string;
  readonly taskId: string;
  readonly path: string;
  readonly result: ChangeDirectoryResult;
  readonly cwdVersion: number;
  readonly createdAt: string;
}

/** The audit shape ADR 021 §14 asks for. */
export interface CwdAuditEvent {
  readonly eventId: string;
  readonly taskId: string;
  readonly sandboxId: string | null;
  readonly operationId?: string | null;
  readonly executionId?: string | null;
  readonly previousCwd?: string;
  readonly newCwd?: string;
  readonly cwdVersion: number;
  readonly actorType: 'agent' | 'user' | 'system';
  readonly actorId: string;
  readonly result: 'success' | 'denied' | 'failed';
  readonly reason?: string;
  readonly timestamp: string;
}

/** The audit actions ADR 021 §14 requires. */
export const CWD_AUDIT_ACTIONS = [
  'task.cwd.initialized',
  'task.cwd.change.requested',
  'task.cwd.change.succeeded',
  'task.cwd.change.denied',
  'task.cwd.change.failed',
  'task.cwd.recovered',
  'task.cwd.invalidated',
  'execution.cwd.snapshot.created',
  'execution.cwd.validation.failed',
] as const;

export type CwdAuditAction = (typeof CWD_AUDIT_ACTIONS)[number];
