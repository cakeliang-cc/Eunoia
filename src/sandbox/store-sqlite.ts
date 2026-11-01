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
  CreateExecutionResult,
  ExecutionTransitionPatch,
  SandboxStore,
} from './store.ts';

type SqlValue = string | number | null;

interface TaskRow {
  task_id: string;
  session_id: string;
  user_id: string;
  status: string;
  workspace_id: string;
  sandbox_id: string | null;
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
  status: string;
  exit_code: number | null;
  started_at: string | null;
  finished_at: string | null;
  stdout: string;
  stderr: string;
  policy_version: string;
  tool_call_id: string | null;
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

const TASK_COLUMNS = 'task_id, session_id, user_id, status, workspace_id, sandbox_id, created_at, updated_at';
const WORKSPACE_COLUMNS = 'workspace_id, task_id, storage_location, mode, current_version, created_at, updated_at';
const SANDBOX_COLUMNS =
  'sandbox_id, task_id, runtime_type, runtime_id, image_digest, workspace_id, policy_version, resource_profile, status, created_at, last_heartbeat_at, updated_at';
const EXECUTION_COLUMNS =
  'execution_id, task_id, sandbox_id, idempotency_key, command_digest, command_json, cwd, status, exit_code, started_at, finished_at, stdout, stderr, policy_version, tool_call_id, created_at, updated_at';

const TASK_MUTABLE = new Set(['status', 'sandbox_id', 'workspace_id']);
const SANDBOX_MUTABLE = new Set(['status', 'runtime_id', 'runtime_type', 'last_heartbeat_at']);

export class SqliteSandboxStore implements SandboxStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  // ------------------------------------------------------------------ tasks ---

  async ensureTask(task: Task): Promise<Task> {
    this.#run(
      `INSERT INTO sandbox_tasks (${TASK_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (task_id) DO NOTHING`,
      task.taskId,
      task.sessionId,
      task.userId,
      task.status,
      task.workspaceId,
      task.sandboxId,
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
      `INSERT INTO sandboxes (${SANDBOX_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (sandbox_id) DO UPDATE SET
         runtime_type = excluded.runtime_type,
         runtime_id = excluded.runtime_id,
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (sandbox_id, idempotency_key) DO NOTHING`,
      execution.executionId,
      execution.taskId,
      execution.sandboxId,
      execution.idempotencyKey,
      execution.commandDigest,
      JSON.stringify(execution.command),
      execution.cwd,
      execution.status,
      execution.exitCode,
      execution.startedAt,
      execution.finishedAt,
      execution.stdout,
      execution.stderr,
      execution.policyVersion,
      execution.toolCallId,
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
      `INSERT INTO sandbox_approvals
         (approval_id, task_id, action, resource_scope, expires_at, approved_by, policy_version, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    );
  }

  async getApproval(approvalId: string): Promise<ApprovalGrant | null> {
    const row = this.#get<ApprovalRow>(
      `SELECT approval_id, task_id, action, resource_scope, expires_at, approved_by, policy_version, created_at, revoked_at
         FROM sandbox_approvals WHERE approval_id = ?`,
      approvalId,
    );
    return row ? toApproval(row) : null;
  }

  async listApprovals(taskId: string, now: string): Promise<ApprovalGrant[]> {
    return this.#all<ApprovalRow>(
      `SELECT approval_id, task_id, action, resource_scope, expires_at, approved_by, policy_version, created_at, revoked_at
         FROM sandbox_approvals
        WHERE task_id = ? AND revoked_at IS NULL AND expires_at > ?
        ORDER BY created_at DESC`,
      taskId,
      now,
    ).map(toApproval);
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

  async listAudit(limit = 100): Promise<AuditEvent[]> {
    return this.#all<AuditRow>(
      `SELECT id, timestamp, session_id, task_id, sandbox_id, execution_id, tool_call_id, policy_version,
              approval_id, action, outcome, detail
         FROM sandbox_audit_events ORDER BY timestamp DESC LIMIT ?`,
      Math.min(Math.max(limit, 1), 1_000),
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
    return this.#db.prepare(sql).all(...params) as T[];
  }

  #get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.#db.prepare(sql).get(...params) as T | undefined;
  }

  #run(sql: string, ...params: SqlValue[]): { changes: number } {
    const result = this.#db.prepare(sql).run(...params);
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
    status: row.status as ExecutionState,
    exitCode: row.exit_code === null ? null : Number(row.exit_code),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    stdout: row.stdout,
    stderr: row.stderr,
    policyVersion: row.policy_version,
    toolCallId: row.tool_call_id,
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
