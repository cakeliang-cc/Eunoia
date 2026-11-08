/**
 * The Gateway's file-tool half.
 *
 * Reading, writing, listing and authorizing paths are a cohesive job: they all
 * resolve a path through the workspace's guard, ask the Permission Manager about
 * that one path, and leave an audit row. Keeping them in `gateway.ts` made the
 * file share a 2,000-line class with sandbox lifecycle and command execution;
 * keeping them here lets the path rules be read without the container runtime
 * above them.
 *
 * What has *not* moved is the decision about who may run these operations: this
 * class still evaluates the same `fs.read` / `fs.write` permission, consumes the
 * same one-time grant, and returns the same errors. The Gateway owns the
 * instance and delegates to it, so the public surface is unchanged.
 */

import { randomUUID } from 'node:crypto';
import type { AuditLog, SandboxMetrics } from './audit.ts';
import type { SandboxSettings } from './config.ts';
import type { SandboxContext } from './context.ts';
import {
  SandboxApprovalRequiredError,
  SandboxNotFoundError,
  SandboxPolicyError,
} from './errors.ts';
import { assertId } from './ids.ts';
import type { PermissionManager } from './permissions/permission-manager.ts';
import type { PermissionEvaluationRequest } from './permissions/types.ts';
import type { SandboxStore } from './store.ts';
import type { Task, Workspace } from './types.ts';
import type { WorkspaceManager } from './workspace-manager.ts';
import type { WorkspaceChangeRecorder } from './workspace-changes.ts';

export interface GatewayFileOperationsDeps {
  readonly store: SandboxStore;
  readonly workspaces: WorkspaceManager;
  readonly permissions: PermissionManager;
  readonly audit: AuditLog;
  readonly metrics: SandboxMetrics;
  readonly settings: SandboxSettings;
  readonly changes?: WorkspaceChangeRecorder;
}

export class GatewayFileOperations {
  readonly #store: SandboxStore;
  readonly #workspaces: WorkspaceManager;
  readonly #permissions: PermissionManager;
  readonly #audit: AuditLog;
  readonly #metrics: SandboxMetrics;
  readonly #settings: SandboxSettings;
  #changes: WorkspaceChangeRecorder | null;

  constructor(deps: GatewayFileOperationsDeps) {
    this.#store = deps.store;
    this.#workspaces = deps.workspaces;
    this.#permissions = deps.permissions;
    this.#audit = deps.audit;
    this.#metrics = deps.metrics;
    this.#settings = deps.settings;
    this.#changes = deps.changes ?? null;
  }

  /** See SandboxGateway.setChangeRecorder. */
  setChangeRecorder(recorder: WorkspaceChangeRecorder | null): void {
    this.#changes = recorder;
  }

