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
import { isPendingPermissionRequest } from './permissions/state.ts';
import type {
  HumanApprovalRecord,
  HumanApprovalStatus,
  PermissionDecision,
  PermissionPolicyRecord,
  PermissionRequestRecord,
  PermissionRequestStatus,
  PermissionScopeLevel,
} from './permissions/types.ts';
import type {
  CreateExecutionResult,
  CreatePermissionRequestResult,
  ExecutionTransitionPatch,
  GrantFilter,
  HumanApprovalPatch,
  PermissionRequestPatch,
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
  private readonly permissionPolicies = new Map<string, PermissionPolicyRecord[]>();
  private readonly permissionRequests = new Map<string, PermissionRequestRecord>();
  private readonly humanApprovals = new Map<string, HumanApprovalRecord>();
  private readonly permissionDecisions = new Map<string, PermissionDecision>();
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
    patch: Partial<
      Pick<Sandbox, 'status' | 'runtimeId' | 'runtimeType' | 'lastHeartbeatAt' | 'configDigest'>
    >,
  ): Promise<Sandbox | null> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) return null;
    const updated: Sandbox = {
      ...sandbox,
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.runtimeId === undefined ? {} : { runtimeId: patch.runtimeId }),
      ...(patch.runtimeType === undefined ? {} : { runtimeType: patch.runtimeType }),
      ...(patch.lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt: patch.lastHeartbeatAt }),
      ...(patch.configDigest === undefined ? {} : { configDigest: patch.configDigest }),
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
    this.approvals.set(approvalId, { ...grant, revokedAt: at, status: 'revoked' });
    return true;
  }

  async listGrants(filter: GrantFilter): Promise<ApprovalGrant[]> {
    return [...this.approvals.values()]
      .filter((grant) => {
        if (filter.taskId !== undefined && grant.taskId !== filter.taskId) return false;
        if (filter.sessionId !== undefined && grant.sessionId !== filter.sessionId) return false;
        if (filter.requestId !== undefined && grant.requestId !== filter.requestId) return false;
        if (
          filter.approvalRequestId !== undefined &&
          grant.approvalRequestId !== filter.approvalRequestId
        ) {
          return false;
        }
        return true;
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((grant) => ({ ...grant }));
  }

  async markGrantUsed(grantId: string, at: string): Promise<boolean> {
    const grant = this.approvals.get(grantId);
    if (!grant || grant.usedAt) return false;
    this.approvals.set(grantId, { ...grant, usedAt: at });
    return true;
  }

  async setGrantStatus(
    grantId: string,
    status: 'active' | 'revoked' | 'expired',
    at: string,
  ): Promise<boolean> {
    const grant = this.approvals.get(grantId);
    if (!grant) return false;
    this.approvals.set(grantId, {
      ...grant,
      status,
      ...(status === 'revoked' ? { revokedAt: at } : {}),
    });
    return true;
  }

  // ---------------------------------------------------- permission policies ---

  async savePermissionPolicy(record: PermissionPolicyRecord): Promise<void> {
    const key = `${record.scopeType}\u0000${record.scopeId}`;
    const list = this.permissionPolicies.get(key) ?? [];
    const index = list.findIndex((entry) => entry.version === record.version);
    const copy = {
      ...record,
      rules: record.rules.map((rule) => ({ ...rule })),
      autoReview: { ...record.autoReview },
      approval: { ...record.approval },
      restricted: {
        ...record.restricted,
        filesystem: { ...record.restricted.filesystem },
        network: { ...record.restricted.network },
      },
    };
    if (index >= 0) list[index] = copy;
    else list.push(copy);
    this.permissionPolicies.set(key, list);
  }

  async getPermissionPolicy(
    scopeType: PermissionScopeLevel,
    scopeId: string,
    version: number,
  ): Promise<PermissionPolicyRecord | null> {
    const list = this.permissionPolicies.get(`${scopeType}\u0000${scopeId}`) ?? [];
    const found = list.find((entry) => entry.version === version);
    return found ? clonePermissionPolicy(found) : null;
  }

  async latestPermissionPolicy(
    scopeType: PermissionScopeLevel,
    scopeId: string,
  ): Promise<PermissionPolicyRecord | null> {
    const list = this.permissionPolicies.get(`${scopeType}\u0000${scopeId}`) ?? [];
    const latest = [...list].sort((left, right) => right.version - left.version)[0];
    return latest ? clonePermissionPolicy(latest) : null;
  }

  async listPermissionPolicies(
    scopeType: PermissionScopeLevel,
    scopeId: string,
  ): Promise<PermissionPolicyRecord[]> {
    return (this.permissionPolicies.get(`${scopeType}\u0000${scopeId}`) ?? [])
      .slice()
      .sort((left, right) => right.version - left.version)
      .map(clonePermissionPolicy);
  }

  // ----------------------------------------------------- permission requests ---

  async createPermissionRequest(
    request: PermissionRequestRecord,
  ): Promise<CreatePermissionRequestResult> {
    const existing = this.permissionRequests.get(request.requestId);
    if (existing) return { request: cloneRequest(existing), created: false };
    this.permissionRequests.set(request.requestId, cloneRequest(request));
    return { request: cloneRequest(request), created: true };
  }

  async getPermissionRequest(requestId: string): Promise<PermissionRequestRecord | null> {
    const request = this.permissionRequests.get(requestId);
    return request ? cloneRequest(request) : null;
  }

  async findOpenPermissionRequest(requestKey: string): Promise<PermissionRequestRecord | null> {
    const open = [...this.permissionRequests.values()]
      .filter((request) => request.requestKey === requestKey && isPendingPermissionRequest(request.status))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return open[0] ? cloneRequest(open[0]) : null;
  }

  async updatePermissionRequest(
    requestId: string,
    from: readonly PermissionRequestStatus[],
    to: PermissionRequestStatus,
    patch: PermissionRequestPatch = {},
  ): Promise<PermissionRequestRecord | null> {
    const current = this.permissionRequests.get(requestId);
    if (!current || !from.includes(current.status)) return null;
    const updated: PermissionRequestRecord = {
      ...current,
      status: to,
      ...(patch.reason === undefined ? {} : { reason: patch.reason }),
      ...(patch.riskLevel === undefined ? {} : { riskLevel: patch.riskLevel }),
      ...(patch.decisionId === undefined ? {} : { decisionId: patch.decisionId }),
      ...(patch.grantId === undefined ? {} : { grantId: patch.grantId }),
      ...(patch.approvalRequestId === undefined ? {} : { approvalRequestId: patch.approvalRequestId }),
      ...(patch.autoReview === undefined ? {} : { autoReview: patch.autoReview }),
      ...(patch.executionId === undefined ? {} : { executionId: patch.executionId }),
      updatedAt: new Date().toISOString(),
    };
    this.permissionRequests.set(requestId, updated);
    return cloneRequest(updated);
  }

  async listPermissionRequests(filter: {
    readonly taskId?: string;
    readonly sessionId?: string;
    readonly statuses?: readonly PermissionRequestStatus[];
    readonly limit?: number;
  } = {}): Promise<PermissionRequestRecord[]> {
    const limit = filter.limit ?? 200;
    return [...this.permissionRequests.values()]
      .filter((request) => {
        if (filter.taskId !== undefined && request.taskId !== filter.taskId) return false;
        if (filter.sessionId !== undefined && request.sessionId !== filter.sessionId) return false;
        if (filter.statuses && !filter.statuses.includes(request.status)) return false;
        return true;
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, Math.max(1, limit))
      .map(cloneRequest);
  }

  // --------------------------------------------------------- human approvals ---

  async createHumanApproval(record: HumanApprovalRecord): Promise<HumanApprovalRecord> {
    const existing = this.humanApprovals.get(record.approvalRequestId);
    if (existing) return { ...existing };
    this.humanApprovals.set(record.approvalRequestId, { ...record });
    return { ...record };
  }

  async getHumanApproval(approvalRequestId: string): Promise<HumanApprovalRecord | null> {
    const record = this.humanApprovals.get(approvalRequestId);
    return record ? { ...record } : null;
  }

  async listHumanApprovals(filter: {
    readonly taskId?: string;
    readonly requestId?: string;
    readonly statuses?: readonly HumanApprovalStatus[];
    readonly limit?: number;
  } = {}): Promise<HumanApprovalRecord[]> {
    const limit = filter.limit ?? 200;
    return [...this.humanApprovals.values()]
      .filter((approval) => {
        if (filter.taskId !== undefined && approval.taskId !== filter.taskId) return false;
        if (filter.requestId !== undefined && approval.requestId !== filter.requestId) return false;
        if (filter.statuses && !filter.statuses.includes(approval.status)) return false;
        return true;
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, Math.max(1, limit))
      .map((approval) => ({ ...approval }));
  }

  async decideHumanApproval(
    approvalRequestId: string,
    from: readonly HumanApprovalStatus[],
    to: HumanApprovalStatus,
    patch: HumanApprovalPatch = {},
  ): Promise<HumanApprovalRecord | null> {
    const current = this.humanApprovals.get(approvalRequestId);
    if (!current || !from.includes(current.status)) return null;
    const updated: HumanApprovalRecord = {
      ...current,
      status: to,
      ...(patch.decidedBy === undefined ? {} : { decidedBy: patch.decidedBy }),
      ...(patch.decisionReason === undefined ? {} : { decisionReason: patch.decisionReason }),
      ...(patch.decidedAt === undefined ? {} : { decidedAt: patch.decidedAt }),
      ...(patch.scope === undefined ? {} : { scope: patch.scope }),
    };
    this.humanApprovals.set(approvalRequestId, updated);
    return { ...updated };
  }

  // ---------------------------------------------------- permission decisions ---

  async savePermissionDecision(decision: PermissionDecision): Promise<void> {
    if (!this.permissionDecisions.has(decision.decisionId)) {
      this.permissionDecisions.set(decision.decisionId, { ...decision });
    }
  }

  async getPermissionDecision(decisionId: string): Promise<PermissionDecision | null> {
    const decision = this.permissionDecisions.get(decisionId);
    return decision ? { ...decision } : null;
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

function cloneRequest(request: PermissionRequestRecord): PermissionRequestRecord {
  return {
    ...request,
    resourceScope: [...request.resourceScope],
    autoReview: request.autoReview ? { ...request.autoReview } : null,
  };
}

function clonePermissionPolicy(record: PermissionPolicyRecord): PermissionPolicyRecord {
  return {
    ...record,
    rules: record.rules.map((rule) => ({
      ...rule,
      action: [...rule.action],
      resource: { ...rule.resource, patterns: [...rule.resource.patterns] },
      ...(rule.conditions
        ? {
            conditions: {
              ...rule.conditions,
              ...(rule.conditions.riskLevel ? { riskLevel: [...rule.conditions.riskLevel] } : {}),
              ...(rule.conditions.environment ? { environment: [...rule.conditions.environment] } : {}),
              ...(rule.conditions.taskType ? { taskType: [...rule.conditions.taskType] } : {}),
            },
          }
        : {}),
    })),
    autoReview: {
      ...record.autoReview,
      allowedRiskLevels: [...record.autoReview.allowedRiskLevels],
    },
    approval: {
      ...record.approval,
      requireHumanForRiskLevels: [...record.approval.requireHumanForRiskLevels],
    },
    restricted: {
      allowedTools: [...record.restricted.allowedTools],
      filesystem: {
        read: [...record.restricted.filesystem.read],
        write: [...record.restricted.filesystem.write],
      },
      network: {
        ...record.restricted.network,
        allowedDomains: [...record.restricted.network.allowedDomains],
        allowedPorts: [...record.restricted.network.allowedPorts],
      },
    },
  };
}
