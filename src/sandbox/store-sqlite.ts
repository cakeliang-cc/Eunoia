/**
 * SQLite implementation of `SandboxStore`.
 *
 * It shares the `node:sqlite` connection with the product store (one file, one
 * writer) but owns its tables. Compare-and-set is a single `UPDATE … WHERE
 * status IN (…)`, which is atomic under SQLite's write lock; there is no
 * read-modify-write window between two processes or two async paths.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { StatementCache } from '../db/statements.ts';
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
import { UNFINISHED_EXECUTION_STATES } from './state.ts';
import type {
  AutoReviewResultRecord,
  HumanApprovalRecord,
  HumanApprovalStatus,
  PermissionAction,
  PermissionDecision,
  PermissionDecisionEffect,
  PermissionDecisionLayer,
  PermissionMode,
  PermissionPolicyRecord,
  PermissionRequestRecord,
  PermissionRequestStatus,
  PermissionScopeLevel,
  RiskLevel,
} from './permissions/types.ts';
import type {
  AuditQuery,
  CreateExecutionResult,
  CreatePermissionRequestResult,
  ExecutionTransitionPatch,
  GrantFilter,
  HumanApprovalPatch,
  PermissionRequestPatch,
  SandboxStore,
  TaskCwdUpdateInput,
  TaskCwdUpdateResult,
} from './store.ts';
import type { CwdOperationRecord, ChangeDirectoryResult } from './cwd/cwd-types.ts';

type SqlValue = string | number | null;

interface TaskRow {
  task_id: string;
  session_id: string;
  user_id: string;
  status: string;
  workspace_id: string;
  sandbox_id: string | null;
  workspace_root: string | null;
  current_cwd: string | null;
  cwd_version: number;
  cwd_invalidated_at: string | null;
  cwd_invalid_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface WorkspaceRow {
  workspace_id: string;
  task_id: string;
  storage_location: string;
  mode: string;
  current_version: string;
  created_at: string;
  updated_at: string;
}

interface SandboxRow {
  sandbox_id: string;
  task_id: string;
  runtime_type: string;
  runtime_id: string;
  image_digest: string;
  workspace_id: string;
  policy_version: string;
  resource_profile: string;
  config_digest: string;
  status: string;
  created_at: string;
  last_heartbeat_at: string | null;
  updated_at: string;
}

interface ExecutionRow {
  execution_id: string;
  task_id: string;
  sandbox_id: string;
  idempotency_key: string;
  command_digest: string;
  command_json: string;
  cwd: string;
  cwd_version: number;
  status: string;
  exit_code: number | null;
  started_at: string | null;
  finished_at: string | null;
  stdout: string;
  stderr: string;
  policy_version: string;
  tool_call_id: string | null;
  decision_id: string | null;
  permission_mode: string | null;
  permission_policy_version: string | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  event_id: string;
  task_id: string;
  sandbox_id: string;
  execution_id: string;
  idempotency_key: string;
  event_type: string;
  timestamp: string;
  policy_version: string;
  payload: string;
}

interface ApprovalRow {
  approval_id: string;
  task_id: string;
  action: string;
  resource_scope: string;
  expires_at: string;
  approved_by: string;
  policy_version: string;
  created_at: string;
  revoked_at: string | null;
  grant_id: string | null;
  organization_id: string | null;
  project_id: string | null;
  session_id: string | null;
  sandbox_id: string | null;
  principal_id: string | null;
  source: string | null;
  status: string | null;
  scope_level: string | null;
  request_id: string | null;
  approval_request_id: string | null;
  used_at: string | null;
}

interface PermissionPolicyRow {
  policy_id: string;
  scope_type: string;
  scope_id: string;
  version: number;
  mode: string;
  configuration: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface PermissionRequestRow {
  request_id: string;
  request_key: string;
  organization_id: string;
  project_id: string;
  session_id: string;
  task_id: string;
  sandbox_id: string | null;
  execution_id: string | null;
  mode: string;
  principal_type: string;
  principal_id: string;
  action: string;
  tool_name: string;
  resource_type: string;
  resource_identifier: string;
  resource_scope: string;
  status: string;
  reason: string;
  risk_level: string;
  permission_policy_version: string;
  decision_id: string | null;
  grant_id: string | null;
  approval_request_id: string | null;
  auto_review: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

interface HumanApprovalRow {
  approval_request_id: string;
  request_id: string;
  task_id: string;
  session_id: string;
  sandbox_id: string | null;
  scope: string;
  status: string;
  requested_by: string;
  decided_by: string | null;
  decision_reason: string | null;
  expires_at: string;
  decided_at: string | null;
  created_at: string;
}

interface PermissionDecisionRow {
  decision_id: string;
  request_id: string;
  task_id: string;
  session_id: string;
  sandbox_id: string | null;
  effect: string;
  layer: string;
  mode: string;
  permission_policy_version: string;
  reason: string;
  created_at: string;
}

interface AuditRow {
  id: string;
  timestamp: string;
  session_id: string | null;
  task_id: string | null;
  sandbox_id: string | null;
  execution_id: string | null;
  tool_call_id: string | null;
  policy_version: string | null;
  approval_id: string | null;
  action: string;
  outcome: string;
  detail: string;
}

interface CheckpointRow {
  checkpoint_id: string;
  workspace_id: string;
  task_id: string;
  created_at: string;
  source_execution_id: string | null;
  content_digest: string;
  storage_location: string;
}

const TASK_COLUMNS =
  'task_id, session_id, user_id, status, workspace_id, sandbox_id, workspace_root, current_cwd, cwd_version, cwd_invalidated_at, cwd_invalid_reason, created_at, updated_at';
const WORKSPACE_COLUMNS = 'workspace_id, task_id, storage_location, mode, current_version, created_at, updated_at';
const SANDBOX_COLUMNS =
  'sandbox_id, task_id, runtime_type, runtime_id, image_digest, workspace_id, policy_version, resource_profile, config_digest, status, created_at, last_heartbeat_at, updated_at';
const EXECUTION_COLUMNS =
  'execution_id, task_id, sandbox_id, idempotency_key, command_digest, command_json, cwd, cwd_version, status, exit_code, started_at, finished_at, stdout, stderr, policy_version, tool_call_id, decision_id, permission_mode, permission_policy_version, created_at, updated_at';
const APPROVAL_COLUMNS =
  'approval_id, task_id, action, resource_scope, expires_at, approved_by, policy_version, created_at, revoked_at, grant_id, organization_id, project_id, session_id, sandbox_id, principal_id, source, status, scope_level, request_id, approval_request_id, used_at';
const REQUEST_COLUMNS =
  'request_id, request_key, organization_id, project_id, session_id, task_id, sandbox_id, execution_id, mode, principal_type, principal_id, action, tool_name, resource_type, resource_identifier, resource_scope, status, reason, risk_level, permission_policy_version, decision_id, grant_id, approval_request_id, auto_review, expires_at, created_at, updated_at';

/** Request states that still count as "open" for idempotency. */
const REQUEST_OPEN_STATES: readonly PermissionRequestStatus[] = [
  'CREATED',
  'EVALUATING',
  'PENDING',
  'APPROVED',
  'GRANT_CREATED',
  'REVALIDATING',
];

