/**
 * Workspace lifecycle, independent of any sandbox.
 *
 * ADR §9: destroying a sandbox must never delete the workspace, and a rebuilt
 * sandbox must mount the same files. That is why the workspace record, its
 * digest and its checkpoints are persisted separately from `sandboxes`.
 *
 * Two modes:
 *
 *   - `bind` mounts the configured project directory (the product's normal,
 *     single-user mode). The workspace identity is derived from the canonical
 *     path so a restart returns the same workspace.
 *   - `copy` materialises a per-task directory under `storageRoot` and mounts
 *     that. This is the mode for more than one task sharing a host: two tasks
 *     then cannot see each other's files, and destroying a sandbox cannot touch
 *     the person's repository.
 *
 * Copy mode excludes the same trees the file tools ignore, and never copies
 * credential files. A sandbox should not start with the host's `.env` in it just
 * because the project had one.
 */

import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { SandboxStore } from './store.ts';
import type { Workspace, WorkspaceCheckpoint, WorkspaceMode } from './types.ts';
import { WorkspaceFiles } from './workspace-files.ts';
import { SandboxError } from './errors.ts';
import { DEFAULT_IGNORED_DIRS } from './paths.ts';

export interface WorkspaceManagerOptions {
  /** Where copy-mode workspaces and checkpoints live. Absolute. */
  readonly storageRoot: string;
  /** The project to bind or copy. Null means an empty workspace. */
  readonly sourceRoot: string | null;
  readonly mode: WorkspaceMode;
  readonly ignore?: readonly string[];
  readonly allowSensitive?: boolean;
  readonly maxFileBytes?: number;
  readonly now?: () => Date;
}

export interface WorkspaceManagerDeps {
  readonly store: SandboxStore;
}

export class WorkspaceManager {
  private readonly store: SandboxStore;
  private readonly options: WorkspaceManagerOptions;
  private readonly now: () => Date;
  private readonly sourceRoot: string | null;
  private readonly masks = new Map<string, { version: string; value: { source: string; target: string }[] }>();

  constructor(deps: WorkspaceManagerDeps, options: WorkspaceManagerOptions) {
    this.store = deps.store;
    this.options = options;
    this.now = options.now ?? (() => new Date());
    if (!isAbsolute(options.storageRoot)) {
      throw new SandboxError('invalid_input', 'workspace storage root must be absolute');
    }
    if (/[,\n\0]/.test(options.storageRoot)) {
      throw new SandboxError(
        'invalid_input',
        'workspace storage root contains a character the container mount syntax cannot quote',
      );
    }
    this.sourceRoot = options.sourceRoot ? resolve(options.sourceRoot) : null;
    if (this.sourceRoot && /[,\n\0]/.test(this.sourceRoot)) {
      throw new SandboxError('invalid_input', 'workspace source root contains a comma');
    }
  }

  /** Create (once) and return the workspace for a task. */
  async ensureForTask(taskId: string): Promise<Workspace> {
    const existing = await this.store.getWorkspaceForTask(taskId);
    if (existing) return existing;

    const at = this.now().toISOString();
    if (this.options.mode === 'bind') {
      if (!this.sourceRoot) {
        throw new SandboxError(
          'invalid_input',
          'bind workspace mode needs a source root (WORKSPACE_ROOT)',
        );
      }
      const realSource = await realpath(this.sourceRoot).catch(() => null);
      if (!realSource) {
        throw new SandboxError('not_found', `workspace source does not exist: ${this.sourceRoot}`);
      }
      const info = await stat(realSource);
      if (!info.isDirectory()) {
        throw new SandboxError('invalid_input', `workspace source is not a directory: ${realSource}`);
      }
      const workspaceId = digestId('ws_bind', realSource);
      // Bind mode is explicitly shared by every task that points at the same
      // project. Return the existing record rather than writing a second row
      // with a different task id and confusing ownership checks.
      const existingForPath = await this.store.getWorkspace(workspaceId);
      if (existingForPath) return existingForPath;
      const workspace: Workspace = {
        workspaceId,
        taskId,
        storageLocation: realSource,
        mode: 'bind',
        currentVersion: await this.files(realSource).contentDigest(),
        createdAt: at,
        updatedAt: at,
      };
      await this.store.saveWorkspace(workspace);
      return workspace;
    }

    const destination = join(this.options.storageRoot, 'tasks', sanitizeName(taskId));
    await mkdir(destination, { recursive: true });
    const empty = (await readdir(destination).catch(() => [])).length === 0;
    if (empty && this.sourceRoot) {
      await copyTree(this.sourceRoot, destination, {
        ignore: this.ignored(),
        skipSensitive: !this.options.allowSensitive,
      });
    }
    const realDestination = await realpath(destination);
    const workspaceId = digestId('ws_copy', realDestination);
    const workspace: Workspace = {
      workspaceId,
      taskId,
      storageLocation: realDestination,
      mode: 'copy',
      currentVersion: await this.files(realDestination).contentDigest(),
      createdAt: at,
      updatedAt: at,
    };
    await this.store.saveWorkspace(workspace);
    return workspace;
  }

