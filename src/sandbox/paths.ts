/**
 * The workspace path guard: the only place a model-supplied path becomes a real
 * host path.
 *
 * ADR §3.4 is specific about what is not enough: a string prefix check on
 * `/workspace/../etc/passwd` accepts an escape because the string starts with
 * `/workspace`. The checks here are therefore layered:
 *
 *   1. **Lexical.** Absolute paths, `..`, NUL bytes and empty segments are
 *      refused before the filesystem is touched.
 *   2. **Canonical.** The resolved path is compared against the *real* root
 *      (`realpath` at construction), not the configured string.
 *   3. **Ancestor.** For a path that does not exist yet, the nearest existing
 *      ancestor is resolved; otherwise `mkdir -p` through a symlinked directory
 *      creates the directory outside before a post-check sees it.
 *   4. **No-follow.** Reads open with `O_NOFOLLOW` and `fstat` the descriptor, so
 *      a symlink swapped in between the check and the read is not followed.
 *   5. **Deny lists.** Credential-looking names and ignored trees are refused
 *      even when they are inside the workspace.
 *
 * Container paths are a separate, closed vocabulary: `/workspace/<relative>`.
 * A host path can never be named by the model, and a container path is converted
 * back through this guard rather than trusted.
 *
 * Residual risk, stated rather than hidden: Node has no `openat`, so a writer
 * that swaps a *parent* directory between the ancestor check and the rename can
 * still win a race. The mount namespace is the real boundary for the agent; this
 * guard protects the host-side file tools that the server itself runs. Hardlinks
 * inside the workspace are not rejected (a legitimate checkout can contain them),
 * but the sandbox mount does not expose host paths that could be linked to.
 */

import { constants, realpathSync } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { WORKSPACE_MOUNT_PATH } from './types.ts';
import { SandboxError, WorkspaceError } from './errors.ts';

/** Directories that are never worth sending to a model. */
export const DEFAULT_IGNORED_DIRS: readonly string[] = [
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.turbo',
  '.venv',
  'build',
  'coverage',
  'dist',
  'node_modules',
  '__pycache__',
  'target',
  'vendor',
];

/**
 * Files whose contents are credentials, not code.
 *
 * The same policy as the pre-sandbox workspace, preserved on purpose: tightening
 * isolation must not loosen the credential rule that was already there.
 */
const SENSITIVE_NAMES: readonly string[] = [
  '.npmrc',
  '.pypirc',
  'credentials',
  'credentials.json',
  'id_ed25519',
  'id_rsa',
  'secrets.json',
];
const SENSITIVE_SUFFIXES: readonly string[] = ['.cer', '.key', '.p12', '.pem', '.pfx'];

export interface PathGuardOptions {
  /** Absolute workspace root. Created by the workspace manager before use. */
  readonly root: string;
  readonly ignore?: readonly string[];
  /** Include credentials in reads and searches. Defaults to false. */
  readonly allowSensitive?: boolean;
  /** One file larger than this is refused rather than truncated. */
  readonly maxFileBytes?: number;
}

export interface ResolvedPath {
  /** Workspace-relative, `/`-separated. `.` for the root itself. */
  readonly relative: string;
  /** Container path, always under `/workspace`. */
  readonly container: string;
  /** Canonical host path. */
  readonly host: string;
}

export class WorkspacePathGuard {
  readonly root: string;
  private readonly ignored: ReadonlySet<string>;
  private readonly allowSensitive: boolean;
  readonly maxFileBytes: number;

  constructor(options: PathGuardOptions) {
    this.root = realpathSyncOrThrow(resolve(options.root));
    this.ignored = new Set([...DEFAULT_IGNORED_DIRS, ...(options.ignore ?? [])]);
    this.allowSensitive = options.allowSensitive ?? false;
    this.maxFileBytes = options.maxFileBytes ?? 2 * 1024 * 1024;
  }

  /** Workspace-relative form of a host path, for traces and the model. */
  relativeOf(hostPath: string): string {
    const rel = relative(this.root, hostPath);
    return rel.length === 0 ? '.' : rel.split(sep).join('/');
  }

  /**
   * Turn a model-supplied workspace-relative path into a host path.
   *
   * Absolute paths are refused rather than clamped: `/etc/hosts` and
   * `etc/hosts` are different requests, and silently doing the second is how a
   * sandbox surprises its operator.
   */
  resolve(input: string): ResolvedPath {
    const value = typeof input === 'string' ? input.trim() : '';
    if (value.length === 0) throw new WorkspaceError('path must not be empty');
    if (value.includes('\0')) throw new WorkspaceError('path must not contain NUL bytes');
    if (isAbsolute(value)) {
      throw new WorkspaceError(
        `path must be relative to the workspace, got ${JSON.stringify(value)}`,
      );
    }
    // Newlines in a path are a shell-injection primitive for any caller that
    // later interpolates it; the tools never need one.
    if (/[\r\n]/.test(value)) throw new WorkspaceError('path must not contain newlines');

    const normalized = normalizeRelative(value);
    const host = resolve(this.root, normalized);
    this.assertInside(host);
    return { relative: normalized, container: this.toContainerPath(normalized), host };
  }