const TASK_MUTABLE = new Set(['status', 'sandbox_id', 'workspace_id']);
const SANDBOX_MUTABLE = new Set([
  'status',
  'runtime_id',
  'runtime_type',
  'last_heartbeat_at',
  'config_digest',
]);

export class SqliteSandboxStore implements SandboxStore {
  readonly #db: DatabaseSync;
  readonly #statements: StatementCache;

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#statements = new StatementCache(db);
  }

  // ------------------------------------------------------------------ tasks ---

  async ensureTask(task: Task): Promise<Task> {
    // Read first, like the memory store does. `INSERT … ON CONFLICT DO NOTHING`
    // is not enough on its own: SQLite checks the NOT NULL/CHECK constraints
    // before it resolves the conflict, so a caller that passed a status this
    // build does not know would throw on an idempotent call instead of getting
    // the row that is already there.
    const existing = await this.getTask(task.taskId);
    if (existing) return existing;

    this.#run(
      `INSERT INTO sandbox_tasks (${TASK_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (task_id) DO NOTHING`,
      task.taskId,
      task.sessionId,
      task.userId,
      task.status,
      task.workspaceId,
      task.sandboxId,
      task.workspaceRoot ?? null,
      task.currentCwd ?? null,
      task.cwdVersion ?? 1,
      task.cwdInvalidatedAt ?? null,
      task.cwdInvalidReason ?? null,
      task.createdAt,
      task.updatedAt,
    );
    return (await this.getTask(task.taskId)) as Task;
  }

  async getTask(taskId: string): Promise<Task | null> {
    const row = this.#get<TaskRow>(
      `SELECT ${TASK_COLUMNS} FROM sandbox_tasks WHERE task_id = ?`,
      taskId,
    );
    return row ? toTask(row) : null;
  }

  async getTaskBySession(sessionId: string): Promise<Task | null> {
    const row = this.#get<TaskRow>(
      `SELECT ${TASK_COLUMNS} FROM sandbox_tasks WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
      sessionId,
    );
    return row ? toTask(row) : null;
  }

  async updateTask(
    taskId: string,
    patch: Partial<Pick<Task, 'status' | 'sandboxId' | 'workspaceId'>>,
  ): Promise<Task | null> {
    const entries = Object.entries(patch).filter(([key]) => TASK_MUTABLE.has(toColumn(key)));
    if (entries.length > 0) {
      const assignments = entries.map(([key]) => `${toColumn(key)} = ?`).join(', ');
      this.#run(
        `UPDATE sandbox_tasks SET ${assignments}, updated_at = ? WHERE task_id = ?`,
        ...entries.map(([, value]) => (value === undefined ? null : (value as SqlValue))),
        new Date().toISOString(),
        taskId,
      );
    }
    return this.getTask(taskId);
  }

  // ------------------------------------------------------- task cwd (ADR 021) ---

  async initializeTaskCwd(input: {
    readonly taskId: string;
    readonly workspaceRoot: string;
    readonly at: string;
  }): Promise<Task | null> {
    // `COALESCE` keeps an already-initialised cwd: initialisation repairs a row
    // that predates the columns, it never moves a task that has one.
    this.#run(
      `UPDATE sandbox_tasks
          SET workspace_root = COALESCE(workspace_root, ?),
              current_cwd = COALESCE(current_cwd, workspace_root, ?),
              cwd_version = COALESCE(cwd_version, 1),
              updated_at = ?
        WHERE task_id = ?`,
      input.workspaceRoot,
      input.workspaceRoot,
      input.at,
      input.taskId,
    );
    return this.getTask(input.taskId);
  }

  async compareAndSetTaskCwd(input: TaskCwdUpdateInput): Promise<TaskCwdUpdateResult> {
    // One transaction for the row and its audit row. `BEGIN IMMEDIATE` takes the
    // write lock up front so a reader cannot slip between the checks and the
    // update in a second process.
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.#get<TaskRow>(
        `SELECT ${TASK_COLUMNS} FROM sandbox_tasks WHERE task_id = ?`,
        input.taskId,
      );
      if (!row) {
        this.#db.exec('COMMIT');
        return { updated: false, reason: 'not_found', task: null };
      }
      if (row.status !== 'ACTIVE') {
        this.#db.exec('COMMIT');
        return { updated: false, reason: 'not_active', task: toTask(row) };
      }
      if (Number(row.cwd_version ?? 1) !== input.expectedVersion) {
        this.#db.exec('COMMIT');
        return { updated: false, reason: 'version_conflict', task: toTask(row) };
      }
      const result = this.#run(
        `UPDATE sandbox_tasks
            SET current_cwd = ?,
                cwd_version = cwd_version + 1,
                cwd_invalidated_at = NULL,
                cwd_invalid_reason = NULL,
                updated_at = ?
          WHERE task_id = ? AND status = 'ACTIVE' AND cwd_version = ?`,
        input.cwd,
        input.at,
        input.taskId,
        input.expectedVersion,
      );
      if (result.changes === 0) {
        this.#db.exec('COMMIT');
        const current = this.#get<TaskRow>(
          `SELECT ${TASK_COLUMNS} FROM sandbox_tasks WHERE task_id = ?`,
          input.taskId,
        );
        return {
          updated: false,
          reason: 'version_conflict',
          task: current ? toTask(current) : null,
        };
      }
      this.insertAudit(input.audit);
      this.#db.exec('COMMIT');
      const updated = this.#get<TaskRow>(
        `SELECT ${TASK_COLUMNS} FROM sandbox_tasks WHERE task_id = ?`,
        input.taskId,
      );
      return updated
        ? { updated: true, task: toTask(updated) }
        : { updated: false, reason: 'not_found', task: null };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  async setTaskCwdInvalidation(input: {
    readonly taskId: string;
    readonly reason: string | null;
    readonly at: string | null;
  }): Promise<Task | null> {
    if (input.at === null) {
      this.#run(
        `UPDATE sandbox_tasks
            SET cwd_invalidated_at = NULL, cwd_invalid_reason = NULL
          WHERE task_id = ?`,
        input.taskId,
      );
    } else {
      this.#run(
        `UPDATE sandbox_tasks
            SET cwd_invalidated_at = ?, cwd_invalid_reason = ?, updated_at = ?
          WHERE task_id = ?`,
        input.at,
        input.reason,
        input.at,
        input.taskId,
      );
    }
    return this.getTask(input.taskId);
  }

  async saveCwdOperation(record: CwdOperationRecord): Promise<void> {
    this.#run(
      `INSERT INTO task_cwd_operations (operation_id, task_id, path, result, cwd_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (operation_id) DO NOTHING`,
      record.operationId,
      record.taskId,
      record.path,
      JSON.stringify(record.result),
      record.cwdVersion,
      record.createdAt,
    );
  }

  async findCwdOperation(operationId: string): Promise<CwdOperationRecord | null> {
    const row = this.#get<{
      operation_id: string;
      task_id: string;
      path: string;
      result: string;
      cwd_version: number;
      created_at: string;
    }>('SELECT * FROM task_cwd_operations WHERE operation_id = ?', operationId);
    if (!row) return null;
    return {
      operationId: row.operation_id,
      taskId: row.task_id,
      path: row.path,
      result: parseJson(row.result) as ChangeDirectoryResult,
      cwdVersion: Number(row.cwd_version),
      createdAt: row.created_at,
    };
  }

  // -------------------------------------------------------------- workspaces ---

  async saveWorkspace(workspace: Workspace): Promise<void> {
    this.#run(
      `INSERT INTO sandbox_workspaces (${WORKSPACE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id) DO UPDATE SET
         current_version = excluded.current_version,
         updated_at = excluded.updated_at`,
      workspace.workspaceId,
      workspace.taskId,
      workspace.storageLocation,
      workspace.mode,
      workspace.currentVersion,
      workspace.createdAt,
      workspace.updatedAt,
    );
  }

  async getWorkspace(workspaceId: string): Promise<Workspace | null> {
    const row = this.#get<WorkspaceRow>(
      `SELECT ${WORKSPACE_COLUMNS} FROM sandbox_workspaces WHERE workspace_id = ?`,
      workspaceId,
    );
    return row ? toWorkspace(row) : null;
  }

  async getWorkspaceForTask(taskId: string): Promise<Workspace | null> {
    const row = this.#get<WorkspaceRow>(
      `SELECT ${WORKSPACE_COLUMNS} FROM sandbox_workspaces WHERE task_id = ? ORDER BY created_at DESC LIMIT 1`,
      taskId,
    );
    return row ? toWorkspace(row) : null;
  }

  async updateWorkspaceVersion(workspaceId: string, version: string, at: string): Promise<void> {
    this.#run(
      'UPDATE sandbox_workspaces SET current_version = ?, updated_at = ? WHERE workspace_id = ?',
      version,
      at,
      workspaceId,
    );
  }

  async deleteWorkspace(workspaceId: string): Promise<boolean> {
    return this.#run('DELETE FROM sandbox_workspaces WHERE workspace_id = ?', workspaceId).changes > 0;
  }

  async saveCheckpoint(checkpoint: WorkspaceCheckpoint): Promise<void> {
    this.#run(
      `INSERT INTO sandbox_workspace_checkpoints
         (checkpoint_id, workspace_id, task_id, created_at, source_execution_id, content_digest, storage_location)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (checkpoint_id) DO NOTHING`,
      checkpoint.checkpointId,
      checkpoint.workspaceId,
      checkpoint.taskId,
      checkpoint.createdAt,
      checkpoint.sourceExecutionId,
      checkpoint.contentDigest,
      checkpoint.storageLocation,
    );
  }

  async listCheckpoints(workspaceId: string): Promise<WorkspaceCheckpoint[]> {
    const rows = this.#all<CheckpointRow>(
      `SELECT checkpoint_id, workspace_id, task_id, created_at, source_execution_id, content_digest, storage_location
         FROM sandbox_workspace_checkpoints WHERE workspace_id = ? ORDER BY created_at DESC`,
      workspaceId,
    );
    return rows.map(toCheckpoint);
  }

  // --------------------------------------------------------------- sandboxes ---

  async saveSandbox(sandbox: Sandbox): Promise<void> {
    this.#run(
      `INSERT INTO sandboxes (${SANDBOX_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (sandbox_id) DO UPDATE SET
         runtime_type = excluded.runtime_type,
         runtime_id = excluded.runtime_id,
         config_digest = excluded.config_digest,
         status = excluded.status,
         last_heartbeat_at = excluded.last_heartbeat_at,
         updated_at = excluded.updated_at`,
      sandbox.sandboxId,
      sandbox.taskId,
      sandbox.runtimeType,
      sandbox.runtimeId,
      sandbox.imageDigest,
      sandbox.workspaceId,
      sandbox.policyVersion,
      sandbox.resourceProfile,
      sandbox.configDigest ?? '',
      sandbox.status,
      sandbox.createdAt,
      sandbox.lastHeartbeatAt,
      sandbox.updatedAt,
    );
  }

  async getSandbox(sandboxId: string): Promise<Sandbox | null> {
    const row = this.#get<SandboxRow>(
      `SELECT ${SANDBOX_COLUMNS} FROM sandboxes WHERE sandbox_id = ?`,
      sandboxId,
    );
    return row ? toSandbox(row) : null;
  }

  async getSandboxForTask(taskId: string): Promise<Sandbox | null> {
    const row = this.#get<SandboxRow>(
      `SELECT ${SANDBOX_COLUMNS} FROM sandboxes WHERE task_id = ? ORDER BY created_at DESC LIMIT 1`,
      taskId,
    );
    return row ? toSandbox(row) : null;
  }

  async listSandboxes(statuses?: readonly SandboxStatus[]): Promise<Sandbox[]> {
    if (!statuses || statuses.length === 0) {
      return this.#all<SandboxRow>(`SELECT ${SANDBOX_COLUMNS} FROM sandboxes ORDER BY created_at DESC`).map(
        toSandbox,
      );
    }
    const placeholders = statuses.map(() => '?').join(', ');
    return this.#all<SandboxRow>(
      `SELECT ${SANDBOX_COLUMNS} FROM sandboxes WHERE status IN (${placeholders}) ORDER BY created_at DESC`,
      ...statuses,
    ).map(toSandbox);
  }

  async updateSandbox(
    sandboxId: string,
    patch: Partial<Pick<Sandbox, 'status' | 'runtimeId' | 'runtimeType' | 'lastHeartbeatAt'>>,
  ): Promise<Sandbox | null> {
    const entries = Object.entries(patch).filter(([key]) => SANDBOX_MUTABLE.has(toColumn(key)));
    if (entries.length > 0) {
      const assignments = entries.map(([key]) => `${toColumn(key)} = ?`).join(', ');
      this.#run(
        `UPDATE sandboxes SET ${assignments}, updated_at = ? WHERE sandbox_id = ?`,
        ...entries.map(([, value]) => (value === undefined ? null : (value as SqlValue))),
        new Date().toISOString(),
        sandboxId,
      );
    }
    return this.getSandbox(sandboxId);
  }

  async touchSandboxHeartbeat(sandboxId: string, at: string): Promise<void> {
    this.#run('UPDATE sandboxes SET last_heartbeat_at = ? WHERE sandbox_id = ?', at, sandboxId);
  }

  // -------------------------------------------------------------- executions ---

  async createExecution(execution: Execution): Promise<CreateExecutionResult> {
    const inserted = this.#run(
      `INSERT INTO executions (${EXECUTION_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (sandbox_id, idempotency_key) DO NOTHING`,
      execution.executionId,
      execution.taskId,
      execution.sandboxId,
      execution.idempotencyKey,
      execution.commandDigest,
      JSON.stringify(execution.command),
      execution.cwd,
      execution.cwdVersion ?? 1,
      execution.status,
      execution.exitCode,
      execution.startedAt,
      execution.finishedAt,
      execution.stdout,
      execution.stderr,
      execution.policyVersion,
      execution.toolCallId,
      execution.decisionId ?? null,
      execution.permissionMode ?? null,
      execution.permissionPolicyVersion ?? null,
      execution.createdAt,
      execution.updatedAt,
    );
    const stored = await this.findExecutionByKey(execution.sandboxId, execution.idempotencyKey);
    if (!stored) throw new Error('execution insert did not produce a row');
    return { execution: stored, created: inserted.changes > 0 };
  }

  async getExecution(executionId: string): Promise<Execution | null> {
    const row = this.#get<ExecutionRow>(
      `SELECT ${EXECUTION_COLUMNS} FROM executions WHERE execution_id = ?`,
      executionId,
    );
    return row ? toExecution(row) : null;
  }

  async findExecutionByKey(sandboxId: string, idempotencyKey: string): Promise<Execution | null> {
    const row = this.#get<ExecutionRow>(
      `SELECT ${EXECUTION_COLUMNS} FROM executions WHERE sandbox_id = ? AND idempotency_key = ?`,
      sandboxId,
      idempotencyKey,
    );
    return row ? toExecution(row) : null;
  }

  async listUnfinishedExecutions(sandboxId?: string): Promise<Execution[]> {
    const placeholders = UNFINISHED_EXECUTION_STATES.map(() => '?').join(', ');
    const sql = sandboxId
      ? `SELECT ${EXECUTION_COLUMNS} FROM executions WHERE status IN (${placeholders}) AND sandbox_id = ? ORDER BY created_at`
      : `SELECT ${EXECUTION_COLUMNS} FROM executions WHERE status IN (${placeholders}) ORDER BY created_at`;
    const params: SqlValue[] = [...UNFINISHED_EXECUTION_STATES];
    if (sandboxId) params.push(sandboxId);
    return this.#all<ExecutionRow>(sql, ...params).map(toExecution);
  }

  async transitionExecution(
    executionId: string,
    from: readonly ExecutionState[],
    to: ExecutionState,
    patch: ExecutionTransitionPatch = {},
  ): Promise<Execution | null> {
    if (from.length === 0) throw new Error('transitionExecution requires at least one source state');
    const assignments = ['status = ?', 'updated_at = ?'];
    const values: SqlValue[] = [to, new Date().toISOString()];
    if (patch.exitCode !== undefined) {
      assignments.push('exit_code = ?');
      values.push(patch.exitCode);
    }
    if (patch.startedAt !== undefined) {
      assignments.push('started_at = ?');
      values.push(patch.startedAt);
    }
    if (patch.finishedAt !== undefined) {
      assignments.push('finished_at = ?');
      values.push(patch.finishedAt);
    }
    if (patch.stdout !== undefined) {
      assignments.push('stdout = ?');
      values.push(patch.stdout);
    }
    if (patch.stderr !== undefined) {
      assignments.push('stderr = ?');
      values.push(patch.stderr);
    }
    const placeholders = from.map(() => '?').join(', ');
    const result = this.#run(
      `UPDATE executions SET ${assignments.join(', ')} WHERE execution_id = ? AND status IN (${placeholders})`,
      ...values,
      executionId,
      ...from,
    );
    if (result.changes === 0) return null;
    return this.getExecution(executionId);
  }

  async appendEvent(event: ExecutionEvent): Promise<void> {
    this.#run(
      `INSERT INTO execution_events
         (event_id, task_id, sandbox_id, execution_id, idempotency_key, event_type, timestamp, policy_version, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      event.eventId,
      event.taskId,
      event.sandboxId,
      event.executionId,
      event.idempotencyKey,
      event.eventType,
      event.timestamp,
      event.policyVersion,
      JSON.stringify(event.payload ?? {}),
    );
  }

  async listEvents(executionId: string): Promise<ExecutionEvent[]> {
    return this.#all<EventRow>(
      `SELECT event_id, task_id, sandbox_id, execution_id, idempotency_key, event_type, timestamp, policy_version, payload
         FROM execution_events WHERE execution_id = ? ORDER BY timestamp, rowid`,
      executionId,
    ).map((row) => ({
      eventId: row.event_id,
      taskId: row.task_id,
      sandboxId: row.sandbox_id,
      executionId: row.execution_id,
      idempotencyKey: row.idempotency_key,
      eventType: row.event_type,
      timestamp: row.timestamp,
      policyVersion: row.policy_version,
      payload: parseJson(row.payload),
    }));
  }

  // --------------------------------------------------------------- approvals ---

  async saveApproval(grant: ApprovalGrant): Promise<void> {
    this.#run(
      `INSERT INTO sandbox_approvals (${APPROVAL_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (approval_id) DO NOTHING`,
      grant.approvalId,
      grant.taskId,
      grant.action,
      JSON.stringify(grant.resourceScope),
      grant.expiresAt,
      grant.approvedBy,
      grant.policyVersion,
      grant.createdAt,
      grant.revokedAt,
      grant.grantId ?? grant.approvalId,
      grant.organizationId ?? null,
      grant.projectId ?? null,
      grant.sessionId ?? null,
      grant.sandboxId ?? null,
      grant.principalId ?? null,
      grant.source ?? 'human_approval',
      grant.status ?? 'active',
      grant.scope ?? 'task',
      grant.requestId ?? null,
      grant.approvalRequestId ?? null,
      grant.usedAt ?? null,
    );
  }

  async getApproval(approvalId: string): Promise<ApprovalGrant | null> {
    const row = this.#get<ApprovalRow>(
      `SELECT ${APPROVAL_COLUMNS} FROM sandbox_approvals WHERE approval_id = ?`,
      approvalId,
    );
    return row ? toApproval(row) : null;
  }

  async listApprovals(taskId: string, now: string): Promise<ApprovalGrant[]> {
    return this.#all<ApprovalRow>(
      `SELECT ${APPROVAL_COLUMNS}
         FROM sandbox_approvals
        WHERE task_id = ? AND revoked_at IS NULL AND expires_at > ?
        ORDER BY created_at DESC`,
      taskId,
      now,
    ).map(toApproval);
  }

  async listGrants(filter: GrantFilter): Promise<ApprovalGrant[]> {
    const clauses: string[] = [];
    const params: SqlValue[] = [];
    if (filter.taskId !== undefined) {
      clauses.push('task_id = ?');
      params.push(filter.taskId);
    }
    if (filter.sessionId !== undefined) {
      clauses.push('session_id = ?');
      params.push(filter.sessionId);
    }
    if (filter.requestId !== undefined) {
      clauses.push('request_id = ?');
      params.push(filter.requestId);
    }
    if (filter.approvalRequestId !== undefined) {
      clauses.push('approval_request_id = ?');
      params.push(filter.approvalRequestId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.#all<ApprovalRow>(
      `SELECT ${APPROVAL_COLUMNS} FROM sandbox_approvals ${where} ORDER BY created_at DESC`,
      ...params,
    ).map(toApproval);
  }

  async markGrantUsed(grantId: string, at: string): Promise<boolean> {
    return (
      this.#run(
        'UPDATE sandbox_approvals SET used_at = ? WHERE approval_id = ? AND used_at IS NULL',
        at,
        grantId,
      ).changes > 0
    );
  }

  async setGrantStatus(
    grantId: string,
    status: 'active' | 'revoked' | 'expired',
    at: string,
  ): Promise<boolean> {
    const revokedAt = status === 'revoked' ? at : null;
    return (
      this.#run(
        'UPDATE sandbox_approvals SET status = ?, revoked_at = COALESCE(?, revoked_at) WHERE approval_id = ?',
        status,
        revokedAt,
        grantId,
      ).changes > 0
    );
  }

  async revokeApproval(approvalId: string, at: string): Promise<boolean> {
    return (
      this.#run(
        'UPDATE sandbox_approvals SET revoked_at = ? WHERE approval_id = ? AND revoked_at IS NULL',
        at,
        approvalId,
      ).changes > 0
    );
  }

  // ---------------------------------------------------- permission policies ---

  async savePermissionPolicy(record: PermissionPolicyRecord): Promise<void> {
    this.#run(
      `INSERT INTO permission_policies
         (policy_id, scope_type, scope_id, version, mode, configuration, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (policy_id) DO UPDATE SET
         version = excluded.version,
         mode = excluded.mode,
         configuration = excluded.configuration,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`,
      record.policyId,
      record.scopeType,
      record.scopeId,
      record.version,
      record.mode,
      JSON.stringify({
        rules: record.rules,
        autoReview: record.autoReview,
        approval: record.approval,
        restricted: record.restricted,
      }),
      record.expiresAt,
      record.createdAt,
      record.updatedAt,
    );
  }

  async getPermissionPolicy(
    scopeType: PermissionScopeLevel,
    scopeId: string,
    version: number,
  ): Promise<PermissionPolicyRecord | null> {
    const row = this.#get<PermissionPolicyRow>(
      `SELECT policy_id, scope_type, scope_id, version, mode, configuration, expires_at, created_at, updated_at
         FROM permission_policies WHERE scope_type = ? AND scope_id = ? AND version = ?`,
      scopeType,
      scopeId,
      version,
    );
    return row ? toPermissionPolicy(row) : null;
  }

  async latestPermissionPolicy(
    scopeType: PermissionScopeLevel,
    scopeId: string,
  ): Promise<PermissionPolicyRecord | null> {
    const row = this.#get<PermissionPolicyRow>(
      `SELECT policy_id, scope_type, scope_id, version, mode, configuration, expires_at, created_at, updated_at
         FROM permission_policies WHERE scope_type = ? AND scope_id = ?
        ORDER BY version DESC LIMIT 1`,
      scopeType,
      scopeId,
    );
    return row ? toPermissionPolicy(row) : null;
  }

  async listPermissionPolicies(
    scopeType: PermissionScopeLevel,
    scopeId: string,
  ): Promise<PermissionPolicyRecord[]> {
    return this.#all<PermissionPolicyRow>(
      `SELECT policy_id, scope_type, scope_id, version, mode, configuration, expires_at, created_at, updated_at
         FROM permission_policies WHERE scope_type = ? AND scope_id = ? ORDER BY version DESC`,
      scopeType,
      scopeId,
    ).map(toPermissionPolicy);
  }

  // ----------------------------------------------------- permission requests ---

  async createPermissionRequest(
    request: PermissionRequestRecord,
  ): Promise<CreatePermissionRequestResult> {
    const inserted = this.#run(
      `INSERT INTO permission_requests (${REQUEST_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (request_id) DO NOTHING`,
      request.requestId,
      request.requestKey,
      request.organizationId,
      request.projectId,
      request.sessionId,
      request.taskId,
      request.sandboxId,
      request.executionId,
      request.mode,
      request.principalType,
      request.principalId,
      request.action,
      request.toolName,
      request.resourceType,
      request.resourceIdentifier,
      JSON.stringify(request.resourceScope),
      request.status,
      request.reason,
      request.riskLevel,
      request.permissionPolicyVersion,
      request.decisionId,
      request.grantId,
      request.approvalRequestId,
      request.autoReview ? JSON.stringify(request.autoReview) : null,
      request.expiresAt,
      request.createdAt,
      request.updatedAt,
    );
    const stored = await this.getPermissionRequest(request.requestId);
    if (!stored) throw new Error('permission request insert did not produce a row');
    return { request: stored, created: inserted.changes > 0 };
  }

  async getPermissionRequest(requestId: string): Promise<PermissionRequestRecord | null> {
    const row = this.#get<PermissionRequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM permission_requests WHERE request_id = ?`,
      requestId,
    );
    return row ? toPermissionRequest(row) : null;
  }

  async findOpenPermissionRequest(requestKey: string): Promise<PermissionRequestRecord | null> {
    const placeholders = REQUEST_OPEN_STATES.map(() => '?').join(', ');
    const row = this.#get<PermissionRequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM permission_requests
        WHERE request_key = ? AND status IN (${placeholders})
        ORDER BY created_at DESC LIMIT 1`,
      requestKey,
      ...REQUEST_OPEN_STATES,
    );
    return row ? toPermissionRequest(row) : null;
  }

  async updatePermissionRequest(
    requestId: string,
    from: readonly PermissionRequestStatus[],
    to: PermissionRequestStatus,
    patch: PermissionRequestPatch = {},
  ): Promise<PermissionRequestRecord | null> {
    if (from.length === 0) throw new Error('updatePermissionRequest requires at least one source state');
    const assignments: string[] = ['status = ?', 'updated_at = ?'];
    const values: SqlValue[] = [to, new Date().toISOString()];
    const columns: Record<keyof PermissionRequestPatch, string> = {
      reason: 'reason',
      riskLevel: 'risk_level',
      decisionId: 'decision_id',
      grantId: 'grant_id',
      approvalRequestId: 'approval_request_id',
      autoReview: 'auto_review',
      executionId: 'execution_id',
    };
    for (const [key, column] of Object.entries(columns) as [keyof PermissionRequestPatch, string][]) {
      const value = patch[key];
      if (value === undefined) continue;
      assignments.push(`${column} = ?`);
      values.push(
        key === 'autoReview'
          ? value === null
            ? null
            : JSON.stringify(value as AutoReviewResultRecord)
          : (value as SqlValue),
      );
    }
    const placeholders = from.map(() => '?').join(', ');
    const result = this.#run(
      `UPDATE permission_requests SET ${assignments.join(', ')}
        WHERE request_id = ? AND status IN (${placeholders})`,
      ...values,
      requestId,
      ...from,
    );
    if (result.changes === 0) return null;
    return this.getPermissionRequest(requestId);
  }

  async listPermissionRequests(filter: {
    readonly taskId?: string;
    readonly sessionId?: string;
    readonly statuses?: readonly PermissionRequestStatus[];
    readonly limit?: number;
  } = {}): Promise<PermissionRequestRecord[]> {
    const clauses: string[] = [];
    const params: SqlValue[] = [];
    if (filter.taskId !== undefined) {
      clauses.push('task_id = ?');
      params.push(filter.taskId);
    }
    if (filter.sessionId !== undefined) {
      clauses.push('session_id = ?');
      params.push(filter.sessionId);
    }
    if (filter.statuses && filter.statuses.length > 0) {
      clauses.push(`status IN (${filter.statuses.map(() => '?').join(', ')})`);
      params.push(...filter.statuses);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1_000);
    return this.#all<PermissionRequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM permission_requests ${where}
        ORDER BY created_at DESC LIMIT ?`,
      ...params,
      limit,
    ).map(toPermissionRequest);
  }

  // --------------------------------------------------------- human approvals ---

  async createHumanApproval(record: HumanApprovalRecord): Promise<HumanApprovalRecord> {
    this.#run(
      `INSERT INTO permission_approval_requests
         (approval_request_id, request_id, task_id, session_id, sandbox_id, scope, status,
          requested_by, decided_by, decision_reason, expires_at, decided_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (approval_request_id) DO NOTHING`,
      record.approvalRequestId,
      record.requestId,
      record.taskId,
      record.sessionId,
      record.sandboxId,
      record.scope,
      record.status,
      record.requestedBy,
      record.decidedBy,
      record.decisionReason,
      record.expiresAt,
      record.decidedAt,
      record.createdAt,
    );
    return (await this.getHumanApproval(record.approvalRequestId)) as HumanApprovalRecord;
  }

  async getHumanApproval(approvalRequestId: string): Promise<HumanApprovalRecord | null> {
    const row = this.#get<HumanApprovalRow>(
      `SELECT approval_request_id, request_id, task_id, session_id, sandbox_id, scope, status,
              requested_by, decided_by, decision_reason, expires_at, decided_at, created_at
         FROM permission_approval_requests WHERE approval_request_id = ?`,
      approvalRequestId,
    );
    return row ? toHumanApproval(row) : null;
  }

  async listHumanApprovals(filter: {
    readonly taskId?: string;
    readonly requestId?: string;
    readonly statuses?: readonly HumanApprovalStatus[];
    readonly limit?: number;
  } = {}): Promise<HumanApprovalRecord[]> {
    const clauses: string[] = [];
    const params: SqlValue[] = [];
    if (filter.taskId !== undefined) {
      clauses.push('task_id = ?');
      params.push(filter.taskId);
    }
    if (filter.requestId !== undefined) {
      clauses.push('request_id = ?');
      params.push(filter.requestId);
    }
    if (filter.statuses && filter.statuses.length > 0) {
      clauses.push(`status IN (${filter.statuses.map(() => '?').join(', ')})`);
      params.push(...filter.statuses);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1_000);
    return this.#all<HumanApprovalRow>(
      `SELECT approval_request_id, request_id, task_id, session_id, sandbox_id, scope, status,
              requested_by, decided_by, decision_reason, expires_at, decided_at, created_at
         FROM permission_approval_requests ${where} ORDER BY created_at DESC LIMIT ?`,
      ...params,
      limit,
    ).map(toHumanApproval);
  }

  async decideHumanApproval(
    approvalRequestId: string,
    from: readonly HumanApprovalStatus[],
    to: HumanApprovalStatus,
    patch: HumanApprovalPatch = {},
  ): Promise<HumanApprovalRecord | null> {
    if (from.length === 0) throw new Error('decideHumanApproval requires at least one source state');
    const assignments = ['status = ?'];
    const values: SqlValue[] = [to];
    if (patch.decidedBy !== undefined) {
      assignments.push('decided_by = ?');
      values.push(patch.decidedBy);
    }
    if (patch.decisionReason !== undefined) {
      assignments.push('decision_reason = ?');
      values.push(patch.decisionReason);
    }
    if (patch.decidedAt !== undefined) {
      assignments.push('decided_at = ?');
      values.push(patch.decidedAt);
    }
    if (patch.scope !== undefined) {
      assignments.push('scope = ?');
      values.push(patch.scope);
    }
    const placeholders = from.map(() => '?').join(', ');
    const result = this.#run(
      `UPDATE permission_approval_requests SET ${assignments.join(', ')}
        WHERE approval_request_id = ? AND status IN (${placeholders})`,
      ...values,
      approvalRequestId,
      ...from,
    );
    if (result.changes === 0) return null;
    return this.getHumanApproval(approvalRequestId);
  }

  // ---------------------------------------------------- permission decisions ---

  async savePermissionDecision(decision: PermissionDecision): Promise<void> {
    this.#run(
      `INSERT INTO permission_decisions
         (decision_id, request_id, task_id, session_id, sandbox_id, effect, layer, mode,
          permission_policy_version, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (decision_id) DO NOTHING`,
      decision.decisionId,
      decision.requestId,
      decision.taskId ?? '',
      decision.sessionId ?? '',
      decision.sandboxId ?? null,
      decision.effect,
      decision.layer,
      decision.mode,
      decision.permissionPolicyVersion,
      decision.reason,
      decision.createdAt ?? new Date().toISOString(),
    );
  }

  async getPermissionDecision(decisionId: string): Promise<PermissionDecision | null> {
    const row = this.#get<PermissionDecisionRow>(
      `SELECT decision_id, request_id, task_id, session_id, sandbox_id, effect, layer, mode,
              permission_policy_version, reason, created_at
         FROM permission_decisions WHERE decision_id = ?`,
      decisionId,
    );
    return row ? toPermissionDecision(row) : null;
  }

  // ---------------------------------------------------------------- policies ---

  async savePolicy(version: string, scope: string, configuration: unknown, at: string): Promise<void> {
    this.#run(
      `INSERT INTO sandbox_policies (policy_id, version, scope, configuration, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (version) DO UPDATE SET configuration = excluded.configuration`,
      randomUUID(),
      version,
      scope,
      JSON.stringify(configuration),
      at,
    );
  }

  async getPolicy(version: string): Promise<unknown | null> {
    const row = this.#get<{ configuration: string }>(
      'SELECT configuration FROM sandbox_policies WHERE version = ?',
      version,
    );
    return row ? parseJson(row.configuration) : null;
  }

  // ------------------------------------------------------------------- audit ---

  async appendAudit(event: AuditEvent): Promise<void> {
    this.insertAudit(event);
  }

  /** The audit insert, shared with the transactional cwd change. */
  private insertAudit(event: AuditEvent): void {
    this.#run(
      `INSERT INTO sandbox_audit_events
         (id, timestamp, session_id, task_id, sandbox_id, execution_id, tool_call_id, policy_version, approval_id, action, outcome, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      event.id,
      event.timestamp,
      event.sessionId,
      event.taskId,
      event.sandboxId,
      event.executionId,
      event.toolCallId,
      event.policyVersion,
      event.approvalId,
      event.action,
      event.outcome,
      JSON.stringify(event.detail ?? {}),
    );
  }

  async listAudit(query: number | AuditQuery = 100): Promise<AuditEvent[]> {
    const filter: AuditQuery = typeof query === 'number' ? { limit: query } : query;
    const clauses: string[] = [];
    const params: SqlValue[] = [];
    if (filter.taskId !== undefined) {
      clauses.push('task_id = ?');
      params.push(filter.taskId);
    }
    if (filter.sandboxId !== undefined) {
      clauses.push('sandbox_id = ?');
      params.push(filter.sandboxId);
    }
    if (filter.executionId !== undefined) {
      clauses.push('execution_id = ?');
      params.push(filter.executionId);
    }
    if (filter.action !== undefined) {
      clauses.push('action = ?');
      params.push(filter.action);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.#all<AuditRow>(
      `SELECT id, timestamp, session_id, task_id, sandbox_id, execution_id, tool_call_id, policy_version,
              approval_id, action, outcome, detail
         FROM sandbox_audit_events ${where} ORDER BY timestamp DESC LIMIT ?`,
      ...params,
      Math.min(Math.max(filter.limit ?? 100, 1), 1_000),
    ).map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      sessionId: row.session_id,
      taskId: row.task_id,
      sandboxId: row.sandbox_id,
      executionId: row.execution_id,
      toolCallId: row.tool_call_id,
      policyVersion: row.policy_version,
      approvalId: row.approval_id,
      action: row.action,
      outcome: row.outcome as AuditEvent['outcome'],
      detail: parseJson(row.detail),
    }));
  }

  // ---------------------------------------------------------------- internals ---

  #all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.#statements.get(sql).all(...params) as T[];
  }

  #get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.#statements.get(sql).get(...params) as T | undefined;
  }

  #run(sql: string, ...params: SqlValue[]): { changes: number } {
    const result = this.#statements.get(sql).run(...params);
    return { changes: Number(result.changes) };
  }
}

function toColumn(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toTask(row: TaskRow): Task {
  return {
    taskId: row.task_id,
    sessionId: row.session_id,
    userId: row.user_id,
    status: row.status as Task['status'],
    workspaceId: row.workspace_id,
    sandboxId: row.sandbox_id,
    workspaceRoot: row.workspace_root,
    currentCwd: row.current_cwd,
    cwdVersion: Number(row.cwd_version ?? 1),
    cwdInvalidatedAt: row.cwd_invalidated_at,
    cwdInvalidReason: row.cwd_invalid_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    workspaceId: row.workspace_id,
    taskId: row.task_id,
    storageLocation: row.storage_location,
    mode: row.mode as Workspace['mode'],
    currentVersion: row.current_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSandbox(row: SandboxRow): Sandbox {
  return {
    sandboxId: row.sandbox_id,
    taskId: row.task_id,
    runtimeType: row.runtime_type,
    runtimeId: row.runtime_id,
    imageDigest: row.image_digest,
    workspaceId: row.workspace_id,
    policyVersion: row.policy_version,
    resourceProfile: row.resource_profile,
    configDigest: row.config_digest,
    status: row.status as SandboxStatus,
    createdAt: row.created_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    updatedAt: row.updated_at,
  };
}

function toExecution(row: ExecutionRow): Execution {
  return {
    executionId: row.execution_id,
    taskId: row.task_id,
    sandboxId: row.sandbox_id,
    idempotencyKey: row.idempotency_key,
    commandDigest: row.command_digest,
    command: parseJson(row.command_json) as string[],
    cwd: row.cwd,
    cwdVersion: Number(row.cwd_version ?? 1),
    status: row.status as ExecutionState,
    exitCode: row.exit_code === null ? null : Number(row.exit_code),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    stdout: row.stdout,
    stderr: row.stderr,
    policyVersion: row.policy_version,
    toolCallId: row.tool_call_id,
    decisionId: row.decision_id,
    permissionMode: row.permission_mode,
    permissionPolicyVersion: row.permission_policy_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toApproval(row: ApprovalRow): ApprovalGrant {
  return {
    approvalId: row.approval_id,
    taskId: row.task_id,
    action: row.action,
    resourceScope: (parseJson(row.resource_scope) as string[]) ?? [],
    expiresAt: row.expires_at,
    approvedBy: row.approved_by,
    policyVersion: row.policy_version,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    grantId: row.grant_id ?? row.approval_id,
    organizationId: row.organization_id ?? undefined,
    projectId: row.project_id ?? undefined,
    sessionId: row.session_id,
    sandboxId: row.sandbox_id,
    principalId: row.principal_id ?? undefined,
    source: (row.source as ApprovalGrant['source']) ?? 'human_approval',
    status: (row.status as ApprovalGrant['status']) ?? (row.revoked_at ? 'revoked' : 'active'),
    scope: (row.scope_level as ApprovalGrant['scope']) ?? 'task',
    requestId: row.request_id,
    approvalRequestId: row.approval_request_id,
    usedAt: row.used_at,
  };
}

function toPermissionPolicy(row: PermissionPolicyRow): PermissionPolicyRecord {
  const configuration = (parseJson(row.configuration) ?? {}) as {
    rules?: PermissionPolicyRecord['rules'];
    autoReview?: PermissionPolicyRecord['autoReview'];
    approval?: PermissionPolicyRecord['approval'];
    restricted?: PermissionPolicyRecord['restricted'];
  };
  return {
    policyId: row.policy_id,
    scopeType: row.scope_type as PermissionScopeLevel,
    scopeId: row.scope_id,
    version: Number(row.version),
    mode: row.mode as PermissionMode,
    rules: configuration.rules ?? [],
    autoReview: configuration.autoReview ?? {
      enabled: false,
      allowedRiskLevels: [],
      maxTtlMs: 0,
    },
    approval: configuration.approval ?? {
      allowed: false,
      requireHumanForRiskLevels: [],
      maxTtlMs: 0,
    },
    restricted: configuration.restricted ?? {
      allowedTools: [],
      filesystem: { read: [], write: [] },
      network: { mode: 'none', allowedDomains: [], allowedPorts: [] },
    },
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPermissionRequest(row: PermissionRequestRow): PermissionRequestRecord {
  return {
    requestId: row.request_id,
    requestKey: row.request_key,
    organizationId: row.organization_id,
    projectId: row.project_id,
    sessionId: row.session_id,
    taskId: row.task_id,
    sandboxId: row.sandbox_id,
    executionId: row.execution_id,
    mode: row.mode as PermissionMode,
    principalType: row.principal_type as PermissionRequestRecord['principalType'],
    principalId: row.principal_id,
    action: row.action as PermissionAction,
    toolName: row.tool_name,
    resourceType: row.resource_type as PermissionRequestRecord['resourceType'],
    resourceIdentifier: row.resource_identifier,
    resourceScope: (parseJson(row.resource_scope) as string[]) ?? [],
    status: row.status as PermissionRequestStatus,
    reason: row.reason,
    riskLevel: row.risk_level as RiskLevel,
    permissionPolicyVersion: row.permission_policy_version,
    decisionId: row.decision_id,
    grantId: row.grant_id,
    approvalRequestId: row.approval_request_id,
    autoReview: row.auto_review ? (parseJson(row.auto_review) as AutoReviewResultRecord) : null,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toHumanApproval(row: HumanApprovalRow): HumanApprovalRecord {
  return {
    approvalRequestId: row.approval_request_id,
    requestId: row.request_id,
    taskId: row.task_id,
    sessionId: row.session_id,
    sandboxId: row.sandbox_id,
    scope: row.scope as HumanApprovalRecord['scope'],
    status: row.status as HumanApprovalStatus,
    requestedBy: row.requested_by,
    decidedBy: row.decided_by,
    decisionReason: row.decision_reason,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
  };
}

function toPermissionDecision(row: PermissionDecisionRow): PermissionDecision {
  return {
    decisionId: row.decision_id,
    requestId: row.request_id,
    effect: row.effect as PermissionDecisionEffect,
    layer: row.layer as PermissionDecisionLayer,
    mode: row.mode as PermissionMode,
    permissionPolicyVersion: row.permission_policy_version,
    reason: row.reason,
    resources: [],
    taskId: row.task_id,
    sessionId: row.session_id,
    sandboxId: row.sandbox_id,
    createdAt: row.created_at,
  };
}

function toCheckpoint(row: CheckpointRow): WorkspaceCheckpoint {
  return {
    checkpointId: row.checkpoint_id,
    workspaceId: row.workspace_id,
    taskId: row.task_id,
    createdAt: row.created_at,
    sourceExecutionId: row.source_execution_id,
    contentDigest: row.content_digest,
    storageLocation: row.storage_location,
  };
}
