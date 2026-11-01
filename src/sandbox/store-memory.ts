/**
 * In-memory `SandboxStore` for `STORE=memory`, the evaluation runner and tests.
 *
 * It implements the same compare-and-set semantics as the SQLite store, because
 * a test that passes against a weaker in-memory implementation proves nothing
 * about idempotency or state transitions. What it does *not* provide is crash
 * durability — that is the whole difference between the two, and the reason the
 * production default remains a file.
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
import { UNFINISHED_EXECUTION_STATES } from './state.ts';
import type {
  CreateExecutionResult,
  ExecutionTransitionPatch,
  SandboxStore,
} from './store.ts';

export class MemorySandboxStore implements SandboxStore {
  private readonly tasks = new Map<string, Task>();
  private readonly workspaces = new Map<string, Workspace>();
  private readonly checkpoints = new Map<string, WorkspaceCheckpoint[]>();
  private readonly sandboxes = new Map<string, Sandbox>();
  private readonly executions = new Map<string, Execution>();
  private readonly executionKeys = new Map<string, string>();
  private readonly events = new Map<string, ExecutionEvent[]>();
  private readonly approvals = new Map<string, ApprovalGrant>();
  private readonly policies = new Map<string, unknown>();
  private readonly audit: AuditEvent[] = [];

  async ensureTask(task: Task): Promise<Task> {
    const existing = this.tasks.get(task.taskId);
    if (existing) return { ...existing };
    this.tasks.set(task.taskId, { ...task });
    return { ...task };
  }

  async getTask(taskId: string): Promise<Task | null> {
    const task = this.tasks.get(taskId);
    return task ? { ...task } : null;
  }

  async getTaskBySession(sessionId: string): Promise<Task | null> {
    const tasks = [...this.tasks.values()]
      .filter((task) => task.sessionId === sessionId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return tasks[0] ? { ...tasks[0] } : null;
  }

  async updateTask(
    taskId: string,
    patch: Partial<Pick<Task, 'status' | 'sandboxId' | 'workspaceId'>>,
  ): Promise<Task | null> {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    const updated: Task = {
      ...task,
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.sandboxId === undefined ? {} : { sandboxId: patch.sandboxId }),
      ...(patch.workspaceId === undefined ? {} : { workspaceId: patch.workspaceId }),
      updatedAt: new Date().toISOString(),
    };
    this.tasks.set(taskId, updated);
    return { ...updated };
  }

  async saveWorkspace(workspace: Workspace): Promise<void> {
    const existing = this.workspaces.get(workspace.workspaceId);
    this.workspaces.set(workspace.workspaceId, {
      ...workspace,
      currentVersion: workspace.currentVersion || existing?.currentVersion || '',
    });
  }

  async getWorkspace(workspaceId: string): Promise<Workspace | null> {
    const workspace = this.workspaces.get(workspaceId);
    return workspace ? { ...workspace } : null;
  }

  async getWorkspaceForTask(taskId: string): Promise<Workspace | null> {
    const workspaces = [...this.workspaces.values()]
      .filter((workspace) => workspace.taskId === taskId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return workspaces[0] ? { ...workspaces[0] } : null;
  }

  async updateWorkspaceVersion(workspaceId: string, version: string, at: string): Promise<void> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return;
    this.workspaces.set(workspaceId, { ...workspace, currentVersion: version, updatedAt: at });
  }

  async deleteWorkspace(workspaceId: string): Promise<boolean> {
    this.checkpoints.delete(workspaceId);
    return this.workspaces.delete(workspaceId);
  }

  async saveCheckpoint(checkpoint: WorkspaceCheckpoint): Promise<void> {
    const list = this.checkpoints.get(checkpoint.workspaceId) ?? [];
    if (list.some((entry) => entry.checkpointId === checkpoint.checkpointId)) return;
    list.push({ ...checkpoint });
    this.checkpoints.set(checkpoint.workspaceId, list);
  }

  async listCheckpoints(workspaceId: string): Promise<WorkspaceCheckpoint[]> {
    return [...(this.checkpoints.get(workspaceId) ?? [])]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((entry) => ({ ...entry }));
  }

  async saveSandbox(sandbox: Sandbox): Promise<void> {
    this.sandboxes.set(sandbox.sandboxId, { ...sandbox });
  }

  async getSandbox(sandboxId: string): Promise<Sandbox | null> {
    const sandbox = this.sandboxes.get(sandboxId);
    return sandbox ? { ...sandbox } : null;
  }

  async getSandboxForTask(taskId: string): Promise<Sandbox | null> {
    const sandboxes = [...this.sandboxes.values()]
      .filter((sandbox) => sandbox.taskId === taskId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return sandboxes[0] ? { ...sandboxes[0] } : null;
  }

  async listSandboxes(statuses?: readonly SandboxStatus[]): Promise<Sandbox[]> {
    return [...this.sandboxes.values()]
      .filter((sandbox) => !statuses || statuses.length === 0 || statuses.includes(sandbox.status))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((sandbox) => ({ ...sandbox }));
  }

  async updateSandbox(
    sandboxId: string,
    patch: Partial<Pick<Sandbox, 'status' | 'runtimeId' | 'runtimeType' | 'lastHeartbeatAt'>>,
  ): Promise<Sandbox | null> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) return null;
    const updated: Sandbox = {
      ...sandbox,
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.runtimeId === undefined ? {} : { runtimeId: patch.runtimeId }),
      ...(patch.runtimeType === undefined ? {} : { runtimeType: patch.runtimeType }),
      ...(patch.lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt: patch.lastHeartbeatAt }),
      updatedAt: new Date().toISOString(),
    };
    this.sandboxes.set(sandboxId, updated);
    return { ...updated };
  }

  async touchSandboxHeartbeat(sandboxId: string, at: string): Promise<void> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (sandbox) this.sandboxes.set(sandboxId, { ...sandbox, lastHeartbeatAt: at });
  }

  async createExecution(execution: Execution): Promise<CreateExecutionResult> {
    const key = `${execution.sandboxId}\u0000${execution.idempotencyKey}`;
    const existingId = this.executionKeys.get(key);
    if (existingId) {
      return { execution: { ...(this.executions.get(existingId) as Execution) }, created: false };
    }
    this.executions.set(execution.executionId, { ...execution });
    this.executionKeys.set(key, execution.executionId);
    return { execution: { ...execution }, created: true };
  }

  async getExecution(executionId: string): Promise<Execution | null> {
    const execution = this.executions.get(executionId);
    return execution ? { ...execution } : null;
  }

  async findExecutionByKey(sandboxId: string, idempotencyKey: string): Promise<Execution | null> {
    const id = this.executionKeys.get(`${sandboxId}\u0000${idempotencyKey}`);
    return id ? this.getExecution(id) : null;
  }

  async listUnfinishedExecutions(sandboxId?: string): Promise<Execution[]> {
    return [...this.executions.values()]
      .filter(
        (execution) =>
          UNFINISHED_EXECUTION_STATES.includes(execution.status) &&
          (sandboxId === undefined || execution.sandboxId === sandboxId),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((execution) => ({ ...execution }));
  }

  async transitionExecution(
    executionId: string,
    from: readonly ExecutionState[],
    to: ExecutionState,
    patch: ExecutionTransitionPatch = {},
  ): Promise<Execution | null> {
    const execution = this.executions.get(executionId);
    if (!execution || !from.includes(execution.status)) return null;
    const updated: Execution = {
      ...execution,
      status: to,
      ...(patch.exitCode === undefined ? {} : { exitCode: patch.exitCode }),
      ...(patch.startedAt === undefined ? {} : { startedAt: patch.startedAt }),
      ...(patch.finishedAt === undefined ? {} : { finishedAt: patch.finishedAt }),
      ...(patch.stdout === undefined ? {} : { stdout: patch.stdout }),
      ...(patch.stderr === undefined ? {} : { stderr: patch.stderr }),
      updatedAt: new Date().toISOString(),
    };
    this.executions.set(executionId, updated);
    return { ...updated };
  }

  async appendEvent(event: ExecutionEvent): Promise<void> {
    const list = this.events.get(event.executionId) ?? [];
    list.push({ ...event, payload: structuredClone(event.payload) });
    this.events.set(event.executionId, list);
  }

  async listEvents(executionId: string): Promise<ExecutionEvent[]> {
    return (this.events.get(executionId) ?? []).map((event) => ({
      ...event,
      payload: structuredClone(event.payload),
    }));
  }

  async saveApproval(grant: ApprovalGrant): Promise<void> {
    if (!this.approvals.has(grant.approvalId)) this.approvals.set(grant.approvalId, { ...grant });
  }

  async getApproval(approvalId: string): Promise<ApprovalGrant | null> {
    const grant = this.approvals.get(approvalId);
    return grant ? { ...grant } : null;
  }

  async listApprovals(taskId: string, now: string): Promise<ApprovalGrant[]> {
    return [...this.approvals.values()]
      .filter(
        (grant) =>
          grant.taskId === taskId && grant.revokedAt === null && grant.expiresAt > now,
      )
      .map((grant) => ({ ...grant }));
  }

  async revokeApproval(approvalId: string, at: string): Promise<boolean> {
    const grant = this.approvals.get(approvalId);
    if (!grant || grant.revokedAt !== null) return false;
    this.approvals.set(approvalId, { ...grant, revokedAt: at });
    return true;
  }

  async savePolicy(version: string, _scope: string, configuration: unknown, _at: string): Promise<void> {
    void _scope;
    void _at;
    this.policies.set(version, structuredClone(configuration));
  }

  async getPolicy(version: string): Promise<unknown | null> {
    const configuration = this.policies.get(version);
    return configuration === undefined ? null : structuredClone(configuration);
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    this.audit.push({ ...event, detail: structuredClone(event.detail) });
  }

  async listAudit(limit = 100): Promise<AuditEvent[]> {
    return this.audit
      .slice(-Math.min(Math.max(limit, 1), 1_000))
      .reverse()
      .map((event) => ({ ...event, detail: structuredClone(event.detail) }));
  }
}
