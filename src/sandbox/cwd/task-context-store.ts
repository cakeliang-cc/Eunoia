/**
 * The only reader and writer of a task's working directory (ADR 021 §3).
 *
 * Everything else — the Gateway, the tools, recovery — goes through this class,
 * so there is one place that knows the version rules:
 *
 *   - creation initialises the cwd to the workspace root at version 1;
 *   - a change is a compare-and-set on `cwdVersion`, never a blind write;
 *   - a change and its audit row are committed together (the store owns the
 *     transaction), so "the cwd moved but nobody can say when" is not a state
 *     this platform can reach;
 *   - a validation failure marks the record unusable *without* moving it, which
 *     is what lets recovery say `cwd_invalid` instead of silently using `/`.
 */

import { randomUUID } from 'node:crypto';
import type { AuditEvent, Task } from '../types.ts';
import { WORKSPACE_MOUNT_PATH } from '../types.ts';
import type { SandboxStore } from '../store.ts';
import type { AuditLog } from '../audit.ts';
import {
  CwdError,
  CwdVersionConflictError,
  type InitializeTaskContextInput,
  type TaskCwdStatus,
  type TaskExecutionContext,
  type UpdateTaskCwdInput,
} from './cwd-types.ts';

export interface TaskContextStoreDeps {
  readonly store: SandboxStore;
  readonly now?: () => Date;
  /** Optional: initialisation/validation events are informational. */
  readonly audit?: AuditLog;
}

export class TaskContextStore {
  private readonly store: SandboxStore;
  private readonly now: () => Date;
  private readonly audit: AuditLog | null;

  constructor(deps: TaskContextStoreDeps) {
    this.store = deps.store;
    this.now = deps.now ?? (() => new Date());
    this.audit = deps.audit ?? null;
  }

