/**
 * One workspace, and the only module allowed to turn a model-supplied path into
 * a real one.
 *
 * The model names paths as text. Every path in this file is checked twice: once
 * lexically (an absolute path or a `..` segment is refused before touching the
 * filesystem) and once after `realpath` (a symlink inside the workspace that
 * points outside is refused before it is read). The lexical check alone is the
 * common mistake — it looks sufficient in review and fails the first time a
 * checkout contains a symlink.
 *
 * This is a *path* sandbox, not a process sandbox. `run_command` deliberately
 * runs a real shell with the real environment, so enabling it is a trust
 * decision about the machine, not a claim that this class contains it.
 *
 * See docs/adr/014-coding-tools-and-agent-loop.md.
 */

import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import {
  glob as fsGlob,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Directories that are never worth sending to a model. */
const DEFAULT_IGNORED_DIRS: readonly string[] = [
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
 * Reading one of these would put a secret into the conversation, the logs (as a
 * length), and a provider's request. Refusing by default is the only failure
 * mode that does not depend on the model noticing what it is looking at.
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

export class WorkspaceError extends Error {
  override readonly name = 'WorkspaceError';
}

export interface WorkspaceOptions {
  /** Absolute, or resolved against the process cwd. Must exist. */
  readonly root: string;
  /** Extra directory names or path segments to hide, on top of the defaults. */
  readonly ignore?: readonly string[];
  /** Include credentials in reads and searches. Defaults to false. */
  readonly allowSensitive?: boolean;
  /** One file larger than this is refused rather than truncated. */
  readonly maxFileBytes?: number;
  /** One command's retained stdout/stderr budget, in bytes. */
  readonly maxCommandOutputBytes?: number;
}

export interface FileSlice {
  /** The delivered slice, with 1-based line numbers. */
  readonly text: string;
  /** Workspace-relative path. */
  readonly path: string;
  readonly start: number;
  readonly end: number;
  readonly totalLines: number;
  /** True only when the slice is the whole file. */
  readonly complete: boolean;
  /** Size of the whole file in characters, for the ledger and the trace. */
  readonly chars: number;
  readonly mtimeMs: number;
  readonly size: number;
}

export interface DirectoryListing {
  readonly text: string;
  readonly path: string;
  readonly entries: number;
  readonly truncated: boolean;
}

export interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

export interface EditResult {
  readonly path: string;
  readonly replacements: number;
  readonly bytes: number;
}

export interface WriteResult {
  readonly path: string;
  readonly bytes: number;
  readonly lines: number;
  readonly created: boolean;
}

/**
 * A resolved, sandboxed directory.
 *
 * Construction canonicalises the root, so every later `startsWith` check is
 * against a path with no symlink left in it. Doing this lazily would mean the
 * first write could land outside a root that the process thought was somewhere
 * else.
 */
export class Workspace {
  readonly root: string;
  private readonly ignored: ReadonlySet<string>;
  private readonly allowSensitive: boolean;
  private readonly maxFileBytes: number;
  private readonly maxCommandOutputBytes: number;

  constructor(options: WorkspaceOptions) {
    const requested = resolve(options.root);
    try {
      this.root = realpathSync(requested);
    } catch {
      throw new WorkspaceError(`workspace root does not exist: ${requested}`);
    }
    this.ignored = new Set([...DEFAULT_IGNORED_DIRS, ...(options.ignore ?? [])]);
    this.allowSensitive = options.allowSensitive ?? false;
    this.maxFileBytes = options.maxFileBytes ?? 2 * 1024 * 1024;
    this.maxCommandOutputBytes = options.maxCommandOutputBytes ?? 200 * 1024;
  }

  /** The workspace-relative form of a path, for traces and the model. */
  relative(absolutePath: string): string {
    const rel = relative(this.root, absolutePath);
    return rel.length === 0 ? '.' : rel.split(sep).join('/');
  }

  /**
   * Turn a model-supplied path into an absolute one, refusing escapes.
   *
   * Absolute paths are refused rather than clamped into the root: a model that
   * writes `/etc/hosts` has made a different request from one that writes
   * `etc/hosts`, and silently doing the second is how a sandbox surprises its
   * operator.
   */
  resolve(input: string): string {
    const value = typeof input === 'string' ? input.trim() : '';
    if (value.length === 0) throw new WorkspaceError('path must not be empty');
    if (isAbsolute(value)) {
      throw new WorkspaceError(`path must be relative to the workspace, got ${JSON.stringify(value)}`);
    }
    const resolved = resolve(this.root, value);
    this.assertInside(resolved);
    return resolved;
  }

  /** Whether a workspace-relative path sits in an ignored directory. */
  isIgnored(relativePath: string): boolean {
    const parts = relativePath.split(/[\\/]+/);
    return parts.some((part) => this.ignored.has(part));
  }

  /** Whether a workspace-relative path is a credential file. */
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

  /**
   * Read a line range, with line numbers.
   *
   * The model needs line numbers to make a second, narrower read or to target an
   * edit; returning content without them makes the whole file an all-or-nothing
   * choice and is how a large file ends up in the window twice.
   */
  async readLines(input: string, start = 1, end = 0): Promise<FileSlice> {
    const absolute = this.resolve(input);
    const rel = this.relative(absolute);
    this.refuseIgnored(rel);
    this.refuseSensitive(rel);
    await this.assertRealInside(absolute);

    const info = await stat(absolute).catch(() => null);
    if (!info) throw new WorkspaceError(`no such file: ${rel}`);
    if (!info.isFile()) throw new WorkspaceError(`not a regular file: ${rel}`);
    if (info.size > this.maxFileBytes) {
      throw new WorkspaceError(
        `${rel} is ${info.size} bytes; the read limit is ${this.maxFileBytes}. ` +
          'Read a line range instead of the whole file.',
      );
    }

    const buffer = await readFile(absolute);
    if (looksBinary(buffer)) throw new WorkspaceError(`${rel} looks like a binary file`);
    const text = buffer.toString('utf8');
    const lines = text.split(/\r?\n/);
    const totalLines = lines.length;

    const from = clampLine(start, 1, totalLines);
    const requestedEnd = end > 0 ? clampLine(end, from, totalLines) : totalLines;
    const slice = lines.slice(from - 1, requestedEnd);
    const numbered = slice.map((line, offset) => `${String(from + offset).padStart(6, ' ')}\t${line}`);

    return {
      text: numbered.join('\n'),
      path: rel,
      start: from,
      end: requestedEnd,
      totalLines,
      complete: from === 1 && requestedEnd === totalLines,
      chars: text.length,
      mtimeMs: info.mtimeMs,
      size: info.size,
    };
  }

  /** A directory tree, bounded by depth and entry count. */
  async listDir(input = '.', depth = 2): Promise<DirectoryListing> {
    const absolute = this.resolve(input);
    const rel = this.relative(absolute);
    this.refuseIgnored(rel);
    await this.assertRealInside(absolute);
    const info = await stat(absolute).catch(() => null);
    if (!info) throw new WorkspaceError(`no such directory: ${rel}`);
    if (!info.isDirectory()) throw new WorkspaceError(`not a directory: ${rel}`);

    const maxDepth = Math.min(Math.max(depth, 1), 4);
    const lines: string[] = [];
    let entries = 0;
    let truncated = false;
    const limit = 500;

    const walk = async (dir: string, prefix: string, level: number): Promise<void> => {
      if (level > maxDepth || entries >= limit) return;
      const children = await readdir(dir, { withFileTypes: true });
      children.sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
        return left.name.localeCompare(right.name);
      });
      for (const child of children) {
        const childRel = prefix.length === 0 ? child.name : `${prefix}/${child.name}`;
        if (this.isIgnored(childRel) || this.isSensitive(childRel)) continue;
        if (entries >= limit) {
          truncated = true;
          return;
        }
        entries += 1;
        const indent = '  '.repeat(level - 1);
        if (child.isDirectory()) {
          lines.push(`${indent}${child.name}/`);
          await walk(join(dir, child.name), childRel, level + 1);
        } else if (child.isFile()) {
          lines.push(`${indent}${child.name}`);
        }
      }
    };

    await walk(absolute, rel === '.' ? '' : rel, 1);
    if (truncated) lines.push(`… [stopped after ${limit} entries]`);

    return {
      text: lines.length > 0 ? lines.join('\n') : '(empty directory)',
      path: rel,
      entries,
      truncated,
    };
  }

  /** Match a glob, with the workspace as cwd and ignored trees excluded. */
  async glob(pattern: string, maxResults = 200): Promise<{ paths: string[]; truncated: boolean }> {
    const value = pattern.trim();
    if (value.length === 0) throw new WorkspaceError('pattern must not be empty');
    if (isAbsolute(value) || value.split(/[\\/]+/).includes('..')) {
      throw new WorkspaceError('pattern must stay inside the workspace');
    }

    const limit = Math.min(Math.max(maxResults, 1), 1000);
    const found: string[] = [];
    for await (const entry of fsGlob(value, {
      cwd: this.root,
      exclude: (name: string) => this.isIgnored(name) || this.isSensitive(name),
    })) {
      const rel = entry.split(sep).join('/');
      if (this.isIgnored(rel) || this.isSensitive(rel)) continue;
      found.push(rel);
      if (found.length >= limit) break;
    }
    found.sort((left, right) => left.localeCompare(right));
    return { paths: found, truncated: found.length >= limit };
  }

  /** Search file contents, one regex over the workspace. */
  async grep(options: {
    pattern: string;
    path?: string;
    include?: string;
    caseSensitive?: boolean;
    maxResults?: number;
  }): Promise<{ text: string; matches: number; filesScanned: number; truncated: boolean }> {
    let matcher: RegExp;
    try {
      matcher = new RegExp(options.pattern, options.caseSensitive === false ? 'i' : '');
    } catch (error) {
      throw new WorkspaceError(
        `invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const base = options.path?.trim() || '.';
    const absolute = this.resolve(base);
    const relBase = this.relative(absolute);
    this.refuseIgnored(relBase);
    this.refuseSensitive(relBase);

    const maxResults = Math.min(Math.max(options.maxResults ?? 100, 1), 500);
    const files: string[] = [];
    const maxFiles = 2000;
    const info = await stat(absolute).catch(() => null);
    if (!info) throw new WorkspaceError(`no such path: ${relBase}`);
    if (info.isDirectory()) {
      await this.collectFiles(absolute, relBase === '.' ? '' : relBase, files, maxFiles);
    } else {
      files.push(relBase);
    }

    const hits: string[] = [];
    let scanned = 0;
    let truncated = false;
    for (const file of files) {
      if (hits.length >= maxResults) {
        truncated = true;
        break;
      }
      if (!matchesInclude(file, options.include)) continue;
      const fileInfo = await stat(join(this.root, file)).catch(() => null);
      if (!fileInfo || !fileInfo.isFile() || fileInfo.size > this.maxFileBytes) continue;
      const buffer = await readFile(join(this.root, file)).catch(() => null);
      if (!buffer || looksBinary(buffer)) continue;
      scanned += 1;
      const lines = buffer.toString('utf8').split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        if (hits.length >= maxResults) {
          truncated = true;
          break;
        }
        if (!matcher.test(line)) continue;
        hits.push(`${file}:${index + 1}: ${truncateLine(line, 400)}`);
      }
    }

    return {
      text: hits.length > 0 ? hits.join('\n') : '(no matches)',
      matches: hits.length,
      filesScanned: scanned,
      truncated,
    };
  }

  /** Write a whole file, atomically. Returns whether it existed before. */
  async writeText(input: string, content: string): Promise<WriteResult> {
    const absolute = this.resolve(input);
    const rel = this.relative(absolute);
    this.refuseIgnored(rel);
    this.refuseSensitive(rel);
    if (Buffer.byteLength(content, 'utf8') > this.maxFileBytes) {
      throw new WorkspaceError(`${rel} would exceed the ${this.maxFileBytes}-byte write limit`);
    }

    const existed = await stat(absolute).then(
      (info) => info.isFile(),
      () => false,
    );
    // Check before creating parents as well as after: a symlinked parent plus
    // `mkdir -p` would otherwise create a directory outside the workspace
    // before the post-check notices.
    await this.assertRealInside(absolute);
    await mkdir(dirname(absolute), { recursive: true });
    await this.assertRealInside(absolute);
    await writeAtomically(absolute, content);
    return {
      path: rel,
      bytes: Buffer.byteLength(content, 'utf8'),
      lines: content.split(/\r?\n/).length,
      created: !existed,
    };
  }

  /**
   * Replace an exact string in a file.
   *
   * Line endings are normalised to LF for matching and restored on write. A CRLF
   * checkout otherwise makes every multi-line edit fail to find its target — the
   * file looks identical on screen and differs in every `\n`.
   */
  async editText(options: {
    path: string;
    oldString: string;
    newString: string;
    replaceAll?: boolean;
  }): Promise<EditResult> {
    if (options.oldString.length === 0) throw new WorkspaceError('old_string must not be empty');
    const absolute = this.resolve(options.path);
    const rel = this.relative(absolute);
    this.refuseIgnored(rel);
    this.refuseSensitive(rel);
    await this.assertRealInside(absolute);

    const info = await stat(absolute).catch(() => null);
    if (!info || !info.isFile()) throw new WorkspaceError(`no such file: ${rel}`);
    if (info.size > this.maxFileBytes) throw new WorkspaceError(`${rel} exceeds the edit limit`);

    const original = await readFile(absolute, 'utf8');
    const crlf = original.includes('\r\n');
    const normalized = crlf ? original.replace(/\r\n/g, '\n') : original;
    const oldString = options.oldString.replace(/\r\n/g, '\n');
    const newString = options.newString.replace(/\r\n/g, '\n');

    const occurrences = countOccurrences(normalized, oldString);
    if (occurrences === 0) {
      throw new WorkspaceError(
        `old_string was not found in ${rel}. Read the file again and copy the exact text.`,
      );
    }
    if (occurrences > 1 && options.replaceAll !== true) {
      throw new WorkspaceError(
        `old_string appears ${occurrences} times in ${rel}; include more surrounding text or set replace_all.`,
      );
    }

    const updated = options.replaceAll === true
      ? normalized.split(oldString).join(newString)
      : normalized.replace(oldString, newString);
    const restored = crlf ? updated.replace(/\n/g, '\r\n') : updated;
    if (restored === original) {
      return { path: rel, replacements: 0, bytes: Buffer.byteLength(original, 'utf8') };
    }
    await writeAtomically(absolute, restored);
    return {
      path: rel,
      replacements: options.replaceAll === true ? occurrences : 1,
      bytes: Buffer.byteLength(restored, 'utf8'),
    };
  }

  /**
   * Run a shell command in the workspace.
   *
   * Kept behind `allowCommands` in the policy. Output keeps the *tail*: an exit
   * status, a traceback and a test summary all live at the end, and a middle-out
   * cut reliably removes the part that mattered.
   */
  async runCommand(
    command: string,
    options: { timeoutMs?: number; signal?: AbortSignal; maxOutputBytes?: number } = {},
  ): Promise<CommandResult> {
    const value = command.trim();
    if (value.length === 0) throw new WorkspaceError('command must not be empty');
    const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 120_000, 1_000), 600_000);
    const cap = options.maxOutputBytes ?? this.maxCommandOutputBytes;
    const startedAt = Date.now();

    return new Promise<CommandResult>((resolvePromise, reject) => {
      const child = spawn(value, {
        cwd: this.root,
        shell: true,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      let aborted = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      timer.unref();

      const onAbort = () => {
        aborted = true;
        child.kill('SIGKILL');
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });

      const collect = (chunks: Buffer[], text: Buffer, isStdout: boolean) => {
        const current = isStdout ? stdoutBytes : stderrBytes;
        const room = cap - current;
        if (room <= 0) return;
        const slice = text.length > room ? text.subarray(0, room) : text;
        chunks.push(slice);
        if (isStdout) stdoutBytes += slice.length;
        else stderrBytes += slice.length;
      };
      child.stdout?.on('data', (chunk: Buffer) => collect(stdout, chunk, true));
      child.stderr?.on('data', (chunk: Buffer) => collect(stderr, chunk, false));

      child.on('error', (error) => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        reject(new WorkspaceError(`could not start command: ${error.message}`));
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        if (aborted) {
          reject(new WorkspaceError('command aborted'));
          return;
        }
        resolvePromise({
          exitCode: code,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          timedOut,
          durationMs: Date.now() - startedAt,
        });
      });
    });
  }

  // ------------------------------------------------------------- internals ---

  private assertInside(absolutePath: string): void {
    if (absolutePath === this.root) return;
    if (!absolutePath.startsWith(this.root + sep)) {
      throw new WorkspaceError(
        `path escapes the workspace: ${absolutePath} is not under ${this.root}`,
      );
    }
  }

  private async assertRealInside(absolutePath: string): Promise<void> {
    // Walk up to the nearest ancestor that exists and resolve *that*. Checking
    // only the immediate parent misses the case that actually bites: a
    // symlinked directory one level above a path that does not exist yet, where
    // `mkdir -p` would create the directory outside before a post-check sees it.
    let current = absolutePath;
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

  private refuseIgnored(relativePath: string): void {
    if (this.isIgnored(relativePath)) {
      throw new WorkspaceError(`${relativePath} is inside an ignored directory`);
    }
  }

  private refuseSensitive(relativePath: string): void {
    if (this.isSensitive(relativePath)) {
      throw new WorkspaceError(
        `${relativePath} looks like a credential file; the workspace policy refuses it`,
      );
    }
  }

  private async collectFiles(
    absoluteDir: string,
    relativeDir: string,
    out: string[],
    limit: number,
  ): Promise<void> {
    if (out.length >= limit) return;
    const children = await readdir(absoluteDir, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const rel = relativeDir.length === 0 ? child.name : `${relativeDir}/${child.name}`;
      if (this.isIgnored(rel) || this.isSensitive(rel)) continue;
      if (child.isDirectory()) {
        await this.collectFiles(join(absoluteDir, child.name), rel, out, limit);
      } else if (child.isFile()) {
        out.push(rel);
      }
      if (out.length >= limit) return;
    }
  }
}

function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8192).includes(0);
}

function clampLine(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function truncateLine(line: string, limit: number): string {
  return line.length <= limit ? line : `${line.slice(0, limit)}… [+${line.length - limit}]`;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Write through a temporary file in the same directory.
 *
 * A rename is atomic within a filesystem, so a crash leaves either the old file
 * or the new one, never half of each. The temporary name is random and starts
 * with a dot so a glob in the middle of a write does not pick it up.
 */
async function writeAtomically(absolutePath: string, content: string): Promise<void> {
  const temporary = join(
    dirname(absolutePath),
    `.eunoia-${randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    await writeFile(temporary, content, 'utf8');
    await rename(temporary, absolutePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Match an `include` argument: an extension, an exact name, or a small glob. */
function matchesInclude(file: string, include: string | undefined): boolean {
  const value = include?.trim();
  if (!value) return true;
  const name = basename(file);
  if (!value.includes('*') && !value.includes('?')) {
    const extension = value.startsWith('.') ? value : `.${value}`;
    return name.endsWith(extension) || name === value;
  }
  const pattern = value
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${pattern}$`).test(name) || new RegExp(`^${pattern}$`).test(file);
}
