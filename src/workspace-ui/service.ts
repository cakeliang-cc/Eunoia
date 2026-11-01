/**
 * The workbench's filesystem service.
 *
 * This is a person-facing view of a directory: list a level, read one file,
 * ask git what changed, run a command they typed. It is intentionally not the
 * agent's tool workspace. The agent's file tools go through the sandbox and its
 * policy; this service only ever touches the directory the person selected, and
 * it applies the same ignored-tree and credential-file rules the file tools do.
 *
 * Path safety is delegated to `Workspace` from `src/tools/workspace.ts` rather
 * than re-implemented. That class already owns lexical containment, `realpath`
 * checks and no-follow reads; a second copy here would be the one that drifts.
 */

import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative as pathRelative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Workspace } from '../tools/workspace.ts';
import { log } from '../observability/logging.ts';
import type { WorkspaceUiConfig } from './config.ts';
import {
  WorkspaceUiError,
  type WorkspaceBrowse,
  type WorkspaceDiff,
  type WorkspaceEntry,
  type WorkspaceFile,
  type WorkspaceGitStatus,
  type WorkspaceListing,
  type WorkspaceRootSource,
  type WorkspaceState,
} from './types.ts';
import { gitAvailable, gitDiff, gitSnapshot, type GitSnapshot } from './git.ts';

/**
 * The two `Workspace` generations in this repository expose `resolve` slightly
 * differently (a host path at HEAD, a `{ host, relative }` record on the sandbox
 * branch). This structural view is the small surface the workbench needs, so it
 * works against either without importing sandbox types.
 */
interface WorkspaceApi {
  readonly root: string;
  resolve(input: string): unknown;
  relative(hostPath: string): string;
  isIgnored(path: string): boolean;
  isSensitive(path: string): boolean;
  readLines(
    input: string,
    start?: number,
    end?: number,
  ): Promise<{
    readonly text: string;
    readonly path: string;
    readonly start: number;
    readonly end: number;
    readonly totalLines: number;
    readonly complete: boolean;
    readonly size: number;
    readonly mtimeMs: number;
  }>;
}

export interface WorkspaceUiServiceOptions {
  readonly configuredRoot: string | null;
  readonly config: WorkspaceUiConfig;
  /** Injected by tests; production uses the real `git`. */
  readonly git?: boolean;
  readonly now?: () => Date;
}

function asApi(workspace: Workspace): WorkspaceApi {
  return workspace as unknown as WorkspaceApi;
}

function resolvePath(workspace: WorkspaceApi, input: string): { host: string; relative: string } {
  const value = workspace.resolve(input);
  if (typeof value === 'string') {
    return { host: value, relative: workspace.relative(value) };
  }
  if (value !== null && typeof value === 'object') {
    const record = value as { host?: unknown; relative?: unknown };
    if (typeof record.host === 'string' && typeof record.relative === 'string') {
      return { host: record.host, relative: record.relative };
    }
  }
  throw new WorkspaceUiError('invalid-path', 'could not resolve the selected path');
}

function stripLineNumbers(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*\d+\t/, ''))
    .join('\n');
}

function expandHome(input: string): string {
  const value = input.trim();
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2));
  return value;
}