  /** Convert a canonical container path (`/workspace/...`) to a guarded path. */
  fromContainer(input: string): ResolvedPath {
    if (!input.startsWith(WORKSPACE_MOUNT_PATH)) {
      throw new WorkspaceError(`only ${WORKSPACE_MOUNT_PATH} is addressable, got ${input}`);
    }
    const suffix = input.slice(WORKSPACE_MOUNT_PATH.length).replace(/^\/+/, '');
    return this.resolve(suffix.length === 0 ? '.' : suffix);
  }

  toContainerPath(relativePath: string): string {
    return relativePath === '.' ? WORKSPACE_MOUNT_PATH : `${WORKSPACE_MOUNT_PATH}/${relativePath}`;
  }

  isIgnored(relativePath: string): boolean {
    const parts = relativePath.split('/');
    return parts.some((part) => this.ignored.has(part));
  }

  isSensitive(relativePath: string): boolean {
    if (this.allowSensitive) return false;
    const name = basename(relativePath);
    if (name === '.env.example' || name === '.env.sample' || name === '.env.template') {
      return false;
    }
    if (name === '.env' || name.startsWith('.env.')) return true;
    if (SENSITIVE_NAMES.includes(name)) return true;
    return SENSITIVE_SUFFIXES.some((suffix) => name.endsWith(suffix));
  }

  refuseIgnored(relativePath: string): void {
    if (this.isIgnored(relativePath)) {
      throw new WorkspaceError(`${relativePath} is inside an ignored directory`);
    }
  }

  refuseSensitive(relativePath: string): void {
    if (this.isSensitive(relativePath)) {
      throw new WorkspaceError(
        `${relativePath} looks like a credential file; the workspace policy refuses it`,
      );
    }
  }

  /**
   * Refuse a path whose real location is outside the workspace.
   *
   * Walks up to the nearest existing ancestor: checking only the immediate parent
   * misses `mkdir -p` through a symlinked grandparent.
   */
  async assertRealInside(hostPath: string): Promise<void> {
    let current = hostPath;
    while (true) {
      const real = await realpath(current).catch(() => null);
      if (real !== null) {
        this.assertInside(real);
        return;
      }
      this.assertInside(current);
      const parent = dirname(current);
      if (parent === current) return;
      current = parent;
    }
  }

