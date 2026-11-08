/**
 * The Sandbox Gateway: the only entry point for tool execution.
 *
 * Responsibilities (ADR §7):
 *
 *   - validate the request and the sandbox/task ownership;
 *   - decide with the Permission Manager *before* anything runs;
 *   - create an Execution with an idempotency key and persist it;
 *   - route the command to the Controller, never to a host process;
 *   - record every state transition and every event;
 *   - map the runtime result without ever turning `UNKNOWN` into `FAILED`.
 *
 * The Gateway also fronts the file tools. They are not commands, but they are
 * still the agent touching a filesystem, and keeping them behind the same
 * authorization and audit path means there is one place to answer "what did the
 * agent do to this workspace?".
 *
 * There is no method here that accepts a host path, an image tag, a mount or a
 * runtime argument. The only host path in the system is resolved by the
 * Workspace Manager from operator configuration.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { SandboxStore } from './store.ts';
import type {
  ApprovalGrant,
  CreateSandboxInput,
  Execution,
  ExecutionEvent,
  ExecutionResult,
  ExecutionState,
  ExecuteInput,
  Sandbox,
  SandboxStatusSnapshot,
  Task,
  Workspace,
  WorkspaceCheckpoint,
} from './types.ts';
import { WORKSPACE_MOUNT_PATH, resourceProfile } from './types.ts';
import {
  ACTIVE_SANDBOX_STATES,
  canTransitionExecution,
  executionOutcome,
  isTerminalExecution,
} from './state.ts';
import type { SandboxController, RuntimeConfigResolver } from './controller.ts';
import type { SandboxContext } from './context.ts';
import { GatewayFileOperations, type WorkspaceFilesPort } from './gateway-files.ts';
import { assertId } from './ids.ts';
import type { WorkspaceManager } from './workspace-manager.ts';
import type { WorkspaceChangeRecorder } from './workspace-changes.ts';
import type { AuditLog, SandboxMetrics } from './audit.ts';
import type { CredentialBroker } from './credentials.ts';
import type { SandboxSettings } from './config.ts';
import {
  compileRuntimeConfig,
  minResourceLimits,
  normalizeContainerPath,
  taskPolicy,
} from './policy.ts';
import { PermissionManager } from './permissions/permission-manager.ts';
import type {
  ApprovalScopeLevel,
  EffectivePermissionPolicy,
  HumanApprovalRecord,
  PermissionAction,
  PermissionEvaluationRequest,
  PermissionMode,
  PermissionPolicyRecord,
  PermissionRequestRecord,
  PermissionScopeLevel,
} from './permissions/types.ts';
import type { ScopePolicyOverrides } from './permissions/policy.ts';
import { Redactor } from './redact.ts';
import {
  SandboxApprovalRequiredError,
  SandboxConflictError,
  SandboxNotFoundError,
  SandboxPolicyError,
  SandboxQuotaError,
  SandboxError,
} from './errors.ts';
import { sandboxContainerName } from './runtime/oci-args.ts';
import { CwdManager } from './cwd/cwd-manager.ts';
import { FilesystemCwdValidator } from './cwd/cwd-validator.ts';
import { TaskContextStore } from './cwd/task-context-store.ts';
import { CwdError, type ChangeDirectoryInput } from './cwd/cwd-types.ts';
import type { ToolCwdChange, ToolCwdSnapshot } from '../tools/types.ts';

export interface SandboxGatewayDeps {
  readonly store: SandboxStore;
  readonly controller: SandboxController;
  readonly workspaces: WorkspaceManager;
  readonly audit: AuditLog;
  readonly metrics: SandboxMetrics;
  readonly credentials: CredentialBroker;
  readonly settings: SandboxSettings;
  readonly now?: () => Date;
  /** Shared by the audit log, the credential broker and this gateway. */
  readonly redactor?: Redactor;
  /** Optional turn-scoped undo recorder (ADR 036). */
  readonly changes?: WorkspaceChangeRecorder;
}

export type { SandboxContext };

/** Options for one execute call beyond the public `ExecuteInput`. */
export interface ExecuteOptions {
  readonly signal?: AbortSignal;
}

const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_IDEMPOTENCY_KEY = 200;

export class SandboxGateway {
  private readonly store: SandboxStore;
  private readonly controller: SandboxController;
  private readonly workspaces: WorkspaceManager;
  private readonly audit: AuditLog;
  private readonly metrics: SandboxMetrics;
  private readonly credentials: CredentialBroker;
  private readonly settings: SandboxSettings;
  private changes: WorkspaceChangeRecorder | null;
  private readonly now: () => Date;
  /** The deployment's structural policy; the permission layer narrows it. */
  private readonly policy: ReturnType<typeof taskPolicy>;
  private readonly permissions: PermissionManager;
  /** ADR 021: the single reader/writer of the task working directory. */
  private readonly taskContexts: TaskContextStore;
  private readonly cwdManager: CwdManager;
  private readonly redactor: Redactor;
  /** File tools; a collaborator rather than another two hundred lines here. */
  private readonly fileOps: GatewayFileOperations;
  /** Executions currently inside the runtime, per sandbox. */
  private readonly inFlight = new Map<string, number>();

  constructor(deps: SandboxGatewayDeps) {
    this.store = deps.store;
    this.controller = deps.controller;
    this.workspaces = deps.workspaces;
    this.audit = deps.audit;
    this.metrics = deps.metrics;
    this.credentials = deps.credentials;
    this.settings = deps.settings;
    this.changes = deps.changes ?? null;
    this.now = deps.now ?? (() => new Date());
    this.policy = taskPolicy({
      resourcesProfile: 'default',
      networkMode: deps.settings.network.mode,
      allowedDomains: deps.settings.network.allowedDomains,
      allowedPorts: deps.settings.network.allowedPorts,
      deniedTools: deps.settings.deniedTools,
      runtimeClass: deps.settings.runtime.runtimeClass,
      requireGvisor: deps.settings.runtime.requireGvisor,
      resources: deps.settings.resources,
    });
    this.permissions = new PermissionManager({
      store: deps.store,
      audit: deps.audit,
      metrics: deps.metrics,
      settings: deps.settings,
      deploymentPolicy: this.policy,
      now: this.now,
      onPolicyChanged: (input) => this.onPermissionPolicyChanged(input),
    });
    this.taskContexts = new TaskContextStore({
      store: deps.store,
      now: this.now,
      audit: deps.audit,
    });
    this.cwdManager = new CwdManager({
      store: deps.store,
      contexts: this.taskContexts,
      validator: new FilesystemCwdValidator(),
      permissions: this.permissions,
      audit: deps.audit,
      metrics: deps.metrics,
      now: this.now,
    });
    this.redactor = deps.redactor ?? new Redactor();
    // Credential values are known only after issuance; the audit log has its own
    // redactor, and new values are registered there by the broker's caller.
    for (const secret of deps.credentials.secrets()) this.redactor.addSecret(secret);
    this.fileOps = new GatewayFileOperations({
      store: deps.store,
      workspaces: deps.workspaces,
      permissions: this.permissions,
      audit: deps.audit,
      metrics: deps.metrics,
      settings: deps.settings,
    });
  }

  // ------------------------------------------------------------------ tasks ---

  /**
   * Ensure the durable task, workspace and ownership for a conversation.
   *
   * The task id is the conversation id. It arrives from the server's own session
   * object, never from a tool call, which is the ownership check: a model cannot
   * name someone else's task because it never names a task at all.
   */
  async ensureTask(input: {
    readonly taskId: string;
    readonly sessionId: string;
    readonly userId: string;
  }): Promise<Task> {
    assertId('task id', input.taskId);
    const existing = await this.store.getTask(input.taskId);
    if (existing) {
      if (existing.userId !== input.userId) {
        throw new SandboxPolicyError('task belongs to a different user');
      }
      const workspace = await this.workspaces.ensureForTask(input.taskId);
      const refreshed = existing.workspaceId !== workspace.workspaceId
        ? await this.store.updateTask(existing.taskId, { workspaceId: workspace.workspaceId })
        : existing;
      // Backfill a task that predates ADR 021, without moving an existing cwd.
      await this.taskContexts.initialize({
        taskId: existing.taskId,
        workspaceId: workspace.workspaceId,
        sandboxId: refreshed?.sandboxId ?? existing.sandboxId,
        workspaceRoot: refreshed?.workspaceRoot ?? WORKSPACE_MOUNT_PATH,
        now: this.now().toISOString(),
      });
      return (await this.store.getTask(existing.taskId)) ?? refreshed ?? existing;
    }

    // `sandbox_workspaces.task_id` is a foreign key to `sandbox_tasks`, so the
    // task must exist *before* the workspace row is written. The placeholder
    // workspace id is immediately replaced; it is not observable to callers.
    const at = this.now().toISOString();
    const task: Task = {
      taskId: input.taskId,
      sessionId: input.sessionId,
      userId: input.userId,
      status: 'ACTIVE',
      workspaceId: '',
      sandboxId: null,
      createdAt: at,
      updatedAt: at,
    };
    const created = await this.store.ensureTask(task);
    const workspace = await this.workspaces.ensureForTask(input.taskId);
    const ready = await this.store.updateTask(created.taskId, {
      workspaceId: workspace.workspaceId,
    });
    if (!ready) throw new SandboxError('not_found', `task ${input.taskId} disappeared during creation`);
    // ADR 021 §8.1: the context exists before any tool is registered. The store
    // write inside `initialize` is what sets the cwd columns, so the returned
    // task is re-read rather than the placeholder row.
    await this.taskContexts.initialize({
      taskId: ready.taskId,
      workspaceId: workspace.workspaceId,
      sandboxId: ready.sandboxId,
      workspaceRoot: ready.workspaceRoot ?? WORKSPACE_MOUNT_PATH,
      now: this.now().toISOString(),
    });
    await this.audit.record({
      taskId: ready.taskId,
      sessionId: input.sessionId,
      action: 'task.create',
      outcome: 'succeeded',
      detail: { workspace: workspace.workspaceId, mode: workspace.mode },
    });
    return (await this.store.getTask(ready.taskId)) ?? ready;
  }