function isWithin(parent: string, child: string): boolean {
  const rel = pathRelative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function mapError(error: unknown): WorkspaceUiError {
  if (error instanceof WorkspaceUiError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/escapes the workspace|outside the workspace|relative to the workspace|must stay inside/i.test(message)) {
    return new WorkspaceUiError('outside-workspace', message, 403);
  }
  if (/credential|sensitive/i.test(message)) return new WorkspaceUiError('sensitive', message, 403);
  if (/ignored directory/i.test(message)) return new WorkspaceUiError('ignored', message, 403);
  if (/binary/i.test(message)) return new WorkspaceUiError('binary', message, 415);
  if (/read limit|larger than|too large/i.test(message)) {
    return new WorkspaceUiError('too-large', message, 413);
  }
  if (/no such file|no such directory|does not exist|ENOENT/i.test(message)) {
    return new WorkspaceUiError('not-found', message, 404);
  }
  if (/not a directory|not a regular file|EISDIR/i.test(message)) {
    return new WorkspaceUiError('not-a-directory', message, 400);
  }
  return new WorkspaceUiError('unavailable', message, 500);
}

export class WorkspaceUiService {
  private workspace: WorkspaceApi | null = null;
  private root: string | null = null;
  private source: WorkspaceRootSource | null = null;
  private readonly agentRoot: string | null;
  private readonly config: WorkspaceUiConfig;
  private gitEnabled: boolean;
  private statusCache: { readonly at: number; readonly value: GitSnapshot } | null = null;

  private constructor(options: WorkspaceUiServiceOptions) {
    this.config = options.config;
    this.gitEnabled = options.git ?? true;
    this.agentRoot = options.configuredRoot ? resolve(expandHome(options.configuredRoot)) : null;
  }

  static async create(options: WorkspaceUiServiceOptions): Promise<WorkspaceUiService> {
    const service = new WorkspaceUiService(options);
    if (options.git === undefined) {
      service.gitEnabled = await gitAvailable(process.cwd(), 5_000);
    }
    const configured = options.configuredRoot ? resolve(expandHome(options.configuredRoot)) : null;
    const persisted = await service.readPersistedRoot();

    // A configured root is an operator statement, so it wins on boot. A root the
    // person picked in the UI is the fallback for a process that was not given
    // one. Both are verified; a stale path should show the empty state, not
    // crash the server.
    const chosen = configured ?? persisted;
    const source: WorkspaceRootSource | null = configured ? 'config' : persisted ? 'selected' : null;
    if (chosen) {
      try {
        await service.adopt(chosen, source ?? 'selected', false);
      } catch (error) {
        log.warn('workspace_ui.root_unavailable', {
          root: chosen,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return service;
  }

  state(): WorkspaceState {
    return {
      configured: this.root !== null,
      root: this.root,
      name: this.root ? basename(this.root) : null,
      source: this.source,
      agentRoot: this.agentRoot,
      terminal: this.config.terminal,
      git: this.gitEnabled,
      maxFileBytes: this.config.maxFileBytes,
      browseStart: this.config.browseStart,
    };
  }

  /** The canonical root, for the terminal helper. */
  get currentRoot(): string | null {
    return this.root;
  }

  /** The terminal's own limits: output is bounded independently of file reads. */
  get terminalLimits(): { readonly timeoutMs: number; readonly maxOutputBytes: number } {
    return {
      timeoutMs: this.config.terminalTimeoutMs,
      maxOutputBytes: this.config.terminalMaxOutputBytes,
    };
  }

  async list(input = '.'): Promise<WorkspaceListing> {
    const workspace = this.requireWorkspace();
    try {
      const { host, relative } = resolvePath(workspace, input);
      const info = await stat(host).catch(() => null);
      if (!info) throw new WorkspaceUiError('not-found', `no such directory: ${relative}`, 404);
      if (!info.isDirectory()) {
        throw new WorkspaceUiError('not-a-directory', `not a directory: ${relative}`, 400);
      }
      await this.assertRealInside(workspace, host);

      const children = await readdir(host, { withFileTypes: true });
      const entries: WorkspaceEntry[] = [];
      let truncated = false;
      for (const child of children) {
        const childRelative = relative === '.' ? child.name : `${relative}/${child.name}`;
        if (workspace.isIgnored(childRelative) || workspace.isSensitive(childRelative)) continue;
        if (entries.length >= this.config.maxListingEntries) {
          truncated = true;
          break;
        }
        entries.push({
          name: child.name,
          path: childRelative,
          type: child.isDirectory() ? 'directory' : child.isFile() ? 'file' : 'other',
        });
      }

      const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
      entries.sort((left, right) => {
        const group = Number(right.type === 'directory') - Number(left.type === 'directory');
        return group !== 0 ? group : collator.compare(left.name, right.name);
      });

      return { path: relative, entries, truncated };
    } catch (error) {
      throw mapError(error);
    }
  }

  async read(input: string, start = 1, end = 0): Promise<WorkspaceFile> {
    const workspace = this.requireWorkspace();
    try {
      const slice = await workspace.readLines(input, start, end);
      return {
        path: slice.path,
        text: stripLineNumbers(slice.text),
        start: slice.start,
        end: slice.end,
        totalLines: slice.totalLines,
        complete: slice.complete,
        size: slice.size,
        mtimeMs: slice.mtimeMs,
      };
    } catch (error) {
      throw mapError(error);
    }
  }

  async browse(input?: string): Promise<WorkspaceBrowse> {
    const requested = input?.trim();
    const candidate = requested && requested.length > 0
      ? resolve(expandHome(requested))
      : (this.config.browseStart || homedir());
    const roots = this.restrictedRoots();

    if (roots.length > 0 && !roots.some((root) => isWithin(root, candidate))) {
      throw new WorkspaceUiError(
        'outside-workspace',
        'this directory is outside the configured browse roots',
        403,
      );
    }

    const resolved = await realpath(candidate).catch(() => null);
    if (!resolved) {
      throw new WorkspaceUiError('not-found', `no such directory: ${candidate}`, 404);
    }
    const info = await stat(resolved).catch(() => null);
    if (!info?.isDirectory()) {
      throw new WorkspaceUiError('not-a-directory', `not a directory: ${candidate}`, 400);
    }

    // A symlink inside a browse root can point outside it; the lexical check
    // above is not the last word.
    const canonicalRoots = await Promise.all(
      roots.map(async (root) => (await realpath(root).catch(() => root))),
    );
    if (canonicalRoots.length > 0 && !canonicalRoots.some((root) => isWithin(root, resolved))) {
      throw new WorkspaceUiError(
        'outside-workspace',
        'this directory is outside the configured browse roots',
        403,
      );
    }

    const children = await readdir(resolved, { withFileTypes: true }).catch(() => []);
    const entries = children
      .filter((child) => child.isDirectory())
      .map((child) => ({ name: child.name, path: join(resolved, child.name) }))
      .sort((left, right) => left.name.localeCompare(right.name));

    const parent = dirname(resolved);
    const canGoUp =
      parent !== resolved &&
      (canonicalRoots.length === 0 || canonicalRoots.some((root) => isWithin(root, parent)));

    return {
      path: resolved,
      parent: canGoUp ? parent : null,
      entries,
      rooted: roots.length > 0,
    };
  }

  async setRoot(input: string): Promise<WorkspaceState> {
    const value = input.trim();
    if (value.length === 0) throw new WorkspaceUiError('invalid-path', 'a directory is required');
    if (value.includes('\0')) throw new WorkspaceUiError('invalid-path', 'invalid path');
    const path = resolve(expandHome(value));
    const roots = this.restrictedRoots();
    if (roots.length > 0) {
      const canonical = await realpath(path).catch(() => null);
      const canonicalRoots = await Promise.all(
        roots.map(async (root) => (await realpath(root).catch(() => root))),
      );
      if (!canonical || !canonicalRoots.some((root) => isWithin(root, canonical))) {
        throw new WorkspaceUiError(
          'outside-workspace',
          'this directory is outside the configured workspace roots',
          403,
        );
      }
    }
    await this.adopt(path, 'selected', true);
    return this.state();
  }

  async gitStatus(): Promise<WorkspaceGitStatus> {
    const root = this.requireRoot();
    if (!this.gitEnabled) {
      return {
        repo: false,
        branch: null,
        changes: [],
        truncated: false,
        error: 'git is not available on this machine',
      };
    }
    const snapshot = await this.snapshot(root);
    return {
      repo: snapshot.repo,
      branch: snapshot.branch,
      changes: snapshot.changes,
      truncated: snapshot.truncated,
      error: snapshot.error,
    };
  }

  async diff(input: string): Promise<WorkspaceDiff> {
    const root = this.requireRoot();
    const workspace = this.requireWorkspace();
    if (!this.gitEnabled) {
      throw new WorkspaceUiError('git-unavailable', 'git is not available on this machine', 503);
    }

    let relativePath: string;
    try {
      relativePath = resolvePath(workspace, input).relative;
    } catch (error) {
      throw mapError(error);
    }
    if (relativePath === '.') {
      throw new WorkspaceUiError('invalid-path', 'a file path is required');
    }
    if (workspace.isIgnored(relativePath) || workspace.isSensitive(relativePath)) {
      throw new WorkspaceUiError('sensitive', 'this file is hidden by the workspace policy', 403);
    }

    const snapshot = await this.snapshot(root);
    const change = snapshot.changes.find((entry) => entry.path === relativePath);
    if (change?.kind === 'untracked') {
      return this.untrackedDiff(relativePath);
    }

    const result = await gitDiff(root, relativePath, {
      timeoutMs: this.config.gitTimeoutMs,
      maxBytes: this.config.maxDiffBytes,
    });
    if (result.error) {
      // A repository with no commits has no HEAD to compare against. The file is
      // tracked in intent but not yet in a commit, so present it as new.
      if (/unknown revision|bad revision|ambiguous argument 'HEAD'/i.test(result.error)) {
        return this.untrackedDiff(relativePath, true);
      }
      throw new WorkspaceUiError('unavailable', result.error, 500);
    }
    return {
      path: relativePath,
      patch: result.patch,
      binary: result.binary,
      untracked: false,
      oversized: false,
      truncated: result.truncated,
    };
  }

  /**
   * Resolve a directory for the terminal. The path must be inside the chosen
   * root; the terminal is not a way to walk out of the workspace.
   */
  async terminalCwd(relativePath: string): Promise<string> {
    const workspace = this.requireWorkspace();
    try {
      const { host, relative } = resolvePath(workspace, relativePath || '.');
      const info = await stat(host).catch(() => null);
      if (!info?.isDirectory()) {
        throw new WorkspaceUiError('not-a-directory', `not a directory: ${relative}`, 400);
      }
      await this.assertRealInside(workspace, host);
      return host;
    } catch (error) {
      throw mapError(error);
    }
  }

  invalidateStatus(): void {
    this.statusCache = null;
  }

  // ---------------------------------------------------------------- internals ---

  private requireRoot(): string {
    if (!this.root) throw new WorkspaceUiError('no-workspace', 'no workspace is selected', 409);
    return this.root;
  }

  private requireWorkspace(): WorkspaceApi {
    if (!this.workspace) throw new WorkspaceUiError('no-workspace', 'no workspace is selected', 409);
    return this.workspace;
  }

  private restrictedRoots(): string[] {
    if (this.config.browseRoots.length === 0) return [];
    return this.config.browseRoots.map((entry) => resolve(expandHome(entry)));
  }

  private async adopt(
    path: string,
    source: WorkspaceRootSource,
    persist: boolean,
  ): Promise<void> {
    const resolved = await realpath(path).catch(() => null);
    if (!resolved) throw new WorkspaceUiError('not-found', `no such directory: ${path}`, 404);
    const info = await stat(resolved);
    if (!info.isDirectory()) {
      throw new WorkspaceUiError('not-a-directory', `not a directory: ${path}`, 400);
    }

    const workspace = new Workspace({
      root: resolved,
      ...(this.config.ignore.length > 0 ? { ignore: this.config.ignore } : {}),
      allowSensitive: this.config.allowSensitive,
      maxFileBytes: this.config.maxFileBytes,
    });

    this.workspace = asApi(workspace);
    this.root = asApi(workspace).root;
    this.source = source;
    this.statusCache = null;
    if (persist) await this.persistRoot(this.root);
  }

  private async assertRealInside(workspace: WorkspaceApi, host: string): Promise<void> {
    const real = await realpath(host).catch(() => null);
    if (!real) throw new WorkspaceUiError('not-found', 'the path no longer exists', 404);
    if (real !== workspace.root && !isWithin(workspace.root, real)) {
      throw new WorkspaceUiError(
        'outside-workspace',
        'this path resolves outside the workspace',
        403,
      );
    }
  }

  private async readPersistedRoot(): Promise<string | null> {
    try {
      const raw = await readFile(this.config.statePath, 'utf8');
      const parsed = JSON.parse(raw) as { root?: unknown };
      return typeof parsed.root === 'string' && parsed.root.length > 0 ? parsed.root : null;
    } catch {
      return null;
    }
  }

  private async persistRoot(root: string): Promise<void> {
    try {
      await mkdir(dirname(this.config.statePath), { recursive: true });
      const temporary = `${this.config.statePath}.${process.pid}.tmp`;
      await writeFile(
        temporary,
        `${JSON.stringify({ root, updatedAt: new Date().toISOString() }, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
      await rename(temporary, this.config.statePath);
    } catch (error) {
      // The choice still applies to this process; only its survival is lost.
      log.warn('workspace_ui.persist_failed', {
        path: this.config.statePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async snapshot(root: string): Promise<GitSnapshot> {
    const now = Date.now();
    if (this.statusCache && now - this.statusCache.at < 1_500) return this.statusCache.value;
    const value = await gitSnapshot(root, {
      timeoutMs: this.config.gitTimeoutMs,
      maxBytes: this.config.maxDiffBytes,
      maxChanges: this.config.maxGitChanges,
    });
    this.statusCache = { at: now, value };
    return value;
  }

  private async untrackedDiff(path: string, trackedButUncommitted = false): Promise<WorkspaceDiff> {
    try {
      const file = await this.read(path);
      const body = file.text.endsWith('\n') ? file.text.slice(0, -1) : file.text;
      const lines = body.length === 0 ? [] : body.split('\n');
      const header = [
        `diff --git a/${path} b/${path}`,
        'new file mode 100644',
        '--- /dev/null',
        `+++ b/${path}`,
        `@@ -0,0 +1,${lines.length} @@`,
      ];
      const patch = [...header, ...lines.map((line) => `+${line}`)].join('\n');
      const trimmed =
        patch.length > this.config.maxDiffBytes
          ? patch.slice(0, this.config.maxDiffBytes)
          : patch;
      return {
        path,
        patch: trimmed,
        binary: false,
        untracked: !trackedButUncommitted,
        oversized: false,
        truncated: trimmed.length < patch.length,
      };
    } catch (error) {
      const mapped = mapError(error);
      if (mapped.code === 'binary') {
        return {
          path,
          patch: '',
          binary: true,
          untracked: true,
          oversized: false,
          truncated: false,
        };
      }
      if (mapped.code === 'too-large') {
        return {
          path,
          patch: '',
          binary: false,
          untracked: true,
          oversized: true,
          truncated: false,
        };
      }
      throw mapped;
    }
  }
}
