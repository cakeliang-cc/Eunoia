/**
 * File operations on a task workspace, behind the path guard.
 *
 * The agent's file tools do not touch `node:fs` directly any more; they call a
 * port implemented by the Sandbox Gateway, which delegates here. Keeping the
 * mechanics in one class means the path rules, the ignored trees, the credential
 * rule, the binary check and the size limits are enforced once, and the Gateway
 * can apply the *policy* decision before any of them run.
 *
 * There is deliberately no `runCommand` here. Command execution is a different
 * boundary: it must happen inside the container, through the Runtime Manager.
 * The pre-sandbox version of this class spawned a host shell, and leaving that
 * method in place would be the bypass ADR §12.1 forbids.
 */

import { glob as fsGlob, readdir, readFile, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { SandboxError, WorkspaceError } from './errors.ts';
import {
  WorkspacePathGuard,
  type PathGuardOptions,
  type ResolvedPath,
} from './paths.ts';

export { WorkspaceError };

export interface FileSlice {
  readonly text: string;
  readonly path: string;
  readonly start: number;
  readonly end: number;
  readonly totalLines: number;
  readonly complete: boolean;
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

export interface GlobResult {
  readonly paths: string[];
  readonly truncated: boolean;
}

export type WorkspaceChangeKind = 'added' | 'modified' | 'deleted';

/** One file's identity in a workspace snapshot. `sha256` null means unreadable. */
export interface WorkspaceManifestEntry {
  readonly path: string;
  readonly sha256: string | null;
  readonly size: number;
}

export interface GrepResult {
  readonly text: string;
  readonly matches: number;
  readonly filesScanned: number;
  readonly truncated: boolean;
}

export interface ReadLinesOptions {
  readonly start?: number;
  readonly end?: number;
}

export class WorkspaceFiles {
  readonly root: string;
  private readonly pathGuard: WorkspacePathGuard;

  constructor(options: PathGuardOptions) {
    this.pathGuard = new WorkspacePathGuard(options);
    this.root = this.pathGuard.root;
  }

  relativeOf(hostPath: string): string {
    return this.pathGuard.relativeOf(hostPath);
  }

  /** Alias used by the tool port: host path → workspace-relative path. */
  relative(hostPath: string): string {
    return this.pathGuard.relativeOf(hostPath);
  }

  isIgnored(relativePath: string): boolean {
    return this.pathGuard.isIgnored(relativePath);
  }

  isSensitive(relativePath: string): boolean {
    return this.pathGuard.isSensitive(relativePath);
  }

  resolve(input: string): ResolvedPath {
    return this.pathGuard.resolve(input);
  }

  /**
   * Does this path exist, and at what version?
   *
   * No content and no `refuseIgnored`/`refuseSensitive` check: the caller uses
   * this to decide whether a write is a create or an overwrite, and the write
   * itself still goes through `writeAtomically`, which re-checks the nearest
   * real ancestor. A missing path is `null`, not an error.
   */
  async stat(input: string): Promise<{ path: string; size: number; mtimeMs: number } | null> {
    const resolved = this.pathGuard.resolve(input);
    const info = await stat(resolved.host).catch(() => null);
    if (!info) return null;
    return {
      path: resolved.relative,
      size: Number(info.size),
      mtimeMs: Number(info.mtimeMs),
    };
  }

  /**
   * Read a line range with line numbers.
   *
   * The model needs line numbers to narrow a second read or target an edit;
   * content without them makes the whole file an all-or-nothing choice.
   */
  async readLines(input: string, start = 1, end = 0): Promise<FileSlice> {
    const resolved = this.pathGuard.resolve(input);
    const { handle, size, mtimeMs } = await this.pathGuard.openRead(resolved);
    try {
      const buffer = await handle.readFile();
      if (looksBinary(buffer)) throw new WorkspaceError(`${resolved.relative} looks like a binary file`);
      const text = buffer.toString('utf8');
      const lines = text.split(/\r?\n/);
      const totalLines = lines.length;
      const from = clampLine(start, 1, totalLines);
      const requestedEnd = end > 0 ? clampLine(end, from, totalLines) : totalLines;
      const slice = lines.slice(from - 1, requestedEnd);
      const numbered = slice.map((line, offset) => `${String(from + offset).padStart(6, ' ')}\t${line}`);

      return {
        text: numbered.join('\n'),
        path: resolved.relative,
        start: from,
        end: requestedEnd,
        totalLines,
        complete: from === 1 && requestedEnd === totalLines,
        chars: text.length,
        mtimeMs,
        size,
      };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async listDir(input = '.', depth = 2): Promise<DirectoryListing> {
    const resolved = this.pathGuard.resolve(input);
    await this.pathGuard.assertDirectory(resolved);

    const maxDepth = Math.min(Math.max(depth, 1), 4);
    const lines: string[] = [];
    let entries = 0;
    let truncated = false;
    const limit = 500;

    const walk = async (relativePath: string, level: number): Promise<void> => {
      if (level > maxDepth || entries >= limit) return;
      const absolute = relativePath === '.' ? this.root : join(this.root, relativePath);
      const children = await readdir(absolute, { withFileTypes: true }).catch(() => []);
      children.sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
        return left.name.localeCompare(right.name);
      });
      for (const child of children) {
        const childRel = relativePath === '.' ? child.name : `${relativePath}/${child.name}`;
        if (this.pathGuard.isIgnored(childRel) || this.pathGuard.isSensitive(childRel)) continue;
        if (entries >= limit) {
          truncated = true;
          return;
        }
        entries += 1;
        const indent = '  '.repeat(level - 1);
        if (child.isDirectory()) {
          lines.push(`${indent}${child.name}/`);
          await walk(childRel, level + 1);
        } else if (child.isFile()) {
          lines.push(`${indent}${child.name}`);
        }
      }
    };

    await walk(resolved.relative === '.' ? '.' : resolved.relative, 1);
    if (truncated) lines.push(`… [stopped after ${limit} entries]`);
    return {
      text: lines.length > 0 ? lines.join('\n') : '(empty directory)',
      path: resolved.relative,
      entries,
      truncated,
    };
  }

  async glob(pattern: string, maxResults = 200): Promise<GlobResult> {
    const value = pattern.trim();
    if (value.length === 0) throw new WorkspaceError('pattern must not be empty');
    if (isAbsolute(value) || value.split(/[\\/]+/).includes('..')) {
      throw new WorkspaceError('pattern must stay inside the workspace');
    }
    const limit = Math.min(Math.max(maxResults, 1), 1_000);
    const found: string[] = [];
    for await (const entry of fsGlob(value, {
      cwd: this.root,
      exclude: (name: string) => this.pathGuard.isIgnored(name) || this.pathGuard.isSensitive(name),
    })) {
      const rel = entry.split(sep).join('/');
      if (this.pathGuard.isIgnored(rel) || this.pathGuard.isSensitive(rel)) continue;
      found.push(rel);
      if (found.length >= limit) break;
    }
    found.sort((left, right) => left.localeCompare(right));
    return { paths: found, truncated: found.length >= limit };
  }

  async grep(options: {
    pattern: string;
    path?: string;
    include?: string;
    caseSensitive?: boolean;
    maxResults?: number;
  }): Promise<GrepResult> {
    let matcher: RegExp;
    try {
      matcher = new RegExp(options.pattern, options.caseSensitive === false ? 'i' : '');
    } catch (error) {
      throw new WorkspaceError(
        `invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const base = options.path?.trim() || '.';
    const resolved = this.pathGuard.resolve(base);
    // A direct grep of `.env` is the same request as reading it, and must be
    // refused rather than silently return no matches.
    this.pathGuard.refuseIgnored(resolved.relative);
    this.pathGuard.refuseSensitive(resolved.relative);
    await this.pathGuard.assertRealInside(resolved.host);
    const info = await stat(resolved.host).catch(() => null);
    if (!info) throw new WorkspaceError(`no such path: ${resolved.relative}`);
    const files = await this.pathGuard.collectFiles(resolved.relative, 2_000);

    const maxResults = Math.min(Math.max(options.maxResults ?? 100, 1), 500);
    const hits: string[] = [];
    let scanned = 0;
    let truncated = false;
    for (const file of files) {
      if (hits.length >= maxResults) {
        truncated = true;
        break;
      }
      if (!matchesInclude(file, options.include)) continue;
      const target = this.pathGuard.resolve(file);
      const opened = await this.pathGuard.openRead(target).catch(() => null);
      if (!opened) continue;
      let buffer: Buffer;
      try {
        buffer = await opened.handle.readFile();
      } catch {
        continue;
      } finally {
        await opened.handle.close().catch(() => undefined);
      }
      if (looksBinary(buffer)) continue;
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

  async writeText(input: string, content: string): Promise<WriteResult> {
    const resolved = this.pathGuard.resolve(input);
    const existed = await stat(resolved.host).then(
      (info) => info.isFile(),
      () => false,
    );
    await this.pathGuard.writeAtomically(resolved, content);
    return {
      path: resolved.relative,
      bytes: Buffer.byteLength(content, 'utf8'),
      lines: content.split(/\r?\n/).length,
      created: !existed,
    };
  }

  /**
   * Replace an exact string, preserving the file's line endings.
   *
   * A CRLF checkout otherwise makes every multi-line edit fail to find its
   * target: the file looks identical on screen and differs in every `\n`.
   */
  async editText(options: {
    path: string;
    oldString: string;
    newString: string;
    replaceAll?: boolean;
  }): Promise<EditResult> {
    if (options.oldString.length === 0) throw new WorkspaceError('old_string must not be empty');
    const resolved = this.pathGuard.resolve(options.path);
    const { handle } = await this.pathGuard.openRead(resolved);
    let original: string;
    try {
      const buffer = await handle.readFile();
      if (looksBinary(buffer)) throw new WorkspaceError(`${resolved.relative} looks like a binary file`);
      original = buffer.toString('utf8');
    } finally {
      await handle.close().catch(() => undefined);
    }

    const crlf = original.includes('\r\n');
    const normalized = crlf ? original.replace(/\r\n/g, '\n') : original;
    const oldString = options.oldString.replace(/\r\n/g, '\n');
    const newString = options.newString.replace(/\r\n/g, '\n');

    const occurrences = countOccurrences(normalized, oldString);
    if (occurrences === 0) {
      throw new WorkspaceError(
        `old_string was not found in ${resolved.relative}. Read the file again and copy the exact text.`,
      );
    }
    if (occurrences > 1 && options.replaceAll !== true) {
      throw new WorkspaceError(
        `old_string appears ${occurrences} times in ${resolved.relative}; include more surrounding text or set replace_all.`,
      );
    }

    const updated = options.replaceAll === true
      ? normalized.split(oldString).join(newString)
      // The replacer is a function on purpose. With a string replacement,
      // `String.prototype.replace` interprets `$&`, `$$`, `` $` `` and `$'` in
      // `newString` — so editing code whose replacement text contains those
      // sequences (a regex replacement, a template string, a shell snippet)
      // would silently insert the matched text or a fragment of the file
      // instead of the literal string the model asked for.
      : normalized.replace(oldString, () => newString);
    const restored = crlf ? updated.replace(/\n/g, '\r\n') : updated;
    if (restored === original) {
      return { path: resolved.relative, replacements: 0, bytes: Buffer.byteLength(original, 'utf8') };
    }
    await this.pathGuard.writeAtomically(resolved, restored);
    return {
      path: resolved.relative,
      replacements: options.replaceAll === true ? occurrences : 1,
      bytes: Buffer.byteLength(restored, 'utf8'),
    };
  }

  /** A stable digest of the workspace's contents, for checkpoints and versions. */
  /**
   * A path → digest manifest, excluding ignored trees and credential files.
   *
   * This is the fact an undo needs: which files exist, and which bytes they
   * hold. It is content-based, so a rewrite that changes nothing is not a
   * change, and a same-size edit is not mistaken for a no-op.
   */
  async manifest(options: { readonly maxFiles?: number } = {}): Promise<{
    readonly entries: WorkspaceManifestEntry[];
    readonly truncated: boolean;
  }> {
    const files = await this.pathGuard.collectFiles('.', options.maxFiles ?? 20_000);
    const entries: WorkspaceManifestEntry[] = [];
    for (const file of files.sort()) {
      const target = this.pathGuard.resolve(file);
      const info = await this.pathGuard.lstatRegular(target).catch(() => null);
      if (!info) continue;
      const buffer = await readFile(target.host).catch(() => null);
      entries.push({
        path: file,
        sha256: buffer ? createHash('sha256').update(buffer).digest('hex') : null,
        size: Number(info.size),
      });
    }
    return { entries, truncated: files.length >= (options.maxFiles ?? 20_000) };
  }

  /**
   * Remove one workspace file.
   *
   * Only used by an explicit undo, after the caller has proved the file was
   * created by the turn being undone and has not been touched since. Path
   * guards, ignored trees and credentials still apply.
   */
  async deleteFile(input: string): Promise<{ path: string }> {
    const resolved = this.pathGuard.resolve(input);
    if (this.pathGuard.isIgnored(resolved.relative)) {
      throw new WorkspaceError(`${resolved.relative} is in an ignored directory`);
    }
    if (this.pathGuard.isSensitive(resolved.relative)) {
      throw new WorkspaceError(`${resolved.relative} is a protected file`);
    }
    await rm(resolved.host, { force: true });
    return { path: resolved.relative };
  }

  async contentDigest(): Promise<string> {
    const files = await this.pathGuard.collectFiles('.', 20_000);
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256');
    for (const file of files.sort()) {
      hash.update(file);
      hash.update('\0');
      const target = this.pathGuard.resolve(file);
      const size = await this.pathGuard.lstatRegular(target).catch(() => null);
      if (!size) {
        hash.update('missing');
        continue;
      }
      // Hash the content, not just the name: a version that ignores edits is
      // worse than no version at all.
      const buffer = await readFile(target.host).catch(() => null);
      hash.update(buffer ? createHash('sha256').update(buffer).digest('hex') : 'unreadable');
      hash.update('\0');
    }
    return `sha256:${hash.digest('hex')}`;
  }
}

function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8_192).includes(0);
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

/** A relative path is inside the workspace when it does not start with `..`. */
export function isInside(relativePath: string): boolean {
  const rel = relative('.', relativePath);
  return rel !== '..' && !rel.startsWith(`..${sep}`);
}

export { SandboxError };
