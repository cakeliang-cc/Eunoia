/**
 * The business entry point for a task's working directory (ADR 021 §4).
 *
 * One method changes the directory, and it is deliberately the only one: the
 * Gateway, the `change_directory` tool and recovery all funnel through
 * `changeDirectory`, so the order of checks cannot differ between them.
 *
 * The order is the ADR's:
 *
 *     load context → status → expected version → resolve → boundary
 *       → permission policy → permission decision → physical validation
 *       → atomic CAS → audit → return
 *
 * Relative paths are resolved against the *current* task cwd, never against
 * `/workspace`, and never re-resolved after a version conflict — a conflict is
 * reported, because "retry `..` from wherever the task is now" is a different
 * request from the one the model made.
 */

import { randomUUID } from 'node:crypto';
import type { SandboxStore } from '../store.ts';
import type { AuditLog, SandboxMetrics } from '../audit.ts';
import type {
  EffectivePermissionPolicy,
  PermissionDecision,
  PermissionEvaluationRequest,
} from '../permissions/types.ts';
import {
  CwdError,
  type ChangeDirectoryInput,
  type ChangeDirectoryResult,
  type CwdErrorCode,
  type CwdResult,
  type TaskExecutionContext,
} from './cwd-types.ts';
import { assertPathInput, resolveTaskPath } from './cwd-path.ts';
import { authorizeCwdChange } from './cwd-policy.ts';
import type { CwdValidator } from './cwd-validator.ts';
import type { TaskContextStore } from './task-context-store.ts';

/**
 * The permission surface this manager needs.
 *
 * Narrow on purpose: `PermissionManager` satisfies it, and a test can supply a
 * decision without constructing the whole layer.
 */
export interface CwdPermissionPort {
  effectivePolicy(
    taskId: string,
    sessionId: string,
    sandboxId: string | null,
  ): Promise<EffectivePermissionPolicy>;
  evaluate(request: PermissionEvaluationRequest): Promise<PermissionDecision>;
  revalidate(
    decision: PermissionDecision,
    request: PermissionEvaluationRequest,
  ): Promise<PermissionDecision>;
  consume(decision: PermissionDecision): Promise<boolean>;
}

export interface CwdManagerDeps {
  readonly store: SandboxStore;
  readonly contexts: TaskContextStore;
  readonly validator: CwdValidator;
  readonly permissions: CwdPermissionPort;
  readonly audit: AuditLog;
  readonly metrics: SandboxMetrics;
  readonly now?: () => Date;
}

export interface ValidatedCwd {
  readonly context: TaskExecutionContext;
  /** Canonical container path after symlink resolution. */
  readonly cwd: string;
  readonly workspaceHostRoot: string;
  readonly canonicalChanged: boolean;
}

export class CwdManager {
  private readonly store: SandboxStore;
  private readonly contexts: TaskContextStore;
  private readonly validator: CwdValidator;
  private readonly permissions: CwdPermissionPort;
  private readonly audit: AuditLog;
  private readonly metrics: SandboxMetrics;
  private readonly now: () => Date;

  constructor(deps: CwdManagerDeps) {
    this.store = deps.store;
    this.contexts = deps.contexts;
    this.validator = deps.validator;
    this.permissions = deps.permissions;
    this.audit = deps.audit;
    this.metrics = deps.metrics;
    this.now = deps.now ?? (() => new Date());
  }

  async getCurrentDirectory(taskId: string): Promise<CwdResult> {
    const context = await this.contexts.get(taskId);
    return {
      cwd: context.cwd,
      workspaceRoot: context.workspaceRoot,
      cwdVersion: context.cwdVersion,
    };
  }