  /** The file-operation port for a stored workspace. */
  files(storageLocation: string): WorkspaceFiles {
    return new WorkspaceFiles({
      root: storageLocation,
      ...(this.options.ignore ? { ignore: this.options.ignore } : {}),
      ...(this.options.allowSensitive === undefined
        ? {}
        : { allowSensitive: this.options.allowSensitive }),
      ...(this.options.maxFileBytes === undefined
        ? {}
        : { maxFileBytes: this.options.maxFileBytes }),
    });
  }

  /**
   * Build empty read-only overlays for credential files in a bind workspace.
   *
   * The file tools already refuse `.env`/`*.pem`, but a command inside the
   * container would still see the real file through the bind mount. Masking it
   * with an empty file is the only way to make "commands cannot read host
   * credentials" true without copying the project. Copy mode does not need this:
   * it never copies those files in the first place.
   */
  async maskedCredentials(
    workspace: Workspace,
    refresh = false,
  ): Promise<{ source: string; target: string }[]> {
    if (workspace.mode !== 'bind') return [];
    const cached = this.masks.get(workspace.workspaceId);
    if (!refresh && cached && cached.version === workspace.currentVersion) return cached.value;
    const files = await this.findSensitiveFiles(workspace.storageLocation);
    if (files.length === 0) return [];
    const maskDir = join(this.options.storageRoot, 'masks', workspace.workspaceId);
    await mkdir(maskDir, { recursive: true });
    const masks: { source: string; target: string }[] = [];
    for (const relativePath of files) {
      const source = join(maskDir, createHash('sha256').update(relativePath).digest('hex').slice(0, 32));
      await writeFile(source, '', { mode: 0o444, flag: 'wx' }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
      masks.push({ source, target: `/workspace/${relativePath}` });
    }
    this.masks.set(workspace.workspaceId, { version: workspace.currentVersion, value: masks });
    return masks;
  }

  private async findSensitiveFiles(root: string): Promise<string[]> {
    const out: string[] = [];
    const ignored = new Set(this.ignored());
    const guard = this.files(root);
    let visited = 0;
    const walk = async (relativePath: string): Promise<void> => {
      if (out.length >= 64 || visited >= 5_000) return;
      const absolute = relativePath.length === 0 ? root : join(root, relativePath);
      const entries = await readdir(absolute, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (out.length >= 64 || visited >= 5_000) return;
        if (entry.isSymbolicLink()) continue;
        const child = relativePath.length === 0 ? entry.name : `${relativePath}/${entry.name}`;
        if (entry.isDirectory()) {
          if (ignored.has(entry.name)) continue;
          await walk(child);
          continue;
        }
        if (!entry.isFile()) continue;
        visited += 1;
        if (guard.isSensitive(child)) out.push(child);
      }
    };
    await walk('');
    return out.sort();
  }

  /** Refresh the persisted digest after a successful write. */
  async refreshVersion(workspace: Workspace): Promise<string> {
    const version = await this.files(workspace.storageLocation).contentDigest();
    await this.store.updateWorkspaceVersion(workspace.workspaceId, version, this.now().toISOString());
    return version;
  }

  /**
   * Snapshot a workspace.
   *
   * Checkpoints are ordinary directories, not events in the session log: a
   * checkpoint that only existed as an event would be lost with the log that
   * described it. Excluded trees are the same ones the file tools ignore, so a
   * `node_modules` does not make a checkpoint take a minute.
   */
  async createCheckpoint(
    workspace: Workspace,
    sourceExecutionId: string | null = null,
  ): Promise<WorkspaceCheckpoint> {
    const at = this.now().toISOString();
    const checkpointId = `ckpt_${randomUUID()}`;
    const destination = join(
      this.options.storageRoot,
      'checkpoints',
      workspace.workspaceId,
      checkpointId.replace(/^ckpt_/, ''),
    );
    await mkdir(destination, { recursive: true });
    await copyTree(workspace.storageLocation, destination, {
      ignore: this.ignored(),
      skipSensitive: !this.options.allowSensitive,
    });
    const checkpoint: WorkspaceCheckpoint = {
      checkpointId,
      workspaceId: workspace.workspaceId,
      taskId: workspace.taskId,
      createdAt: at,
      sourceExecutionId,
      contentDigest: await this.files(destination).contentDigest(),
      storageLocation: destination,
    };
    await this.store.saveCheckpoint(checkpoint);
    return checkpoint;
  }

  /** Snapshot identity for the active workspace, excluding ignored/secret files. */
  async manifest(workspace: Workspace): Promise<{
    readonly entries: import('./workspace-files.ts').WorkspaceManifestEntry[];
    readonly truncated: boolean;
  }> {
    return this.files(workspace.storageLocation).manifest();
  }

  /**
   * Read one file from a checkpoint, for a turn undo.
   *
   * The checkpoint id is validated against the workspace before its directory is
   * read; a caller cannot turn an arbitrary id into a path. Returns null when
   * the checkpoint was pruned, which is an honest "cannot undo" rather than an
   * empty file.
   */
  async readCheckpointFile(
    workspaceId: string,
    checkpointId: string,
    relativePath: string,
  ): Promise<Buffer | null> {
    const checkpoints = await this.store.listCheckpoints(workspaceId);
    const checkpoint = checkpoints.find((entry) => entry.checkpointId === checkpointId);
    if (!checkpoint) return null;
    const root = resolve(checkpoint.storageLocation);
    const target = resolve(root, relativePath);
    if (target !== root && !target.startsWith(`${root}${sep}`)) return null;
    return readFile(target).catch(() => null);
  }

  /**
   * Restore a checkpoint over the workspace.
   *
   * Files present in the checkpoint are overwritten; files created after the
   * checkpoint are left in place rather than deleted. Deleting is the one
   * operation a recovery path must never guess at: an extra file is recoverable,
   * a removed one may not be.
   */
  async restoreCheckpoint(
    checkpoint: WorkspaceCheckpoint,
    workspace: Workspace,
  ): Promise<void> {
    if (checkpoint.workspaceId !== workspace.workspaceId) {
      throw new SandboxError('forbidden', 'checkpoint belongs to a different workspace');
    }
    await copyTree(checkpoint.storageLocation, workspace.storageLocation, {
      ignore: this.ignored(),
      skipSensitive: false,
    });
    await this.refreshVersion(workspace);
  }

  /**
   * Delete a workspace's data.
   *
   * Only copy mode may delete files: in bind mode the workspace *is* the user's
   * repository, and the sandbox platform must never own that decision.
   */
  async destroy(workspace: Workspace): Promise<boolean> {
    if (workspace.mode === 'bind') return false;
    await rm(workspace.storageLocation, { recursive: true, force: true });
    await rm(join(this.options.storageRoot, 'checkpoints', workspace.workspaceId), {
      recursive: true,
      force: true,
    });
    return this.store.deleteWorkspace(workspace.workspaceId);
  }

  /**
   * Remove checkpoint directories older than the retention window.
   *
   * Checkpoints are copies, not rows; deleting the row without the directory
   * would leave disk usage that the database no longer explains.
   */
  async pruneCheckpoints(olderThanMs: number): Promise<number> {
    const root = join(this.options.storageRoot, 'checkpoints');
    const cutoff = this.now().getTime() - olderThanMs;
    let removed = 0;
    const workspaces = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const workspace of workspaces) {
      if (!workspace.isDirectory()) continue;
      const workspaceDir = join(root, workspace.name);
      const checkpoints = await readdir(workspaceDir, { withFileTypes: true }).catch(() => []);
      for (const checkpoint of checkpoints) {
        if (!checkpoint.isDirectory()) continue;
        const path = join(workspaceDir, checkpoint.name);
        const info = await stat(path).catch(() => null);
        if (!info || info.mtimeMs >= cutoff) continue;
        await rm(path, { recursive: true, force: true });
        removed += 1;
      }
    }
    return removed;
  }