  /**
   * Open a file for reading without following a final-component symlink.
   *
   * Returns a descriptor and its stat; the caller closes it. Using one descriptor
   * for stat and read is what removes the window between "it is a regular file"
   * and "read the regular file".
   */
  async openRead(resolved: ResolvedPath): Promise<{
    readonly handle: Awaited<ReturnType<typeof open>>;
    readonly size: number;
    readonly mtimeMs: number;
  }> {
    this.refuseIgnored(resolved.relative);
    this.refuseSensitive(resolved.relative);
    await this.assertRealInside(resolved.host);

    let handle;
    try {
      handle = await open(resolved.host, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      const code = nodeErrorCode(error);
      if (code === 'ELOOP') {
        throw new WorkspaceError(`${resolved.relative} is a symbolic link; refusing to follow it`);
      }
      if (code === 'EACCES' || code === 'EPERM') {
        throw new WorkspaceError(`${resolved.relative} is not readable by the server process`);
      }
      throw new SandboxError('not_found', `no such file: ${resolved.relative}`);
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) {
        throw new WorkspaceError(`not a regular file: ${resolved.relative}`);
      }
      if (info.size > this.maxFileBytes) {
        throw new WorkspaceError(
          `${resolved.relative} is ${info.size} bytes; the read limit is ${this.maxFileBytes}. ` +
            'Read a line range instead of the whole file.',
        );
      }
      return { handle, size: info.size, mtimeMs: info.mtimeMs };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  /** Refuse a directory that is, or is reached through, a symlink. */
  async assertDirectory(resolved: ResolvedPath): Promise<void> {
    this.refuseIgnored(resolved.relative);
    await this.assertRealInside(resolved.host);
    const info = await lstat(resolved.host).catch(() => null);
    if (!info) throw new SandboxError('not_found', `no such directory: ${resolved.relative}`);
    if (info.isSymbolicLink()) {
      throw new WorkspaceError(`${resolved.relative} is a symbolic link; refusing to follow it`);
    }
    if (!info.isDirectory()) throw new WorkspaceError(`not a directory: ${resolved.relative}`);
  }

  /** Ensure a parent directory exists inside the workspace, and re-check it. */
  async ensureParent(resolved: ResolvedPath): Promise<void> {
    const parent = dirname(resolved.host);
    this.assertInside(parent);
    await mkdir(parent, { recursive: true });
    await this.assertRealInside(parent);
  }

  /**
   * Write a file atomically, through a temporary in the same directory.
   *
   * A rename is atomic within a filesystem, so a crash leaves either the old file
   * or the new one. The temporary name is random and dot-prefixed so a concurrent
   * glob does not pick it up.
   */
  async writeAtomically(resolved: ResolvedPath, content: string): Promise<void> {
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > this.maxFileBytes) {
      throw new WorkspaceError(
        `${resolved.relative} would exceed the ${this.maxFileBytes}-byte write limit`,
      );
    }
    this.refuseIgnored(resolved.relative);
    this.refuseSensitive(resolved.relative);
    await this.assertRealInside(resolved.host);
    await this.ensureParent(resolved);

    // The final component may be a symlink pointing out of the workspace. Writing
    // through it would escape; refuse it explicitly instead of relying on rename
    // semantics, which replace the link rather than following it.
    const existing = await lstat(resolved.host).catch(() => null);
    if (existing?.isSymbolicLink()) {
      throw new WorkspaceError(`${resolved.relative} is a symbolic link; refusing to write through it`);
    }
    if (existing && !existing.isFile()) {
      throw new WorkspaceError(`not a regular file: ${resolved.relative}`);
    }

    const temporary = join(
      dirname(resolved.host),
      `.eunoia-${randomBytes(6).toString('hex')}.tmp`,
    );
    try {
      await writeFile(temporary, content, { encoding: 'utf8', mode: 0o644, flag: 'wx' });
      await rename(temporary, resolved.host);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** One stat that refuses a final-component symlink. */
  async lstatRegular(resolved: ResolvedPath): Promise<{ size: number; mtimeMs: number }> {
    this.refuseIgnored(resolved.relative);
    this.refuseSensitive(resolved.relative);
    await this.assertRealInside(resolved.host);
    const info = await lstat(resolved.host).catch(() => null);
    if (!info) throw new SandboxError('not_found', `no such file: ${resolved.relative}`);
    if (info.isSymbolicLink()) {
      throw new WorkspaceError(`${resolved.relative} is a symbolic link; refusing to follow it`);
    }
    if (!info.isFile()) throw new WorkspaceError(`not a regular file: ${resolved.relative}`);
    if (info.size > this.maxFileBytes) {
      throw new WorkspaceError(`${resolved.relative} exceeds the read limit`);
    }
    return { size: info.size, mtimeMs: info.mtimeMs };
  }

  /** Files under a directory, skipping ignored and sensitive entries. */
  async collectFiles(relativeDir: string, limit = 2_000): Promise<string[]> {
    const out: string[] = [];
    const base = relativeDir === '.' ? '' : relativeDir;
    const walk = async (relativePath: string): Promise<void> => {
      if (out.length >= limit) return;
      const absolute = relativePath.length === 0 ? this.root : join(this.root, relativePath);
      const entries = await readdir(absolute, { withFileTypes: true }).catch(() => []);
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (out.length >= limit) return;
        const child = relativePath.length === 0 ? entry.name : `${relativePath}/${entry.name}`;
        if (this.isIgnored(child) || this.isSensitive(child)) continue;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(child);
        else if (entry.isFile()) out.push(child);
      }
    };
    const startInfo = await stat(relativeDir === '.' ? this.root : join(this.root, base)).catch(
      () => null,
    );
    if (startInfo?.isDirectory()) await walk(base);
    else if (startInfo?.isFile()) out.push(base);
    return out;
  }

  private assertInside(absolutePath: string): void {
    if (absolutePath === this.root) return;
    if (!absolutePath.startsWith(this.root + sep)) {
      throw new WorkspaceError(
        `path escapes the workspace: ${absolutePath} is not under ${this.root}`,
      );
    }
  }
}

/** `resolve` that refuses a root which does not exist yet. */
function realpathSyncOrThrow(path: string): string {
  try {
    // `realpathSync` is deliberate: the guard must never hold a root string that
    // is a symlink, or every later prefix check is against the wrong path.
    return realpathSync(path);
  } catch {
    throw new SandboxError('not_found', `workspace root does not exist: ${path}`);
  }
}

function normalizeRelative(value: string): string {
  const parts: string[] = [];
  for (const part of value.split(/[\\/]+/)) {
    if (part.length === 0 || part === '.') continue;
    if (part === '..') {
      throw new WorkspaceError(`path escapes the workspace: ".." is not allowed (${value})`);
    }
    parts.push(part);
  }
  return parts.length === 0 ? '.' : parts.join('/');
}

function nodeErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}