  /**
   * Change the task's directory for subsequent executions.
   *
   * Business failures are returned, not thrown: the tool has to render them as a
   * structured result the model can act on, and an exception would be flattened
   * into "tool failed" by the loop.
   */
  async changeDirectory(input: ChangeDirectoryInput): Promise<ChangeDirectoryResult> {
    const operationId = input.operationId ?? null;

    // ---- idempotent replay -------------------------------------------------
    if (operationId !== null) {
      const previous = await this.store.findCwdOperation(operationId);
      if (previous) {
        if (previous.taskId !== input.taskId || previous.path !== input.path) {
          return this.fail(input, 'IDEMPOTENCY_CONFLICT', '这个操作 ID 已经用于另一个目录请求。');
        }
        return previous.result;
      }
    }

    const actorType = input.actorType ?? 'agent';
    const actorId = input.actorId ?? `agent:${input.taskId}`;
    await this.audit.record({
      taskId: input.taskId,
      sessionId: input.sessionId ?? null,
      toolCallId: input.toolCallId ?? null,
      action: 'task.cwd.change.requested',
      outcome: 'allowed',
      detail: { path: input.path, operation_id: operationId, actor_type: actorType },
    });

    let taskContext: TaskExecutionContext | null = null;
    let resolvedPath: string | null = null;
    try {
      const context = await this.contexts.get(input.taskId);
      taskContext = context;
      if (context.status !== 'active') {
        throw new CwdError('TASK_NOT_ACTIVE', `task is ${context.status}; its directory cannot change`);
      }
      if (
        input.expectedCwdVersion !== undefined &&
        input.expectedCwdVersion !== context.cwdVersion
      ) {
        throw new CwdError('CWD_VERSION_CONFLICT', 'the task working directory changed since it was read');
      }

      // ---- lexical resolution and boundary --------------------------------
      const requested = assertPathInput(input.path);
      const target = resolveTaskPath(requested, context.cwd);
      resolvedPath = target;
      const workspace = await this.store.getWorkspace(context.workspaceId);
      if (!workspace) {
        throw new CwdError('WORKSPACE_NOT_AVAILABLE', 'the task workspace no longer exists');
      }

      const effective = await this.permissions.effectivePolicy(
        context.taskId,
        input.sessionId ?? context.taskId,
        context.sandboxId,
      );

      // The mode and the boundary are checked before the permission layer so the
      // denial reason is specific: "outside the workspace" and "not allowed by
      // the restricted allow-list" are different next actions for the model.
      const policy = authorizeCwdChange({
        mode: effective.mode,
        sandboxPolicy: effective.sandboxPolicy,
        ...(effective.restricted ? { restricted: effective.restricted } : {}),
        cwd: target,
        workspaceRoot: context.workspaceRoot,
      });
      if (!policy.allowed) {
        throw new CwdError(policy.code ?? 'PERMISSION_DENIED', policy.reason);
      }

      // ---- permission decision -------------------------------------------
      const request = this.permissionRequest(context, target, input);
      const decision = await this.permissions.evaluate(request);
      if (decision.effect !== 'allow') {
        throw new CwdError(
          'PERMISSION_DENIED',
          decision.effect === 'deny'
            ? 'permission policy denied this directory change'
            : 'this directory change requires an approval the task does not have',
        );
      }
      const revalidated = await this.permissions.revalidate(decision, request);
      if (revalidated.effect !== 'allow') {
        throw new CwdError('PERMISSION_DENIED', 'the permission for this directory change is no longer valid');
      }
      if (!(await this.permissions.consume(revalidated))) {
        throw new CwdError('PERMISSION_DENIED', 'the one-time permission was already used');
      }

      // ---- physical validation -------------------------------------------
      const validation = await this.validator.validate({
        workspaceRoot: context.workspaceRoot,
        workspaceHostRoot: workspace.storageLocation,
        cwd: target,
      });
      if (!validation.ok) throw new CwdError(validation.code, validation.message);

      // ---- atomic update -------------------------------------------------
      let updated: TaskExecutionContext;
      try {
        updated = await this.contexts.updateCwd({
          taskId: context.taskId,
          expectedVersion: context.cwdVersion,
          newCwd: validation.cwd,
          now: this.now().toISOString(),
          operationId,
          toolCallId: input.toolCallId ?? null,
          actorType,
          actorId,
        });
      } catch (error) {
        // A concurrent duplicate may have committed the same operation. Replaying
        // its stored result is what makes a network-level retry idempotent; a
        // genuine loser re-reads and reports the conflict.
        if (operationId !== null) {
          const stored = await this.store.findCwdOperation(operationId);
          if (stored && stored.path === input.path && stored.taskId === input.taskId) return stored.result;
        }
        throw error;
      }

      this.metrics.increment('permission_allowed');
      const result: ChangeDirectoryResult = {
        success: true,
        previousCwd: context.cwd,
        cwd: updated.cwd,
        cwdVersion: updated.cwdVersion,
        workspaceRoot: updated.workspaceRoot,
      };
      if (operationId !== null) {
        await this.store
          .saveCwdOperation({
            operationId,
            taskId: context.taskId,
            path: input.path,
            result,
            cwdVersion: updated.cwdVersion,
            createdAt: this.now().toISOString(),
          })
          .catch(() => undefined);
      }
      return result;
    } catch (error) {
      if (error instanceof CwdError) {
        if (error.code === 'PERMISSION_DENIED') this.metrics.increment('permission_denied');
        await this.audit.record({
          taskId: input.taskId,
          sessionId: input.sessionId ?? null,
          sandboxId: taskContext?.sandboxId ?? null,
          toolCallId: input.toolCallId ?? null,
          action: 'task.cwd.change.denied',
          outcome: 'denied',
          detail: { path: input.path, code: error.code, reason: error.message, operation_id: operationId },
        });
        return {
          success: false,
          error: error.code,
          message: error.message,
          ...(taskContext ? { currentCwd: taskContext.cwd, workspaceRoot: taskContext.workspaceRoot } : {}),
          ...(resolvedPath ? { resolvedPath } : {}),
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      await this.audit
        .record({
          taskId: input.taskId,
          sessionId: input.sessionId ?? null,
          toolCallId: input.toolCallId ?? null,
          action: 'task.cwd.change.failed',
          outcome: 'failed',
          detail: { path: input.path, operation_id: operationId, error: message.slice(0, 300) },
        })
        .catch(() => undefined);
      // The internal message may name a host path; the model gets a stable code.
      return {
        success: false,
        error: 'CWD_INVALID',
        message: 'the directory change failed before it could be committed',
      };
    }
  }

  /**
   * Validate the stored cwd without moving it.
   *
   * Used before an execution is created and by recovery. A failure marks the
   * context invalid and throws; the caller must not fall back to `/workspace`
   * (ADR §11.3), because that would run a command somewhere the model did not
   * ask for while reporting success.
   */
  async validateCurrent(taskId: string): Promise<ValidatedCwd> {
    const context = await this.contexts.get(taskId);
    const workspace = await this.store.getWorkspace(context.workspaceId);
    if (!workspace) {
      throw new CwdError('WORKSPACE_NOT_AVAILABLE', 'the task workspace no longer exists');
    }
    if (context.invalidatedAt !== null) {
      throw new CwdError(
        'CWD_INVALID',
        `the task working directory is invalid: ${context.invalidReason ?? 'unknown reason'}`,
      );
    }
    const validation = await this.validator.validate({
      workspaceRoot: context.workspaceRoot,
      workspaceHostRoot: workspace.storageLocation,
      cwd: context.cwd,
    });
    if (!validation.ok) {
      await this.contexts.markInvalid(context.taskId, validation.code).catch(() => undefined);
      await this.audit.record({
        taskId: context.taskId,
        sandboxId: context.sandboxId,
        action: 'execution.cwd.validation.failed',
        outcome: 'failed',
        detail: { cwd: context.cwd, code: validation.code, message: validation.message },
      });
      throw new CwdError(validation.code, validation.message);
    }
    return {
      context,
      cwd: validation.cwd,
      workspaceHostRoot: workspace.storageLocation,
      canonicalChanged: validation.cwd !== context.cwd,
    };
  }

  /**
   * Recovery hook: re-validate a task's cwd after a restart or a sandbox rebuild.
   *
   * This is the one path that may clear an invalid mark, because it re-validates
   * from scratch instead of trusting the flag. A directory that is still gone is
   * *not* repaired by guessing; the context stays invalid and the caller decides
   * (ADR §11.3).
   */
  async recover(taskId: string): Promise<ValidatedCwd> {
    const context = await this.contexts.get(taskId);
    const workspace = await this.store.getWorkspace(context.workspaceId);
    if (!workspace) throw new CwdError('WORKSPACE_NOT_AVAILABLE', 'the task workspace no longer exists');

    const validation = await this.validator.validate({
      workspaceRoot: context.workspaceRoot,
      workspaceHostRoot: workspace.storageLocation,
      cwd: context.cwd,
    });
    if (!validation.ok) {
      await this.contexts.markInvalid(taskId, validation.code).catch(() => undefined);
      await this.audit
        .record({
          taskId,
          sandboxId: context.sandboxId,
          action: 'execution.cwd.validation.failed',
          outcome: 'failed',
          detail: { cwd: context.cwd, code: validation.code, message: validation.message },
        })
        .catch(() => undefined);
      throw new CwdError(validation.code, validation.message);
    }
    if (context.invalidatedAt !== null) {
      await this.contexts.markRecovered(taskId, 'cwd validated after recovery').catch(() => undefined);
    }
    return {
      context,
      cwd: validation.cwd,
      workspaceHostRoot: workspace.storageLocation,
      canonicalChanged: validation.cwd !== context.cwd,
    };
  }

  /**
   * The launcher refused the cwd after the pre-flight check passed.
   *
   * This is the race the two checks exist to catch; the context is marked so the
   * next execution reports `cwd_invalid` rather than retrying a directory the
   * runtime just proved unusable.
   */
  async markInvalidFromRuntime(taskId: string): Promise<TaskExecutionContext> {
    const context = await this.contexts.markInvalid(taskId, 'execution launcher rejected the cwd');
    await this.audit
      .record({
        taskId,
        sandboxId: context.sandboxId,
        action: 'execution.cwd.validation.failed',
        outcome: 'failed',
        detail: { cwd: context.cwd, cwd_version: context.cwdVersion, code: 'CWD_INVALID' },
      })
      .catch(() => undefined);
    return context;
  }

  private permissionRequest(
    context: TaskExecutionContext,
    target: string,
    input: ChangeDirectoryInput,
  ): PermissionEvaluationRequest {
    return {
      requestId: `eval_${randomUUID()}`,
      sessionId: input.sessionId ?? context.taskId,
      taskId: context.taskId,
      sandboxId: context.sandboxId,
      principal: { type: 'agent', id: input.actorId ?? `agent:${context.taskId}` },
      action: { tool: 'change_directory', operation: 'fs.chdir' },
      resource: { type: 'path', identifier: target, scope: [target] },
      context: {
        cwd: context.cwd,
        metadata: { tool_call_id: input.toolCallId ?? null, requested_path: input.path },
      },
    };
  }

  private async fail(
    input: ChangeDirectoryInput,
    error: CwdErrorCode,
    message: string,
  ): Promise<ChangeDirectoryResult> {
    await this.audit
      .record({
        taskId: input.taskId,
        sessionId: input.sessionId ?? null,
        toolCallId: input.toolCallId ?? null,
        action: 'task.cwd.change.denied',
        outcome: 'denied',
        detail: { path: input.path, code: error, reason: message },
      })
      .catch(() => undefined);
    return { success: false, error, message };
  }
}