  async readFile(
    context: SandboxContext,
    path: string,
    start = 1,
    end = 0,
  ): Promise<Awaited<ReturnType<WorkspaceFilesPort['readLines']>>> {
    const { task, files } = await this.fileContext(context, path, 'fs.read', 'read');
    const slice = await files.readLines(path, start, end);
    await this.#audit.record({
      taskId: task.taskId,
      sessionId: context.sessionId ?? null,
      toolCallId: context.toolCallId ?? null,
      action: 'fs.read',
      outcome: 'succeeded',
      detail: { path: slice.path, start: slice.start, end: slice.end, bytes: slice.size },
    });
    return slice;
  }

  async deleteFile(context: SandboxContext, path: string): Promise<{ readonly path: string }> {
    const { task, workspace, files } = await this.fileContext(context, path, 'fs.write', 'delete');
    const resolved = files.resolve(path);
    await this.#changes?.beforeWrite({ taskId: task.taskId, path: resolved.relative }).catch(() => undefined);
    const result = await files.deleteFile(path);
    await this.#workspaces.refreshVersion(workspace);
    await this.#audit.record({
      taskId: task.taskId,
      sessionId: context.sessionId ?? null,
      toolCallId: context.toolCallId ?? null,
      action: 'fs.write',
      outcome: 'succeeded',
      detail: { path: result.path, deleted: true },
    });
    return result;
  }

  async readBytes(
    context: SandboxContext,
    path: string,
    maxBytes?: number,
  ): Promise<Uint8Array> {
    const { task, files } = await this.fileContext(context, path, 'fs.read', 'read_image');
    const resolved = files.resolve(path);
    const info = await files.stat(path);
    if (!info) throw new SandboxNotFoundError(`${resolved.relative} does not exist`);
    const bytes = await files.readBytes(path, maxBytes);
    await this.#audit.record({
      taskId: task.taskId,
      sessionId: context.sessionId ?? null,
      toolCallId: context.toolCallId ?? null,
      action: 'fs.read',
      outcome: 'succeeded',
      detail: { path: resolved.relative, bytes: bytes.length, binary: true },
    });
    return bytes;
  }

  async listDir(
    context: SandboxContext,
    path = '.',
    depth = 2,
  ): Promise<Awaited<ReturnType<WorkspaceFilesPort['listDir']>>> {
    const { task, files } = await this.fileContext(context, path, 'fs.list', 'list_dir');
    const listing = await files.listDir(path, depth);
    await this.#audit.record({
      taskId: task.taskId,
      sessionId: context.sessionId ?? null,
      toolCallId: context.toolCallId ?? null,
      action: 'fs.list',
      outcome: 'succeeded',
      detail: { path: listing.path, entries: listing.entries, truncated: listing.truncated },
    });
    return listing;
  }

  async glob(
    context: SandboxContext,
    pattern: string,
    maxResults = 200,
  ): Promise<Awaited<ReturnType<WorkspaceFilesPort['glob']>>> {
    const { task, files } = await this.fileContext(context, '.', 'fs.read', 'glob');
    const found = await files.glob(pattern, maxResults);
    await this.#audit.record({
      taskId: task.taskId,
      sessionId: context.sessionId ?? null,
      toolCallId: context.toolCallId ?? null,
      action: 'fs.glob',
      outcome: 'succeeded',
      detail: { pattern, matches: found.paths.length, truncated: found.truncated },
    });
    return found;
  }

  async grep(
    context: SandboxContext,
    options: Parameters<WorkspaceFilesPort['grep']>[0],
  ): Promise<Awaited<ReturnType<WorkspaceFilesPort['grep']>>> {
    const { task, files } = await this.fileContext(context, options.path ?? '.', 'fs.read', 'grep');
    const result = await files.grep(options);
    await this.#audit.record({
      taskId: task.taskId,
      sessionId: context.sessionId ?? null,
      toolCallId: context.toolCallId ?? null,
      action: 'fs.grep',
      outcome: 'succeeded',
      detail: {
        matches: result.matches,
        files_scanned: result.filesScanned,
        truncated: result.truncated,
      },
    });
    return result;
  }

  async writeFile(
    context: SandboxContext,
    path: string,
    content: string,
  ): Promise<Awaited<ReturnType<WorkspaceFilesPort['writeText']>>> {
    const { task, workspace, files } = await this.fileContext(context, path, 'fs.write', 'write');
    await this.#changes
      ?.beforeWrite({ taskId: task.taskId, path: files.resolve(path).relative })
      .catch(() => undefined);
    const result = await files.writeText(path, content);
    await this.#workspaces.refreshVersion(workspace);
    await this.#audit.record({
      taskId: task.taskId,
      sessionId: context.sessionId ?? null,
      toolCallId: context.toolCallId ?? null,
      action: 'fs.write',
      outcome: 'succeeded',
      detail: { path: result.path, bytes: result.bytes, created: result.created },
    });
    return result;
  }

  async editFile(
    context: SandboxContext,
    options: Parameters<WorkspaceFilesPort['editText']>[0],
  ): Promise<Awaited<ReturnType<WorkspaceFilesPort['editText']>>> {
    const { task, workspace, files } = await this.fileContext(context, options.path, 'fs.write', 'edit');
    await this.#changes
      ?.beforeWrite({ taskId: task.taskId, path: files.resolve(options.path).relative })
      .catch(() => undefined);
    const result = await files.editText(options);
    await this.#workspaces.refreshVersion(workspace);
    await this.#audit.record({
      taskId: task.taskId,
      sessionId: context.sessionId ?? null,
      toolCallId: context.toolCallId ?? null,
      action: 'fs.write',
      outcome: 'succeeded',
      detail: { path: result.path, replacements: result.replacements, bytes: result.bytes },
    });
    return result;
  }

  /** Ask the policy layer whether a file action would be allowed, without doing it. */
  async authorizeFile(
    context: SandboxContext,
    action: 'fs.read' | 'fs.write',
    path: string,
  ): Promise<void> {
    await this.fileContext(context, path, action, action === 'fs.write' ? 'write' : 'read');
  }

  /**
   * Whether a path exists, for the write tool's read-before-overwrite guard.
   *
   * This deliberately does not go through `fileContext`: that path evaluates a
   * permission and consumes a one-time grant, and a stat is not an operation the
   * model is being granted — it is a question the tool asks *before* deciding
   * whether to call `writeFile`, which does evaluate `fs.write`. Consuming an
   * `fs.read` grant here would let a refused overwrite eat the grant a real
   * `read` in the same turn needed. Ownership and the path guard still apply.
   */
  async statFile(
    context: SandboxContext,
    path: string,
  ): Promise<{ path: string; size: number; mtimeMs: number } | null> {
    const task = await this.loadTask(context);
    const workspace = await this.#store.getWorkspace(task.workspaceId);
    if (!workspace) throw new SandboxNotFoundError('workspace is missing');
    return this.#workspaces.files(workspace.storageLocation).stat(path);
  }

  /** The canonical workspace directory, for tool adapters that need to map paths. */
  async workspaceLocation(context: SandboxContext): Promise<string | null> {
    const task = await this.#store.getTask(context.taskId);
    if (!task) return null;
    const workspace = await this.#store.getWorkspace(task.workspaceId);
    return workspace?.storageLocation ?? null;
  }

  private async fileContext(
    context: SandboxContext,
    path: string,
    action: 'fs.read' | 'fs.write' | 'fs.list',
    toolName: string,
  ): Promise<{ task: Task; workspace: Workspace; files: ReturnType<WorkspaceManager['files']> }> {
    const task = await this.loadTask(context);
    const workspace = await this.#store.getWorkspace(task.workspaceId);
    if (!workspace) throw new SandboxNotFoundError('workspace is missing');
    const files = this.#workspaces.files(workspace.storageLocation);
    const resolved = files.resolve(path);
    const permissionRequest: PermissionEvaluationRequest = {
      requestId: `eval_${randomUUID()}`,
      organizationId: this.#settings.permission.organizationId,
      projectId: this.#settings.permission.projectId,
      sessionId: task.sessionId,
      taskId: task.taskId,
      sandboxId: task.sandboxId,
      executionId: null,
      principal: { type: 'agent', id: `agent:${task.taskId}` },
      action: { tool: toolName, operation: action },
      resource: {
        type: 'path',
        identifier: resolved.container,
        scope: [resolved.container],
      },
      context: {
        metadata: { relative_path: resolved.relative, tool_call_id: context.toolCallId ?? null },
      },
    };
    const decision = await this.#permissions.evaluate(permissionRequest);
    if (decision.effect !== 'allow') {
      this.#metrics.increment(decision.effect === 'deny' ? 'policy_denied' : 'approval_required');
      await this.#audit.record({
        taskId: task.taskId,
        sessionId: context.sessionId ?? null,
        toolCallId: context.toolCallId ?? null,
        policyVersion: decision.permissionPolicyVersion,
        action: `execution.authorize:${action}`,
        outcome: decision.effect === 'deny' ? 'denied' : 'approval_required',
        detail: { reason: decision.reason, path: resolved.relative, decision_id: decision.decisionId },
      });
      if (decision.effect === 'deny') throw new SandboxPolicyError(decision.reason);
      throw new SandboxApprovalRequiredError(decision.reason, {
        requestId: decision.requestId,
        approvalRequestId: decision.approvalRequestId ?? null,
      });
    }
    const revalidated = await this.#permissions.revalidate(decision, permissionRequest);
    if (revalidated.effect !== 'allow') {
      if (revalidated.effect === 'deny') throw new SandboxPolicyError(revalidated.reason);
      throw new SandboxApprovalRequiredError(revalidated.reason, {
        requestId: revalidated.requestId,
        approvalRequestId: revalidated.approvalRequestId ?? null,
      });
    }
    if (!(await this.#permissions.consume(revalidated))) {
      throw new SandboxApprovalRequiredError('the one-time grant was already consumed');
    }
    return { task, workspace, files };
  }

  private async loadTask(context: SandboxContext): Promise<Task> {
    assertId('task id', context.taskId);
    const task = await this.#store.getTask(context.taskId);
    if (!task) throw new SandboxNotFoundError(`task ${context.taskId} does not exist`);
    if (context.userId && task.userId !== context.userId) {
      throw new SandboxPolicyError('task belongs to a different user');
    }
    return task;
  }
}

export type WorkspaceFilesPort = {
  readLines: (path: string, start?: number, end?: number) => Promise<{
    text: string;
    path: string;
    start: number;
    end: number;
    totalLines: number;
    complete: boolean;
    chars: number;
    mtimeMs: number;
    size: number;
  }>;
  stat: (path: string) => Promise<{ path: string; size: number; mtimeMs: number } | null>;
  listDir: (path?: string, depth?: number) => Promise<{
    text: string;
    path: string;
    entries: number;
    truncated: boolean;
  }>;
  glob: (pattern: string, maxResults?: number) => Promise<{ paths: string[]; truncated: boolean }>;
  grep: (options: {
    pattern: string;
    path?: string;
    include?: string;
    caseSensitive?: boolean;
    maxResults?: number;
  }) => Promise<{ text: string; matches: number; filesScanned: number; truncated: boolean }>;
  writeText: (path: string, content: string) => Promise<{
    path: string;
    bytes: number;
    lines: number;
    created: boolean;
  }>;
  editText: (options: {
    path: string;
    oldString: string;
    newString: string;
    replaceAll?: boolean;
  }) => Promise<{ path: string; replacements: number; bytes: number }>;
};