  /** Load the context, initialising a legacy row in place rather than failing. */
  async get(taskId: string): Promise<TaskExecutionContext> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new CwdError('TASK_NOT_FOUND', `task ${taskId} does not exist`);
    if (task.currentCwd === null || task.currentCwd === undefined) {
      // A task written before ADR 021 has no cwd; ADR §16.1 says to start at the
      // workspace root and never to infer one from command history.
      const initialized = await this.store.initializeTaskCwd({
        taskId,
        workspaceRoot: WORKSPACE_MOUNT_PATH,
        at: this.now().toISOString(),
      });
      return toContext(initialized ?? task);
    }
    return toContext(task);
  }

  async snapshot(taskId: string): Promise<TaskExecutionContext> {
    return this.get(taskId);
  }

  /**
   * Create the context for a task.
   *
   * Idempotent: a second call for an initialised task returns the existing
   * context unchanged. It runs before the first coding tool is registered
   * (ADR §8.1), so no execution can observe a task without a cwd.
   */
  async initialize(input: InitializeTaskContextInput): Promise<TaskExecutionContext> {
    const before = await this.store.getTask(input.taskId);
    if (!before) throw new CwdError('TASK_NOT_FOUND', `task ${input.taskId} does not exist`);

    const workspaceRoot = input.workspaceRoot;
    const task = await this.store.initializeTaskCwd({
      taskId: input.taskId,
      workspaceRoot,
      at: input.now,
    });
    if (!task) throw new CwdError('TASK_NOT_FOUND', `task ${input.taskId} does not exist`);

    const context = toContext(task);
    if (before.currentCwd === null || before.currentCwd === undefined) {
      await this.audit?.record({
        taskId: input.taskId,
        sessionId: task.sessionId,
        sandboxId: context.sandboxId,
        action: 'task.cwd.initialized',
        outcome: 'succeeded',
        detail: {
          workspace_id: input.workspaceId,
          workspace_root: context.workspaceRoot,
          cwd: context.cwd,
          cwd_version: context.cwdVersion,
        },
      });
    }
    return context;
  }

  /**
   * Compare-and-set the cwd and append its audit row atomically.
   *
   * Throws `CwdVersionConflictError` when another writer won. The caller must
   * re-read and retry deliberately — re-resolving the original relative path
   * against a new base directory would silently do something else (ADR §10.2).
   */
  async updateCwd(input: UpdateTaskCwdInput): Promise<TaskExecutionContext> {
    const current = await this.store.getTask(input.taskId);
    if (!current) throw new CwdError('TASK_NOT_FOUND', `task ${input.taskId} does not exist`);
    if (current.status !== 'ACTIVE') {
      throw new CwdError('TASK_NOT_ACTIVE', `task ${input.taskId} is ${current.status}`);
    }
    const before = toContext(current);
    if (before.cwdVersion !== input.expectedVersion) throw new CwdVersionConflictError();

    const actorType = input.actorType ?? 'agent';
    const actorId = input.actorId ?? `agent:${input.taskId}`;
    const audit: AuditEvent = {
      id: `aud_${randomUUID()}`,
      timestamp: input.now,
      sessionId: current.sessionId,
      taskId: input.taskId,
      sandboxId: current.sandboxId,
      executionId: null,
      toolCallId: input.toolCallId ?? null,
      policyVersion: null,
      approvalId: null,
      action: 'task.cwd.change.succeeded',
      outcome: 'succeeded',
      detail: {
        operation_id: input.operationId ?? null,
        previous_cwd: before.cwd,
        new_cwd: input.newCwd,
        cwd_version: before.cwdVersion + 1,
        actor_type: actorType,
        actor_id: actorId,
      },
    };

    const result = await this.store.compareAndSetTaskCwd({
      taskId: input.taskId,
      expectedVersion: input.expectedVersion,
      cwd: input.newCwd,
      at: input.now,
      audit,
    });
    if (result.updated) return toContext(result.task);
    if (result.reason === 'not_found') {
      throw new CwdError('TASK_NOT_FOUND', `task ${input.taskId} does not exist`);
    }
    if (result.reason === 'not_active') {
      throw new CwdError('TASK_NOT_ACTIVE', `task ${input.taskId} is no longer active`);
    }
    throw new CwdVersionConflictError();
  }

  /**
   * Record that the stored cwd is unusable.
   *
   * The path is kept on purpose: "the directory you were in no longer exists" is
   * recoverable information, while overwriting it with `/workspace` would erase
   * the evidence and change the task's directory behind the person's back.
   */
  async markInvalid(taskId: string, reason: string): Promise<TaskExecutionContext> {
    const task = await this.store.setTaskCwdInvalidation({
      taskId,
      reason,
      at: this.now().toISOString(),
    });
    if (!task) throw new CwdError('TASK_NOT_FOUND', `task ${taskId} does not exist`);
    const context = toContext(task);
    await this.audit?.record({
      taskId,
      sessionId: task.sessionId,
      sandboxId: context.sandboxId,
      action: 'task.cwd.invalidated',
      outcome: 'failed',
      detail: { cwd: context.cwd, cwd_version: context.cwdVersion, reason },
    });
    return context;
  }

  /** Clear an invalid mark after a successful validation. */
  async markRecovered(taskId: string, reason: string): Promise<TaskExecutionContext> {
    const task = await this.store.setTaskCwdInvalidation({ taskId, reason: null, at: null });
    if (!task) throw new CwdError('TASK_NOT_FOUND', `task ${taskId} does not exist`);
    await this.audit?.record({
      taskId,
      sessionId: task.sessionId,
      action: 'task.cwd.recovered',
      outcome: 'succeeded',
      detail: { reason },
    });
    return toContext(task);
  }

  /**
   * A shutdown hook.
   *
   * The task's own status is the authority on whether its context is open, so
   * this deliberately changes nothing: it exists so a caller that owns a task
   * has one place to say it is done with it.
   */
  async close(_taskId: string): Promise<void> {
    void _taskId;
  }
}

/** Task row → domain context, filling the ADR's defaults for legacy rows. */
export function toContext(task: Task): TaskExecutionContext {
  const workspaceRoot = task.workspaceRoot ?? WORKSPACE_MOUNT_PATH;
  return {
    taskId: task.taskId,
    sandboxId: task.sandboxId,
    workspaceId: task.workspaceId,
    workspaceRoot,
    cwd: task.currentCwd ?? workspaceRoot,
    cwdVersion: task.cwdVersion ?? 1,
    status: toStatus(task),
    invalidatedAt: task.cwdInvalidatedAt ?? null,
    invalidReason: task.cwdInvalidReason ?? null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function toStatus(task: Task): TaskCwdStatus {
  switch (task.status) {
    case 'ACTIVE':
      return 'active';
    case 'PAUSED':
      return 'paused';
    case 'FAILED':
      return 'cancelled';
    case 'COMPLETED':
    case 'ARCHIVED':
      return 'completed';
  }
}