  /** Get (or create) the task's sandbox with the deployment's defaults. */
  async ensureSandbox(context: SandboxContext): Promise<Sandbox> {
    const task = await this.loadTask(context);
    const existing = await this.store.getSandboxForTask(task.taskId);
    if (existing && existing.status !== 'DESTROYED') return existing;
    // A conversation that has been idle still owns a running container, and
    // those idle containers count against the per-user/per-deployment quota. A
    // third conversation would otherwise be refused before its command starts
    // (the "sandbox limit reached" path). Reclaim only when actually blocked, so
    // a normal create never touches another task's runtime.
    await this.reclaimIdleSandboxesForCapacity(task);
    return this.create(
      {
        taskId: task.taskId,
        workspaceId: task.workspaceId,
        imageDigest: this.settings.imageDigest,
        policyVersion: this.settings.policyVersion,
        resourceProfile: 'default',
      },
      context,
    );
  }

  // --------------------------------------------------------------- lifecycle ---

  async create(input: CreateSandboxInput, context?: SandboxContext): Promise<Sandbox> {
    const task = await this.loadTask({ taskId: input.taskId, ...(context ?? {}) });
    if (context?.userId && context.userId !== task.userId) {
      throw new SandboxPolicyError('task belongs to a different user');
    }
    if (input.workspaceId !== task.workspaceId) {
      throw new SandboxPolicyError('workspace is not bound to this task');
    }
    if (input.imageDigest !== this.settings.imageDigest) {
      throw new SandboxPolicyError('the requested image is not the operator-configured sandbox image');
    }
    if (input.policyVersion !== this.settings.policyVersion) {
      throw new SandboxPolicyError(`unknown policy version ${input.policyVersion}`);
    }
    if (input.resourceProfile !== 'default' && !['small', 'default', 'large'].includes(input.resourceProfile)) {
      throw new SandboxPolicyError(`unknown resource profile ${input.resourceProfile}`);
    }

    const existing = await this.store.getSandboxForTask(task.taskId);
    if (existing && existing.status !== 'DESTROYED' && existing.status !== 'FAILED') {
      return existing;
    }

    await this.assertCapacity(task);

    const workspace = await this.store.getWorkspace(task.workspaceId);
    if (!workspace) throw new SandboxNotFoundError(`workspace ${task.workspaceId} does not exist`);
    if (workspace.mode === 'copy' && workspace.taskId !== task.taskId) {
      throw new SandboxPolicyError('workspace belongs to a different task');
    }
    // In bind mode one project directory is shared by every task on this
    // single-tenant deployment; the sandbox identity is still task-scoped.

    const at = this.now().toISOString();
    const sandboxId = `sbx_${randomUUID()}`;
    const sandbox: Sandbox = {
      sandboxId,
      taskId: task.taskId,
      runtimeType: this.controller.runtimeType,
      runtimeId: sandboxContainerName(sandboxId),
      imageDigest: input.imageDigest,
      workspaceId: workspace.workspaceId,
      policyVersion: input.policyVersion,
      resourceProfile: input.resourceProfile,
      status: 'CREATING',
      createdAt: at,
      lastHeartbeatAt: null,
      updatedAt: at,
    };
    await this.store.saveSandbox(sandbox);
    await this.store.savePolicy(input.policyVersion, 'task', this.policy, at);

    try {
      const config = await this.runtimeConfig(sandbox, workspace, true);
      const created = await this.controller.create(sandbox, config);
      await this.store.updateTask(task.taskId, { sandboxId: created.sandboxId });
      return created;
    } catch (error) {
      await this.audit.record({
        taskId: task.taskId,
        sandboxId,
        policyVersion: sandbox.policyVersion,
        action: 'sandbox.create',
        outcome: 'failed',
        detail: { error: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
  }

  async inspect(sandboxId: string): Promise<SandboxStatusSnapshot> {
    const sandbox = await this.requireSandbox(sandboxId);
    const runtime = await this.controller.inspect(sandbox);
    return {
      sandboxId: sandbox.sandboxId,
      taskId: sandbox.taskId,
      status: sandbox.status,
      runtimeType: sandbox.runtimeType,
      runtimeId: sandbox.runtimeId,
      imageDigest: sandbox.imageDigest,
      workspaceId: sandbox.workspaceId,
      lastHeartbeatAt: sandbox.lastHeartbeatAt,
      runtimeAlive: runtime.exists && runtime.running,
      detail: runtime.detail,
    };
  }

  async interrupt(context: SandboxContext, sandboxId: string, executionId: string): Promise<void> {
    const task = await this.loadTask(context);
    const sandbox = await this.requireSandbox(sandboxId);
    if (sandbox.taskId !== task.taskId) throw new SandboxPolicyError('sandbox belongs to a different task');
    const execution = await this.store.getExecution(executionId);
    if (!execution || execution.sandboxId !== sandbox.sandboxId) {
      throw new SandboxNotFoundError(`execution ${executionId} does not exist in this sandbox`);
    }
    if (!isTerminalExecution(execution.status)) {
      const cancelled = await this.store.transitionExecution(
        executionId,
        ['CREATED', 'AUTHORIZED', 'SUBMITTED', 'RUNNING', 'INTERRUPTED', 'RECONCILING', 'RETRYABLE'],
        'CANCELLED',
        { finishedAt: this.now().toISOString() },
      );
      if (cancelled) {
        await this.appendEvent(cancelled, 'execution/interrupted', { by: 'operator' });
      }
    }
    await this.controller.interrupt(sandbox, executionId);
  }

  async recover(context: SandboxContext, sandboxId: string): Promise<SandboxStatusSnapshot> {
    const task = await this.loadTask(context);
    const sandbox = await this.requireSandbox(sandboxId);
    if (sandbox.taskId !== task.taskId) throw new SandboxPolicyError('sandbox belongs to a different task');
    const workspace = await this.store.getWorkspace(sandbox.workspaceId);
    if (!workspace) throw new SandboxNotFoundError('workspace is missing');
    const config = await this.runtimeConfig(sandbox, workspace, true);
    await this.controller.recover(sandbox, config);
    // The runtime is back, so "does the directory still exist" is a real
    // question again (ADR 021 §11.4). This never repairs by substituting `/`.
    await this.recoverDirectory({ taskId: task.taskId, userId: context.userId });
    for (const execution of await this.store.listUnfinishedExecutions(sandbox.sandboxId)) {
      await this.reconcileExecution(sandbox.sandboxId, execution.executionId);
    }
    await this.permissions.sweep().catch(() => undefined);
    return this.inspect(sandbox.sandboxId);
  }

  async destroy(context: SandboxContext, sandboxId: string): Promise<void> {
    const task = await this.loadTask(context);
    const sandbox = await this.requireSandbox(sandboxId);
    if (sandbox.taskId !== task.taskId) throw new SandboxPolicyError('sandbox belongs to a different task');
    // A destroyed runtime takes its marker with it. Any execution still open is
    // therefore unknowable, not failed.
    for (const execution of await this.store.listUnfinishedExecutions(sandbox.sandboxId)) {
      const neverSubmitted = execution.status === 'CREATED' || execution.status === 'AUTHORIZED';
      const closed = await this.store.transitionExecution(
        execution.executionId,
        ['CREATED', 'AUTHORIZED', 'SUBMITTED', 'RUNNING', 'INTERRUPTED', 'RECONCILING'],
        neverSubmitted ? 'FAILED' : 'UNKNOWN',
        { finishedAt: this.now().toISOString() },
      );
      if (closed) {
        await this.appendEvent(closed, 'execution/reconciled', {
          method: neverSubmitted ? 'never-submitted' : 'sandbox-destroyed',
          detail: neverSubmitted
            ? 'the command was never submitted'
            : 'runtime was destroyed before the outcome was observed',
        });
      }
    }
    await this.controller.destroy(sandbox);
    await this.store.updateTask(task.taskId, { sandboxId: null });
    // Pending requests, approvals and grants die with the task. A grant that
    // outlived its task would be a permission nobody can see the reason for.
    await this.permissions.cancelTask(task.taskId, 'task destroyed').catch(() => undefined);
  }

  /**
   * Record a scoped approval grant.
   *
   * This is the operator-facing half of `APPROVAL_REQUIRED`: a chat turn cannot
   * ask mid-stream, so a person grants one action on one scope for a bounded
   * time before the turn. The grant names the policy version in force here.
   */
  async approve(
    context: SandboxContext,
    input: {
      readonly action: PermissionAction;
      readonly resourceScope?: readonly string[];
      readonly ttlMs?: number;
      readonly approvedBy?: string;
    },
  ): Promise<ApprovalGrant> {
    const task = await this.loadTask(context);
    const ttl = Math.min(Math.max(input.ttlMs ?? 10 * 60_000, 1_000), 24 * 60 * 60_000);
    const scope = (input.resourceScope ?? [WORKSPACE_MOUNT_PATH]).map((entry) =>
      normalizeContainerPath(entry),
    );
    if (scope.length === 0) throw new SandboxPolicyError('approval scope must not be empty');
    const grant = await this.permissions.createOperatorGrant({
      taskId: task.taskId,
      sessionId: task.sessionId,
      sandboxId: task.sandboxId,
      action: input.action,
      resourceScope: scope,
      ttlMs: ttl,
      approvedBy: input.approvedBy?.trim() || this.settings.permission.operatorId,
    });
    await this.audit.record({
      taskId: task.taskId,
      sessionId: context.sessionId ?? null,
      approvalId: grant.approvalId,
      policyVersion: grant.policyVersion,
      action: 'approval.grant',
      outcome: 'allowed',
      detail: { action: grant.action, scope, expires_at: grant.expiresAt },
    });
    return grant;
  }

  /** Revoke an approval grant; the next request it covered needs a new one. */
  async revokeApproval(context: SandboxContext, approvalId: string): Promise<boolean> {
    const task = await this.loadTask(context);
    const grant = await this.store.getApproval(approvalId);
    if (!grant || grant.taskId !== task.taskId) {
      throw new SandboxNotFoundError(`approval ${approvalId} does not exist for this task`);
    }
    const revoked = await this.permissions.revokeGrant(
      approvalId,
      context.userId ?? this.settings.permission.operatorId,
    );
    if (revoked) {
      await this.audit.record({
        taskId: task.taskId,
        sessionId: context.sessionId ?? null,
        approvalId,
        policyVersion: grant.policyVersion,
        action: 'approval.revoke',
        outcome: 'allowed',
        detail: { action: grant.action, scope: grant.resourceScope },
      });
    }
    return revoked;
  }

  // -------------------------------------------------------------- permission ---

  /**
   * Change a permission mode (or extend a restricted allow-list) at a scope.
   *
   * This is a trusted control-plane operation: the CLI and the loopback-only
   * local UI call it. No tool reaches it, and the HTTP route that does is gated
   * by a per-process token the page receives from this server. The policy
   * version bump invalidates grants from the old policy and marks affected
   * containers for rebuild.
   */
  async setPermissionPolicy(input: {
    readonly scopeType: 'session' | 'task' | 'sandbox';
    readonly scopeId: string;
    readonly mode?: PermissionMode;
    readonly ttlMs?: number;
    readonly actor: string;
    readonly overrides?: ScopePolicyOverrides;
  }): Promise<PermissionPolicyRecord> {
    return this.permissions.setMode(input);
  }

  async effectivePermissionPolicy(
    taskId: string,
    sessionId: string,
    sandboxId: string | null = null,
  ): Promise<EffectivePermissionPolicy> {
    return this.permissions.effectivePolicy(taskId, sessionId, sandboxId);
  }

  async permissionStatus(context: SandboxContext): Promise<Record<string, unknown>> {
    const task = await this.loadTask(context);
    return this.permissions.status({
      taskId: task.taskId,
      sessionId: task.sessionId,
      sandboxId: task.sandboxId,
    });
  }

  async listPermissionRequests(context: SandboxContext): Promise<readonly PermissionRequestRecord[]> {
    const task = await this.loadTask(context);
    return this.permissions.listRequests(task.taskId);
  }

  /**
   * One approval queue entry by id, without needing to know its task first.
   *
   * The local control surface approves by id — the id is what the tool error
   * reported — so requiring a task id as well would make the caller guess. The
   * caller still has to prove it owns the task the approval belongs to.
   */
  async getPermissionApproval(approvalRequestId: string): Promise<HumanApprovalRecord | null> {
    return this.store.getHumanApproval(approvalRequestId);
  }

  async listPermissionApprovals(context: SandboxContext): Promise<readonly HumanApprovalRecord[]> {
    const task = await this.loadTask(context);
    return this.permissions.listApprovals(task.taskId);
  }

  async listPermissionGrants(context: SandboxContext): Promise<readonly ApprovalGrant[]> {
    const task = await this.loadTask(context);
    return this.permissions.listGrants(task.taskId, task.sessionId);
  }

  /** Approve one queued permission request. The approver must not be the agent. */
  async approvePermissionRequest(
    context: SandboxContext,
    input: {
      readonly approvalRequestId: string;
      readonly decidedBy: string;
      readonly scope?: ApprovalScopeLevel;
      readonly ttlSeconds?: number;
      readonly reason?: string;
    },
  ): Promise<{ approval: HumanApprovalRecord; grantId: string | null }> {
    const task = await this.loadTask(context);
    const approval = await this.store.getHumanApproval(input.approvalRequestId);
    if (!approval || approval.taskId !== task.taskId) {
      throw new SandboxNotFoundError(`approval ${input.approvalRequestId} does not exist for this task`);
    }
    return this.permissions.approve({
      approvalRequestId: input.approvalRequestId,
      decision: 'approve',
      decidedBy: input.decidedBy,
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.ttlSeconds ? { ttlSeconds: input.ttlSeconds } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    });
  }

  async denyPermissionRequest(
    context: SandboxContext,
    input: {
      readonly approvalRequestId: string;
      readonly decidedBy: string;
      readonly reason?: string;
    },
  ): Promise<HumanApprovalRecord> {
    const task = await this.loadTask(context);
    const approval = await this.store.getHumanApproval(input.approvalRequestId);
    if (!approval || approval.taskId !== task.taskId) {
      throw new SandboxNotFoundError(`approval ${input.approvalRequestId} does not exist for this task`);
    }
    return this.permissions.deny({
      approvalRequestId: input.approvalRequestId,
      decision: 'deny',
      decidedBy: input.decidedBy,
      ...(input.reason ? { reason: input.reason } : {}),
    });
  }

  /** Expire stale requests, approvals and grants. Called by `gc` and recovery. */
  async sweepPermissions(): Promise<Awaited<ReturnType<PermissionManager['sweep']>>> {
    return this.permissions.sweep();
  }

  /** Create a workspace checkpoint independent of the sandbox lifecycle. */
  async checkpoint(
    context: SandboxContext,
    sourceExecutionId: string | null = null,
  ): Promise<WorkspaceCheckpoint> {
    const task = await this.loadTask(context);
    const workspace = await this.store.getWorkspace(task.workspaceId);
    if (!workspace) throw new SandboxNotFoundError('workspace is missing');
    const checkpoint = await this.workspaces.createCheckpoint(workspace, sourceExecutionId);
    await this.audit.record({
      taskId: task.taskId,
      sessionId: context.sessionId ?? null,
      action: 'workspace.checkpoint',
      outcome: 'succeeded',
      detail: {
        checkpoint_id: checkpoint.checkpointId,
        workspace_id: workspace.workspaceId,
        content_digest: checkpoint.contentDigest,
      },
    });
    return checkpoint;
  }

  /**
   * Expire idle sandboxes and prune old checkpoints.
   *
   * Idle expiry destroys the runtime but never the workspace: the next tool call
   * rebuilds a sandbox against the same files, which is exactly the recovery path
   * the integration test exercises.
   */
  async gc(input: {
    readonly idleMs?: number;
    readonly checkpointRetentionMs?: number;
  } = {}): Promise<{
    expired: number;
    checkpointsRemoved: number;
    permission: Awaited<ReturnType<PermissionManager['sweep']>>;
  }> {
    const idleMs = input.idleMs ?? 60 * 60_000;
    const cutoff = this.now().getTime() - idleMs;
    let expired = 0;
    for (const sandbox of await this.store.listSandboxes(['READY', 'INTERRUPTED', 'FAILED'])) {
      const heartbeat = sandbox.lastHeartbeatAt ? Date.parse(sandbox.lastHeartbeatAt) : 0;
      if (heartbeat > cutoff) continue;
      await this.store.updateSandbox(sandbox.sandboxId, { status: 'EXPIRED' }).catch(() => undefined);
      const refreshed = await this.store.getSandbox(sandbox.sandboxId);
      if (refreshed) await this.controller.destroy(refreshed).catch(() => undefined);
      await this.store.updateTask(sandbox.taskId, { sandboxId: null }).catch(() => undefined);
      expired += 1;
    }
    const checkpointsRemoved = await this.workspaces.pruneCheckpoints(
      input.checkpointRetentionMs ?? 7 * 24 * 60 * 60_000,
    );
    const permission = await this.permissions.sweep();
    await this.audit.record({
      action: 'sandbox.gc',
      outcome: 'succeeded',
      detail: {
        expired,
        checkpoints_removed: checkpointsRemoved,
        idle_ms: idleMs,
        permission,
      },
    });
    return { expired, checkpointsRemoved, permission };
  }

  // ------------------------------------------------------- task cwd (ADR 021) ---

  /** The task's current directory, as the runtime sees it. */
  async currentDirectory(context: SandboxContext): Promise<ToolCwdSnapshot> {
    const task = await this.loadTask(context);
    const taskContext = await this.taskContexts.get(task.taskId);
    return {
      cwd: taskContext.cwd,
      workspaceRoot: taskContext.workspaceRoot,
      cwdVersion: taskContext.cwdVersion,
    };
  }

  /** Full context, for the ops CLI and for tests that assert on versioning. */
  async taskContext(context: SandboxContext): Promise<Awaited<ReturnType<TaskContextStore['get']>>> {
    const task = await this.loadTask(context);
    return this.taskContexts.get(task.taskId);
  }

  /**
   * Move the task's directory for subsequent executions.
   *
   * The tool supplies a path; the task, the sandbox and the expected version come
   * from the runtime's own context. A model that could name a task id would be
   * able to move another conversation's directory, which is why no tool argument
   * exists for it.
   */
  async changeDirectory(
    context: SandboxContext,
    input: { readonly path: string; readonly operationId?: string },
  ): Promise<ToolCwdChange> {
    const task = await this.loadTask(context);
    const request: ChangeDirectoryInput = {
      taskId: task.taskId,
      path: input.path,
      sessionId: task.sessionId,
      actorType: 'agent',
      actorId: `agent:${task.taskId}`,
      ...(input.operationId ? { operationId: input.operationId } : {}),
      ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
    };
    const result = await this.cwdManager.changeDirectory(request);
    if (!result.success) {
      return {
        ok: false,
        error: result.error,
        message: result.message,
        ...(result.currentCwd ? { currentCwd: result.currentCwd } : {}),
        ...(result.resolvedPath ? { resolvedPath: result.resolvedPath } : {}),
        ...(result.workspaceRoot ? { workspaceRoot: result.workspaceRoot } : {}),
      };
    }
    return {
      ok: true,
      previousCwd: result.previousCwd,
      cwd: result.cwd,
      cwdVersion: result.cwdVersion,
      workspaceRoot: result.workspaceRoot,
    };
  }

  /**
   * Re-validate the task cwd after a sandbox rebuild (ADR 021 §11.4).
   *
   * Runs after the runtime is back, because "the directory exists" is only
   * meaningful once the workspace is mounted again. It never repairs by guessing.
   */
  async recoverDirectory(context: SandboxContext): Promise<void> {
    const task = await this.loadTask(context);
    try {
      await this.cwdManager.recover(task.taskId);
    } catch (error) {
      const code = error instanceof CwdError ? error.code : 'CWD_INVALID';
      await this.audit.record({
        taskId: task.taskId,
        sandboxId: task.sandboxId,
        action: 'task.cwd.invalidated',
        outcome: 'failed',
        detail: { code, reason: error instanceof Error ? error.message.slice(0, 200) : String(error) },
      });
    }
  }

  /**
   * Attach (or detach) the turn undo recorder after construction.
   *
   * The composition root owns the product store the recorder needs; the sandbox
   * platform is built before the product store is wired to it. A setter keeps the
   * dependency pointing one way instead of passing the product store into the
   * sandbox layer.
   */
  setChangeRecorder(recorder: WorkspaceChangeRecorder | null): void {
    this.changes = recorder;
    this.fileOps.setChangeRecorder(recorder);
  }

  // --------------------------------------------------------------- execution ---

  async execute(
    context: SandboxContext,
    input: ExecuteInput,
    options: ExecuteOptions = {},
  ): Promise<ExecutionResult> {
    const { task, sandbox, taskContext, timeoutMs, commandDigest } =
      await this.resolveExecutionContext(context, input);

    // A command can change files in ways no per-write hook can see. The undo
    // recorder takes one full checkpoint before the first command of a turn so
    // those files still have a before state.
    await this.changes?.beforeCommand({ taskId: task.taskId }).catch(() => undefined);

    const duplicate = await this.findExistingExecution(sandbox, input, commandDigest);
    if (duplicate) return duplicate;

    // §6.4 step 5: the directory must still exist and still be inside the
    // workspace. This is the last point where refusing is free — after this the
    // command becomes a container process.
    const validated = await this.cwdManager.validateCurrent(task.taskId);
    const cwd = validated.cwd;
    if (validated.canonicalChanged) {
      await this.audit.record({
        taskId: task.taskId,
        sessionId: context.sessionId ?? null,
        sandboxId: sandbox.sandboxId,
        toolCallId: input.toolCallId ?? null,
        action: 'task.cwd.recovered',
        outcome: 'succeeded',
        detail: {
          cwd: taskContext.cwd,
          canonical_cwd: cwd,
          cwd_version: taskContext.cwdVersion,
          note: 'the physical path resolves differently from the recorded one; the execution uses the canonical path',
        },
      });
    }

    const { authorization, permissionRequest } = await this.authorizeExecution({
      task,
      sandbox,
      context,
      input,
      cwd,
      commandDigest,
    });

    const at = this.now().toISOString();
    const execution: Execution = {
      executionId: input.executionId || `exec_${randomUUID()}`,
      taskId: task.taskId,
      sandboxId: sandbox.sandboxId,
      idempotencyKey: input.idempotencyKey,
      commandDigest,
      // The digest above is of the real command; the readable copy is redacted
      // so a one-off token in an argv does not land in the execution table.
      command: input.command.map((part) => this.redactor.redact(part)),
      cwd,
      cwdVersion: taskContext.cwdVersion,
      status: 'CREATED',
      exitCode: null,
      startedAt: null,
      finishedAt: null,
      stdout: '',
      stderr: '',
      policyVersion: sandbox.policyVersion,
      toolCallId: input.toolCallId ?? null,
      decisionId: authorization.decisionId,
      permissionMode: authorization.mode,
      permissionPolicyVersion: authorization.permissionPolicyVersion,
      createdAt: at,
      updatedAt: at,
    };
    const { execution: stored, created } = await this.store.createExecution(execution);
    if (!created) {
      // A concurrent writer won the idempotency race. Reuse its row and never
      // start a second process.
      this.metrics.increment('execution_duplicate');
      if (isTerminalExecution(stored.status) || stored.status === 'UNKNOWN') return toResult(stored);
      throw new SandboxConflictError(`execution ${stored.executionId} is already ${stored.status}`);
    }

    await this.appendEvent(stored, 'execution/created', { command_digest: commandDigest, cwd });
    // ADR 021 §6.3/§12.2: the frozen context is recorded on the execution, so
    // "where did this run?" is answerable after the task has moved on.
    await this.appendEvent(stored, 'execution.cwd.snapshot.created', {
      cwd,
      cwd_version: taskContext.cwdVersion,
      workspace_id: task.workspaceId,
      workspace_root: taskContext.workspaceRoot,
      sandbox_id: sandbox.sandboxId,
      policy_version: sandbox.policyVersion,
    });
    await this.transition(stored, ['CREATED'], 'AUTHORIZED');
    await this.appendEvent(stored, 'execution/authorized', { layer: authorization.layer });
    await this.transition(stored, ['AUTHORIZED'], 'SUBMITTED');
    await this.appendEvent(stored, 'execution/submitted', { timeout_ms: timeoutMs });

    let running: Execution | null = null;
    try {
      const workspace = await this.store.getWorkspace(sandbox.workspaceId);
      if (!workspace) throw new SandboxNotFoundError('workspace is missing');
      const needsRecovery = sandbox.status !== 'READY' && sandbox.status !== 'RUNNING';
      const config = await this.runtimeConfig(sandbox, workspace, needsRecovery);
      const handle = await this.controller.ensureRunning(sandbox, config);

      // Re-check the permission side immediately before the command may run:
      // the policy may have changed and a grant may have expired or been
      // revoked between the decision and this point (ADR 020 §10.2).
      const revalidated = await this.permissions.revalidate(authorization, permissionRequest);
      if (revalidated.effect !== 'allow') {
        const failed = await this.store.transitionExecution(
          stored.executionId,
          ['SUBMITTED'],
          'FAILED',
          { finishedAt: this.now().toISOString() },
        );
        if (failed) {
          await this.appendEvent(failed, 'execution/reconciled', {
            method: 'permission-revalidation',
            reason: revalidated.reason,
          });
        }
        await this.audit.record({
          taskId: task.taskId,
          sessionId: context.sessionId ?? null,
          sandboxId: sandbox.sandboxId,
          executionId: stored.executionId,
          toolCallId: input.toolCallId ?? null,
          policyVersion: revalidated.permissionPolicyVersion,
          action: 'permission.execution.blocked',
          outcome: 'denied',
          detail: { reason: revalidated.reason, decision_id: revalidated.decisionId },
        });
        if (revalidated.effect === 'deny') {
          throw new SandboxPolicyError(revalidated.reason);
        }
        throw new SandboxApprovalRequiredError(revalidated.reason, {
          requestId: revalidated.requestId,
        });
      }
      if (!(await this.permissions.consume(revalidated))) {
        await this.store.transitionExecution(stored.executionId, ['SUBMITTED'], 'FAILED', {
          finishedAt: this.now().toISOString(),
        });
        throw new SandboxApprovalRequiredError('the one-time grant was already consumed');
      }

      await this.store.updateSandbox(sandbox.sandboxId, { status: 'RUNNING' });

      const startedAt = this.now().toISOString();
      running = await this.transition(stored, ['SUBMITTED'], 'RUNNING', { startedAt });
      if (!running) {
        throw new SandboxConflictError('execution could not be moved to RUNNING');
      }
      await this.appendEvent(running, 'execution/started', { started_at: startedAt });

      const active = this.inFlight.get(sandbox.sandboxId) ?? 0;
      if (active >= this.settings.limits.maxConcurrentPerTask) {
        const cancelled = await this.store.transitionExecution(
          running.executionId,
          ['RUNNING'],
          'CANCELLED',
          { finishedAt: this.now().toISOString() },
        );
        if (cancelled) {
          await this.appendEvent(cancelled, 'execution/interrupted', {
            reason: 'another execution is already running in this sandbox',
          });
        }
        // Not an interrupted execution: the command never ran.
        running = null;
        throw new SandboxConflictError('another execution is already running in this sandbox');
      }
      this.inFlight.set(sandbox.sandboxId, active + 1);
      let result: Awaited<ReturnType<SandboxController['execute']>>;
      try {
        const env = await this.executionEnv(task.taskId);
        result = await this.controller.execute(handle, {
          executionId: running.executionId,
          command: input.command,
          shell: input.shell === true,
          cwd,
          workspaceRoot: taskContext.workspaceRoot,
          timeoutMs,
          maxOutputBytes: this.settings.limits.maxOutputBytes,
          env,
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } finally {
        const remaining = (this.inFlight.get(sandbox.sandboxId) ?? 1) - 1;
        if (remaining <= 0) this.inFlight.delete(sandbox.sandboxId);
        else this.inFlight.set(sandbox.sandboxId, remaining);
      }

      return await this.completeExecution({
        task,
        sandbox,
        context,
        input,
        running,
        result,
        startedAt,
        commandDigest,
      });
    } catch (error) {
      return await this.failExecution({
        task,
        sandbox,
        context,
        input,
        stored,
        running,
        error,
      });
    }
  }

  /**
   * Validate the ownership, workspace and working directory of one execution.
   *
   * This is the part of `execute` that decides whether there is a legal
   * execution at all; it has no side effects beyond reading the task context.
   */
  private async resolveExecutionContext(
    context: SandboxContext,
    input: ExecuteInput,
  ) {
    const task = await this.loadTask(context);
    const sandbox = await this.requireSandbox(input.sandboxId);
    if (sandbox.taskId !== task.taskId) {
      throw new SandboxPolicyError('sandbox belongs to a different task');
    }

    validateExecuteInput(input);

    // ADR 021 §6.4: the Gateway does not trust the cwd the adapter sends. It
    // re-reads the task context, confirms the sandbox and workspace still match,
    // and checks the version it was handed against the version on record. A
    // mismatch is reported, never repaired by guessing a directory.
    if (sandbox.workspaceId !== task.workspaceId) {
      throw new CwdError('EXECUTION_CONTEXT_INVALID', 'the sandbox is bound to a different workspace');
    }
    const taskContext = await this.taskContexts.get(task.taskId);
    if (taskContext.invalidatedAt !== null) {
      throw new CwdError(
        'CWD_INVALID',
        `the task working directory is invalid: ${taskContext.invalidReason ?? 'unknown reason'}`,
      );
    }
    const requestedCwd = normalizeContainerPath(input.cwd || WORKSPACE_MOUNT_PATH);
    if (input.cwdVersion !== undefined && input.cwdVersion !== taskContext.cwdVersion) {
      throw new CwdError(
        'CWD_VERSION_MISMATCH',
        'the execution was prepared against a different task working directory version',
      );
    }
    if (requestedCwd !== taskContext.cwd) {
      throw new CwdError(
        'EXECUTION_CONTEXT_INVALID',
        'the requested working directory is not the task working directory',
      );
    }
    const contextCwd = taskContext.cwd;
    if (contextCwd !== WORKSPACE_MOUNT_PATH && !contextCwd.startsWith(`${WORKSPACE_MOUNT_PATH}/`)) {
      throw new CwdError('PATH_OUTSIDE_WORKSPACE', `cwd must be inside ${WORKSPACE_MOUNT_PATH}`);
    }
    const timeoutMs = Math.min(
      Math.max(input.timeoutMs, 1_000),
      this.settings.limits.maxExecutionTimeoutMs,
    );
    // The digest names the logical cwd, so a retry of the same tool call still
    // matches even if the physical path was canonicalised identically.
    const commandDigest = digestCommand(input.command, contextCwd, input.shell === true);

    return { task, sandbox, taskContext, contextCwd, timeoutMs, commandDigest };
  }

  /**
   * The idempotency check: an execution that already produced an outcome is
   * returned instead of being submitted twice. A live duplicate is a conflict.
   */
  private async findExistingExecution(
    sandbox: Sandbox,
    input: ExecuteInput,
    commandDigest: string,
  ): Promise<ExecutionResult | null> {
    // An execution id is a client-supplied idempotency handle too. Without this
    // check a second call with a fresh key and the same id would overwrite the
    // stored row in the in-memory store (or violate the primary key in SQLite).
    if (input.executionId) {
      const sameId = await this.store.getExecution(input.executionId);
      if (sameId) {
        if (sameId.sandboxId !== sandbox.sandboxId || sameId.commandDigest !== commandDigest) {
          throw new SandboxConflictError('executionId was already used for a different execution');
        }
        this.metrics.increment('execution_duplicate');
        if (isTerminalExecution(sameId.status) || sameId.status === 'UNKNOWN') {
          return toResult(sameId);
        }
        throw new SandboxConflictError(`execution ${sameId.executionId} is ${sameId.status}`);
      }
    }

    const duplicate = await this.store.findExecutionByKey(sandbox.sandboxId, input.idempotencyKey);
    if (duplicate) {
      if (duplicate.commandDigest !== commandDigest) {
        throw new SandboxConflictError(
          'idempotency key was already used for a different command in this sandbox',
        );
      }
      this.metrics.increment('execution_duplicate');
      if (isTerminalExecution(duplicate.status) || duplicate.status === 'UNKNOWN') {
        return toResult(duplicate);
      }
      throw new SandboxConflictError(
        `execution ${duplicate.executionId} is ${duplicate.status}; refusing to submit it twice`,
      );
    }
    return null;
  }

  /**
   * Ask the permission layer before anything runs, and record a refusal.
   */
  private async authorizeExecution(request: {
    readonly task: Task;
    readonly sandbox: Sandbox;
    readonly context: SandboxContext;
    readonly input: ExecuteInput;
    readonly cwd: string;
    readonly commandDigest: string;
  }): Promise<{
    readonly authorization: Awaited<ReturnType<PermissionManager['evaluate']>>;
    readonly permissionRequest: PermissionEvaluationRequest;
  }> {
    const { task, sandbox, context, input, cwd, commandDigest } = request;
    const permissionRequest: PermissionEvaluationRequest = {
      requestId: `eval_${randomUUID()}`,
      organizationId: this.settings.permission.organizationId,
      projectId: this.settings.permission.projectId,
      sessionId: task.sessionId,
      taskId: task.taskId,
      sandboxId: sandbox.sandboxId,
      executionId: input.executionId ?? null,
      principal: { type: 'agent', id: `agent:${task.taskId}` },
      action: { tool: 'bash', operation: 'process.exec' },
      resource: { type: 'command', identifier: cwd, scope: [cwd] },
      context: {
        command: input.shell ? (input.command[0] ?? '') : input.command.join(' '),
        cwd,
        metadata: { tool_call_id: input.toolCallId ?? null },
      },
    };
    const authorization = await this.permissions.evaluate(permissionRequest);
    if (authorization.effect !== 'allow') {
      const outcome = authorization.effect === 'deny' ? 'denied' : 'approval_required';
      this.metrics.increment(outcome === 'denied' ? 'policy_denied' : 'approval_required');
      await this.audit.record({
        taskId: task.taskId,
        sessionId: context.sessionId ?? null,
        sandboxId: sandbox.sandboxId,
        toolCallId: input.toolCallId ?? null,
        policyVersion: authorization.permissionPolicyVersion,
        action: 'execution.authorize',
        outcome,
        detail: {
          reason: authorization.reason,
          decision_id: authorization.decisionId,
          request_id: authorization.requestId,
          cwd,
          command_digest: commandDigest,
        },
      });
      if (authorization.effect === 'deny') {
        throw new SandboxPolicyError(authorization.reason);
      }
      throw new SandboxApprovalRequiredError(authorization.reason, {
        requestId: authorization.requestId,
        approvalRequestId: authorization.approvalRequestId ?? null,
      });
    }
    return { authorization, permissionRequest };
  }

  /**
   * Turn the runtime result into a terminal execution row, then finish the
   * metrics, the events and the audit entry. Extracted from `execute` so the
   * failure path can be read next to the success path without scrolling past
   * two hundred lines of orchestration.
   */
  private async completeExecution(request: {
    readonly task: Task;
    readonly sandbox: Sandbox;
    readonly context: SandboxContext;
    readonly input: ExecuteInput;
    readonly running: Execution;
    readonly result: Awaited<ReturnType<SandboxController["execute"]>>;
    readonly startedAt: string;
    readonly commandDigest: string;
  }): Promise<ExecutionResult> {
    const { task, sandbox, context, input, running, result, startedAt, commandDigest } = request;
    const finishedAt = result.finishedAt || this.now().toISOString();
    const target = stateOfOutcome(result.status);
    const stdout = this.bound(result.stdout);
    const stderr = this.bound(result.stderr);
    const terminal = await this.store.transitionExecution(
      running.executionId,
      ['RUNNING'],
      target,
      { exitCode: result.exitCode, finishedAt, stdout, stderr },
    );
    if (!terminal) {
      const current = await this.store.getExecution(running.executionId);
      if (current && (isTerminalExecution(current.status) || current.status === 'UNKNOWN')) {
        return toResult(current);
      }
      throw new SandboxConflictError('execution was concurrently modified');
    }

    if (result.detail === 'cwd-rejected') {
      // The pre-flight check passed and the launcher still refused: a symlink
      // changed or the directory vanished between the two. Fail closed and mark
      // the context, so the next call reports `cwd_invalid` instead of running
      // somewhere else (ADR §4.4, §11.3).
      await this.cwdManager.markInvalidFromRuntime(task.taskId).catch(() => undefined);
    }
    if (stdout.length > 0) {
      await this.appendEvent(terminal, 'execution/stdout', {
        bytes: Buffer.byteLength(result.stdout, 'utf8'),
        retained_bytes: Buffer.byteLength(stdout, 'utf8'),
      });
    }
    if (stderr.length > 0) {
      await this.appendEvent(terminal, 'execution/stderr', {
        bytes: Buffer.byteLength(result.stderr, 'utf8'),
        retained_bytes: Buffer.byteLength(stderr, 'utf8'),
      });
    }
    await this.appendEvent(
      terminal,
      target === 'SUCCEEDED' ? 'execution/finished' : 'execution/failed',
      { exit_code: result.exitCode, status: result.status, detail: result.detail ?? null },
    );

    if (target === 'TIMEOUT') {
      this.metrics.increment('execution_timeout');
      this.metrics.increment('resource_limit_triggered');
      await this.store.updateSandbox(sandbox.sandboxId, { status: 'INTERRUPTED' });
    } else if (target === 'CANCELLED') {
      this.metrics.increment('execution_cancelled');
      await this.store.updateSandbox(sandbox.sandboxId, { status: 'INTERRUPTED' });
    } else {
      await this.store.updateSandbox(sandbox.sandboxId, { status: 'READY' });
    }
    this.metrics.increment('execution_total');
    if (target === 'SUCCEEDED') this.metrics.increment('execution_succeeded');
    else if (target === 'FAILED') this.metrics.increment('execution_failed');
    else if (target === 'UNKNOWN') this.metrics.increment('execution_unknown');

    await this.audit.record({
      taskId: task.taskId,
      sessionId: context.sessionId ?? null,
      sandboxId: sandbox.sandboxId,
      executionId: terminal.executionId,
      toolCallId: input.toolCallId ?? null,
      policyVersion: sandbox.policyVersion,
      action: 'execution.complete',
      outcome: target === 'SUCCEEDED' ? 'succeeded' : target === 'FAILED' ? 'failed' : 'succeeded',
      detail: {
        status: target,
        exit_code: result.exitCode,
        duration_ms: Date.parse(finishedAt) - Date.parse(startedAt),
        command_digest: commandDigest,
      },
    });
    return toResult(terminal);
  }

  /**
   * Fail an execution honestly: FAILED before RUNNING, UNKNOWN after it.
   */
  private async failExecution(request: {
    readonly task: Task;
    readonly sandbox: Sandbox;
    readonly context: SandboxContext;
    readonly input: ExecuteInput;
    readonly stored: Execution;
    readonly running: Execution | null;
    readonly error: unknown;
  }): Promise<never> {
    const { task, sandbox, context, input, stored, running, error } = request;
    const current = running ?? (await this.store.getExecution(stored.executionId));
    if (current && !isTerminalExecution(current.status) && current.status !== 'UNKNOWN') {
      const from = current.status === 'RUNNING' || current.status === 'INTERRUPTED'
        ? (['RUNNING', 'INTERRUPTED'] as const)
        : ([current.status] as const);
      await this.store.transitionExecution(
        current.executionId,
        from,
        current.status === 'RUNNING' ? 'UNKNOWN' : 'FAILED',
        { finishedAt: this.now().toISOString() },
      );
      await this.appendEvent(current, 'execution/failed', {
        error: error instanceof Error ? error.message : String(error),
        unknown: current.status === 'RUNNING',
      });
    }
    this.metrics.increment('execution_total');
    if (running) this.metrics.increment('execution_unknown');
    else this.metrics.increment('execution_failed');
    await this.audit.record({
      taskId: task.taskId,
      sessionId: context.sessionId ?? null,
      sandboxId: sandbox.sandboxId,
      executionId: stored.executionId,
      toolCallId: input.toolCallId ?? null,
      policyVersion: sandbox.policyVersion,
      action: 'execution.complete',
      outcome: 'failed',
      detail: {
        error: error instanceof Error ? error.message : String(error),
        phase: running ? 'running' : 'submitted',
      },
    });
    await this.store
      .updateSandbox(sandbox.sandboxId, { status: running ? 'INTERRUPTED' : 'READY' })
      .catch(() => undefined);
    if (running) {
      // The model must be told that the outcome is unknown, not handed a
      // generic runtime error it might treat as a clean failure and retry.
      throw new SandboxError(
        'unknown_execution',
        `the sandbox lost the result of this execution (${error instanceof Error ? error.message : String(error)}); do not retry it blindly`,
      );
    }
    throw error;
  }

  /**
   * Reconcile an execution whose outcome nobody observed.
   *
   * The marker written by the execution wrapper is the witness. If the runtime is
   * gone and the marker is gone, the result stays UNKNOWN: it is never guessed,
   * and the command is never replayed.
   */
  async reconcileExecution(sandboxId: string, executionId: string): Promise<Execution | null> {
    const sandbox = await this.store.getSandbox(sandboxId);
    const execution = await this.store.getExecution(executionId);
    if (!sandbox || !execution) return null;
    if (isTerminalExecution(execution.status) || execution.status === 'RETRYABLE') return execution;

    // These states mean the request never reached the runtime, so FAILED is a
    // fact rather than a guess. `SUBMITTED` and later are the ones that may have
    // produced a side effect.
    if (execution.status === 'CREATED' || execution.status === 'AUTHORIZED') {
      const failed = await this.store.transitionExecution(
        executionId,
        ['CREATED', 'AUTHORIZED'],
        'FAILED',
        { finishedAt: this.now().toISOString() },
      );
      if (failed) {
        await this.appendEvent(failed, 'execution/reconciled', {
          method: 'never-submitted',
          detail: 'the command was never submitted to the runtime',
        });
      }
      return failed;
    }

    const marker = await this.controller.readExitMarker(sandbox, executionId).catch(() => null);
    if (marker !== null && Number.isFinite(marker)) {
      const target: ExecutionState = marker === 0 ? 'SUCCEEDED' : 'FAILED';
      const from: ExecutionState[] = [
        'SUBMITTED',
        'RUNNING',
        'INTERRUPTED',
        'UNKNOWN',
        'RECONCILING',
      ];
      const reconciled = await this.store.transitionExecution(executionId, from, target, {
        exitCode: marker,
        finishedAt: this.now().toISOString(),
      });
      if (reconciled) {
        await this.appendEvent(reconciled, 'execution/reconciled', {
          marker_exit_code: marker,
          method: 'container-marker',
        });
        this.metrics.increment('reconciliation_succeeded');
        return reconciled;
      }
    }

    const runtime = await this.controller.inspect(sandbox).catch(() => ({
      exists: false,
      running: false,
      detail: 'inspect failed',
    }));
    if (runtime.exists && runtime.running) {
      // Alive but no marker: the command was cut off or the wrapper never ran.
      const unknown = await this.store.transitionExecution(
        executionId,
        ['SUBMITTED', 'RUNNING', 'INTERRUPTED', 'RECONCILING'],
        'UNKNOWN',
        { finishedAt: this.now().toISOString() },
      );
      if (unknown) {
        await this.appendEvent(unknown, 'execution/reconciled', {
          method: 'runtime-alive-no-marker',
          detail: 'outcome unknown; not retried',
        });
      }
      this.metrics.increment('reconciliation_failed');
      return unknown;
    }

    const unknown = await this.store.transitionExecution(
      executionId,
      ['SUBMITTED', 'RUNNING', 'INTERRUPTED', 'RECONCILING'],
      'UNKNOWN',
      { finishedAt: this.now().toISOString() },
    );
    if (unknown) {
      await this.appendEvent(unknown, 'execution/reconciled', {
        method: 'runtime-gone',
        detail: 'runtime and marker are both gone; outcome cannot be established',
      });
    }
    this.metrics.increment('reconciliation_failed');
    return unknown;
  }

  // -------------------------------------------------------------- file tools ---

  async readFile(context: SandboxContext, path: string, start = 1, end = 0): Promise<Awaited<ReturnType<WorkspaceFilesPort['readLines']>>> {
    return this.fileOps.readFile(context, path, start, end);
  }

  async listDir(context: SandboxContext, path = '.', depth = 2): Promise<Awaited<ReturnType<WorkspaceFilesPort['listDir']>>> {
    return this.fileOps.listDir(context, path, depth);
  }

  async glob(context: SandboxContext, pattern: string, maxResults = 200): Promise<Awaited<ReturnType<WorkspaceFilesPort['glob']>>> {
    return this.fileOps.glob(context, pattern, maxResults);
  }

  async grep(
    context: SandboxContext,
    options: Parameters<WorkspaceFilesPort['grep']>[0],
  ): Promise<Awaited<ReturnType<WorkspaceFilesPort['grep']>>> {
    return this.fileOps.grep(context, options);
  }

  async writeFile(context: SandboxContext, path: string, content: string): Promise<Awaited<ReturnType<WorkspaceFilesPort['writeText']>>> {
    return this.fileOps.writeFile(context, path, content);
  }

  async editFile(
    context: SandboxContext,
    options: Parameters<WorkspaceFilesPort['editText']>[0],
  ): Promise<Awaited<ReturnType<WorkspaceFilesPort['editText']>>> {
    return this.fileOps.editFile(context, options);
  }

  /** Ask the policy layer whether a file action would be allowed, without doing it. */
  async authorizeFile(context: SandboxContext, action: 'fs.read' | 'fs.write', path: string): Promise<void> {
    return this.fileOps.authorizeFile(context, action, path);
  }

  async statFile(
    context: SandboxContext,
    path: string,
  ): Promise<{ path: string; size: number; mtimeMs: number } | null> {
    return this.fileOps.statFile(context, path);
  }

  /** The canonical workspace directory, for tool adapters that need to map paths. */
  async workspaceLocation(context: SandboxContext): Promise<string | null> {
    return this.fileOps.workspaceLocation(context);
  }

  /** Used by the Recovery Manager; the same compilation path as normal execution. */
  async recoveryConfig(
    sandbox: Sandbox,
    workspace: Workspace,
  ): Promise<Awaited<ReturnType<RuntimeConfigResolver>>> {
    return this.runtimeConfig(sandbox, workspace, true);
  }

  // ---------------------------------------------------------------- internal ---

  private async loadTask(context: SandboxContext): Promise<Task> {
    assertId('task id', context.taskId);
    const task = await this.store.getTask(context.taskId);
    if (!task) throw new SandboxNotFoundError(`task ${context.taskId} does not exist`);
    if (context.userId && task.userId !== context.userId) {
      throw new SandboxPolicyError('task belongs to a different user');
    }
    return task;
  }

  private async requireSandbox(sandboxId: string): Promise<Sandbox> {
    assertId('sandbox id', sandboxId);
    const sandbox = await this.store.getSandbox(sandboxId);
    if (!sandbox) throw new SandboxNotFoundError(`sandbox ${sandboxId} does not exist`);
    return sandbox;
  }

  private async runtimeConfig(
    sandbox: Sandbox,
    workspace: Workspace,
    refreshMasks = false,
  ): Promise<Awaited<ReturnType<RuntimeConfigResolver>>> {
    const env: Record<string, string> = {};
    if (this.settings.network.proxyUrl) {
      env.HTTP_PROXY = this.settings.network.proxyUrl;
      env.HTTPS_PROXY = this.settings.network.proxyUrl;
    }
    Object.assign(env, await this.credentials.resolveForTask(sandbox.taskId));
    const task = await this.store.getTask(sandbox.taskId);
    const effective = await this.permissions.effectivePolicy(
      sandbox.taskId,
      task?.sessionId ?? sandbox.taskId,
      sandbox.sandboxId,
    );
    return compileRuntimeConfig(effective.sandboxPolicy, {
      sandboxId: sandbox.sandboxId,
      taskId: sandbox.taskId,
      imageDigest: sandbox.imageDigest,
      workspaceHostPath: workspace.storageLocation,
      env,
      resources: minResourceLimits(
        resourceProfile(sandbox.resourceProfile).limits,
        this.settings.resources,
      ),
      labels: {
        'eunoia.workspace': workspace.workspaceId,
        'eunoia.permission_mode': effective.mode,
      },
      // Bind mode exposes the real project; credential files are overlaid with
      // empty read-only mounts so a shell command cannot read them either.
      maskedPaths: await this.workspaces.maskedCredentials(workspace, refreshMasks),
    });
  }

  /**
   * A control-plane permission change reached this Gateway.
   *
   * Running containers are marked INTERRUPTED so the Controller does not
   * reconnect to one whose mount/network was compiled under the old mode
   * (ADR 020 §12.2). Grants issued under the old policy version are expired by
   * the sweep; they would fail revalidation anyway, but marking them makes the
   * state visible to an operator.
   */
  private async onPermissionPolicyChanged(input: {
    readonly scopeType: PermissionScopeLevel;
    readonly scopeId: string;
  }): Promise<void> {
    const sandboxes = await this.store.listSandboxes(ACTIVE_SANDBOX_STATES);
    for (const sandbox of sandboxes) {
      if (input.scopeType === 'sandbox' && sandbox.sandboxId !== input.scopeId) continue;
      if (input.scopeType === 'task' && sandbox.taskId !== input.scopeId) continue;
      if (input.scopeType === 'session') {
        const owner = await this.store.getTask(sandbox.taskId);
        if (owner?.sessionId !== input.scopeId) continue;
      }
      await this.store.updateSandbox(sandbox.sandboxId, { status: 'INTERRUPTED' });
    }
    await this.permissions.sweep().catch(() => undefined);
  }

  private async executionEnv(taskId: string): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    if (this.settings.network.proxyUrl) {
      env.HTTP_PROXY = this.settings.network.proxyUrl;
      env.HTTPS_PROXY = this.settings.network.proxyUrl;
      env.NO_PROXY = '127.0.0.1,localhost';
    }
    Object.assign(env, await this.credentials.resolveForTask(taskId));
    return env;
  }

  private async transition(
    execution: Execution,
    from: readonly ExecutionState[],
    to: ExecutionState,
    patch: { readonly startedAt?: string | null } = {},
  ): Promise<Execution> {
    if (!canTransitionExecution(from[0] as ExecutionState, to)) {
      throw new SandboxConflictError(`invalid execution transition ${from[0]} -> ${to}`);
    }
    const updated = await this.store.transitionExecution(
      execution.executionId,
      from,
      to,
      to === 'SUBMITTED' ? { startedAt: null, ...patch } : patch,
    );
    if (!updated) {
      throw new SandboxConflictError(
        `execution ${execution.executionId} is no longer in ${from.join('/')}`,
      );
    }
    return updated;
  }

  private async appendEvent(execution: Execution, type: string, payload: unknown): Promise<void> {
    const event: ExecutionEvent = {
      eventId: `evt_${randomUUID()}`,
      taskId: execution.taskId,
      sandboxId: execution.sandboxId,
      executionId: execution.executionId,
      idempotencyKey: execution.idempotencyKey,
      eventType: type,
      timestamp: this.now().toISOString(),
      policyVersion: execution.policyVersion,
      payload: this.redactor.redactValue(payload),
    };
    await this.store.appendEvent(event);
  }

  private bound(text: string): string {
    const limit = this.settings.limits.maxOutputBytes;
    const redacted = this.redactor.redact(text);
    const bytes = Buffer.from(redacted, 'utf8');
    if (bytes.length <= limit) return redacted;
    const tail = bytes.subarray(bytes.length - limit).toString('utf8');
    return `… [output truncated to the last ${limit} bytes]\n${tail}`;
  }

  private async assertCapacity(task: Task): Promise<void> {
    const blocked = await this.capacityError(task);
    if (blocked) throw blocked;
  }

  /**
   * Why a new sandbox cannot be created right now, or `null` when one can.
   *
   * Kept separate from {@link assertCapacity} because reclamation needs to ask
   * the same question after every candidate it retires, and a thrown error is a
   * poor control-flow token for that.
   */
  private async capacityError(task: Task): Promise<SandboxQuotaError | null> {
    const active = await this.store.listSandboxes(ACTIVE_SANDBOX_STATES);
    if (active.length >= this.settings.limits.maxConcurrentGlobal) {
      return new SandboxQuotaError(
        `global sandbox limit reached (${this.settings.limits.maxConcurrentGlobal})`,
      );
    }
    const forTask = active.filter((sandbox) => sandbox.taskId === task.taskId);
    if (forTask.length >= this.settings.limits.maxConcurrentPerTask) {
      return new SandboxQuotaError(`task already has ${forTask.length} sandbox(es)`);
    }
    let forUser = 0;
    for (const sandbox of active) {
      const owner = await this.store.getTask(sandbox.taskId);
      if (owner?.userId === task.userId) forUser += 1;
    }
    if (forUser >= this.settings.limits.maxConcurrentPerUser) {
      return new SandboxQuotaError(
        `user sandbox limit reached (${this.settings.limits.maxConcurrentPerUser})`,
      );
    }
    return null;
  }

  /**
   * Retire idle containers until a new sandbox fits, or until none is left.
   *
   * An idle sandbox is a READY/EXPIRED container with no unfinished execution.
   * Its workspace is durable and is never touched (ADR §9), so the task that
   * owned it simply gets a fresh container on its next command. This is the
   * same guarantee `gc` relies on; the difference is that it happens on demand
   * instead of waiting for an operator to run the CLI.
   *
   * Sandboxes belonging to the same user are preferred, then the least recently
   * used one. A sandbox with an execution in flight is never a candidate.
   */
  private async reclaimIdleSandboxesForCapacity(task: Task): Promise<number> {
    if (!(await this.capacityError(task))) return 0;

    const idleStates = ['READY', 'EXPIRED'] as const;
    const active = await this.store.listSandboxes(idleStates);
    const candidates: { sandbox: Sandbox; sameUser: boolean; lastUsed: number }[] = [];
    for (const sandbox of active) {
      if (sandbox.taskId === task.taskId) continue;
      const owner = await this.store.getTask(sandbox.taskId);
      candidates.push({
        sandbox,
        sameUser: owner?.userId === task.userId,
        lastUsed: Date.parse(sandbox.lastHeartbeatAt ?? sandbox.updatedAt) || 0,
      });
    }
    candidates.sort(
      (left, right) => Number(right.sameUser) - Number(left.sameUser) || left.lastUsed - right.lastUsed,
    );

    let reclaimed = 0;
    for (const candidate of candidates) {
      // Re-read before acting: another capacity check may have retired it while
      // this loop was sorting, and a stale row would make the audit misleading.
      const fresh = await this.store.getSandbox(candidate.sandbox.sandboxId);
      if (!fresh || (fresh.status !== 'READY' && fresh.status !== 'EXPIRED')) continue;
      const unfinished = await this.store.listUnfinishedExecutions(fresh.sandboxId);
      if (unfinished.length > 0) continue;

      try {
        await this.controller.destroy(fresh);
        // The task keeps its workspace and cwd; only the container identity is
        // cleared, so the next `ensureSandbox` builds a replacement.
        await this.store.updateTask(fresh.taskId, { sandboxId: null });
        await this.audit.record({
          taskId: task.taskId,
          sandboxId: fresh.sandboxId,
          action: 'sandbox.reclaim',
          outcome: 'succeeded',
          detail: {
            reason: 'capacity',
            owner_task_id: fresh.taskId,
            same_user: candidate.sameUser,
            previous_status: fresh.status,
            workspace: fresh.workspaceId,
          },
        });
        reclaimed += 1;
      } catch (error) {
        await this.audit
          .record({
            taskId: task.taskId,
            sandboxId: fresh.sandboxId,
            action: 'sandbox.reclaim',
            outcome: 'failed',
            detail: {
              reason: 'capacity',
              owner_task_id: fresh.taskId,
              error: error instanceof Error ? error.message.slice(0, 300) : String(error),
            },
          })
          .catch(() => undefined);
        continue;
      }

      if (!(await this.capacityError(task))) break;
    }
    return reclaimed;
  }
}

// ----------------------------------------------------------------- helpers ---


function stateOfOutcome(outcome: ExecutionResult['status']): ExecutionState {
  switch (outcome) {
    case 'SUCCEEDED':
      return 'SUCCEEDED';
    case 'FAILED':
      return 'FAILED';
    case 'TIMEOUT':
      return 'TIMEOUT';
    case 'CANCELLED':
      return 'CANCELLED';
    case 'UNKNOWN':
      return 'UNKNOWN';
  }
}

function toResult(execution: Execution): ExecutionResult {
  return {
    executionId: execution.executionId,
    status: executionOutcome(execution.status),
    ...(execution.exitCode === null ? {} : { exitCode: execution.exitCode }),
    stdout: execution.stdout,
    stderr: execution.stderr,
    startedAt: execution.startedAt ?? execution.createdAt,
    ...(execution.finishedAt === null ? {} : { finishedAt: execution.finishedAt }),
  };
}

function digestCommand(command: readonly string[], cwd: string, shell: boolean): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify({ command, cwd, shell }))
    .digest('hex')}`;
}

function validateExecuteInput(input: ExecuteInput): void {
  if (!input.idempotencyKey || input.idempotencyKey.length > MAX_IDEMPOTENCY_KEY) {
    throw new SandboxPolicyError('idempotencyKey is required and must be at most 200 characters');
  }
  if (!Array.isArray(input.command) || input.command.length === 0) {
    throw new SandboxPolicyError('command must be a non-empty argv array');
  }
  if (input.command.some((part) => typeof part !== 'string')) {
    throw new SandboxPolicyError('every command element must be a string');
  }
  const bytes = Buffer.byteLength(input.command.join('\0'), 'utf8');
  if (bytes > MAX_COMMAND_BYTES) {
    throw new SandboxPolicyError(`command exceeds ${MAX_COMMAND_BYTES} bytes`);
  }
  if (input.shell && input.command.length !== 1) {
    throw new SandboxPolicyError('shell mode takes exactly one command string');
  }
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new SandboxPolicyError('timeoutMs must be a positive number');
  }
  if (input.executionId && !/^[A-Za-z0-9_-]{1,80}$/.test(input.executionId)) {
    throw new SandboxPolicyError('executionId contains an unsupported character');
  }
}