  /** Verify a workspace is still readable; used by recovery before reconnecting. */
  async verify(workspace: Workspace): Promise<{ ok: boolean; detail: string }> {
    try {
      const info = await stat(workspace.storageLocation);
      if (!info.isDirectory()) {
        return { ok: false, detail: `${workspace.workspaceId} is not a directory` };
      }
      const files = this.files(workspace.storageLocation);
      await files.listDir('.', 1);
      return { ok: true, detail: 'workspace readable' };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  private ignored(): readonly string[] {
    return [...DEFAULT_IGNORED_DIRS, ...(this.options.ignore ?? [])];
  }
}

/** `ws_<8 hex>` from a stable string; collisions are not a practical concern. */
function digestId(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function sanitizeName(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  return `${safe}_${createHash('sha256').update(value).digest('hex').slice(0, 8)}`;
}

interface CopyOptions {
  readonly ignore: readonly string[];
  readonly skipSensitive: boolean;
}

const SENSITIVE = /(^\.env($|\.))|(\.pem$)|(\.key$)|(\.p12$)|(\.pfx$)|(\.cer$)|(^id_rsa$)|(^id_ed25519$)|(^credentials$)|(^credentials\.json$)|(^secrets\.json$)/;

/**
 * Recursive copy without following symlinks.
 *
 * A symlink in a checkout can point at `/` or at a person's home directory; a
 * copy that followed one would put host credentials inside the sandbox. Links
 * are skipped and reported by their absence, never resolved.
 */
async function copyTree(from: string, to: string, options: CopyOptions): Promise<void> {
  const entries = await readdir(from, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (options.ignore.includes(entry.name)) continue;
    if (options.skipSensitive && SENSITIVE.test(entry.name)) continue;
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await mkdir(target, { recursive: true });
      await copyTree(source, target, options);
    } else if (entry.isFile()) {
      await cp(source, target, { force: true });
    }
  }
}

/** For tests and diagnostics: is `child` inside `parent`? */
export function isInsideDirectory(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
