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
 *     describe, so there is never a terminal execution without a trail.
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

export interface SandboxStore {
  // ------------------------------------------------------------------ tasks ---
  /** Idempotent: an existing task is returned unchanged. */
  ensureTask(task: Task): Promise<Task>;
  getTask(taskId: string): Promise<Task | null>;
  getTaskBySession(sessionId: string): Promise<Task | null>;
  updateTask(taskId: string, patch: Partial<Pick<Task, 'status' | 'sandboxId' | 'workspaceId'>>): Promise<Task | null>;

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
  updateSandbox(sandboxId: string, patch: Partial<Pick<Sandbox, 'status' | 'runtimeId' | 'runtimeType' | 'lastHeartbeatAt'>>): Promise<Sandbox | null>;
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

  // ---------------------------------------------------------------- policies ---
  savePolicy(version: string, scope: string, configuration: unknown, at: string): Promise<void>;
  getPolicy(version: string): Promise<unknown | null>;

  // ------------------------------------------------------------------- audit ---
  appendAudit(event: AuditEvent): Promise<void>;
  listAudit(limit?: number): Promise<AuditEvent[]>;
}
