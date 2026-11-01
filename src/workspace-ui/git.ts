/**
 * Read-only git inspection for the workbench.
 *
 * The workbench is not the agent: these commands run because a person opened
 * the Changes tab, not because a model asked for them. Even so, they are given
 * no shell, no interactive prompt, a sanitised environment, a hard deadline and
 * a byte cap. `git diff` is asked not to invoke an external diff driver, so a
 * repository cannot turn "show me the change" into "run this program".
 *
 * Nothing here writes to the repository: no index refresh, no locks, no refs.
 */

import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { WorkspaceChange, WorkspaceChangeKind } from './types.ts';

export interface GitRunOptions {
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}

export interface GitRunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

const GIT_ENV = {
  GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_EXTERNAL_DIFF: '',
  GIT_DIFF_OPTS: '--unified=3',
  GIT_CONFIG_PARAMETERS: '',
  LC_ALL: 'C',
} as const;

/** Run one git command. Never through a shell, never unbounded. */
export async function runGit(
  cwd: string,
  args: readonly string[],
  options: GitRunOptions,
): Promise<GitRunResult> {
  return new Promise<GitRunResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const child = spawn('git', ['-C', cwd, ...args], {
      cwd,
      env: { ...process.env, ...GIT_ENV },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      resolve({
        code,
        stdout,
        stderr,
        timedOut,
        truncated,
      });
    };

    const abort = (): void => {
      child.kill('SIGKILL');
      finish(null);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);
    timer.unref();

    options.signal?.addEventListener('abort', abort, { once: true });

    const collect = (chunk: string, into: 'stdout' | 'stderr'): void => {
      if (bytes >= options.maxBytes) {
        truncated = true;
        child.kill('SIGKILL');
        return;
      }
      const remaining = options.maxBytes - bytes;
      const slice = chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
      bytes += Buffer.byteLength(slice, 'utf8');
      if (into === 'stdout') stdout += slice;
      else stderr += slice;
      if (slice.length < chunk.length) {
        truncated = true;
        child.kill('SIGKILL');
      }
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => collect(chunk, 'stdout'));
    child.stderr?.on('data', (chunk: string) => collect(chunk, 'stderr'));
    child.on('error', (error: Error) => {
      stderr += error.message;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

export async function gitAvailable(cwd: string, timeoutMs: number): Promise<boolean> {
  const result = await runGit(cwd, ['--version'], { timeoutMs, maxBytes: 8 * 1024 });
  return result.code === 0 && result.stdout.startsWith('git version');
}

export interface GitSnapshot {
  readonly repo: boolean;
  readonly branch: string | null;
  readonly changes: readonly WorkspaceChange[];
  readonly truncated: boolean;
  readonly error: string | null;
}

function classify(status: string): WorkspaceChangeKind {
  const x = status[0] ?? ' ';
  const y = status[1] ?? ' ';
  if (x === '?' && y === '?') return 'untracked';
  if (x === 'U' || y === 'U' || status === 'AA' || status === 'DD') return 'conflicted';
  if (x === 'R' || y === 'R') return 'renamed';
  if (x === 'C' || y === 'C') return 'copied';
  if (x === 'A' || y === 'A') return 'added';
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'M' || y === 'M') return 'modified';
  if (x === 'T' || y === 'T') return 'typechange';
  return 'unknown';
}

/**
 * Parse `git status --porcelain=v1 -z`.
 *
 * The `-z` form separates fields with NUL and, for a rename or copy, puts the
 * destination first and the source immediately after it. Paths are already
 * relative to the workbench root because the command runs with `--relative`.
 */
export function parseStatus(output: string): WorkspaceChange[] {
  const fields = output.split('\0');
  const changes: WorkspaceChange[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] as string;
    if (field.length < 4) continue;
    const status = field.slice(0, 2);
    const path = field.slice(3);
    if (path.length === 0) continue;
    const renamed = status.includes('R') || status.includes('C');
    const renamedFrom = renamed ? (fields[index + 1] ?? null) : null;
    if (renamed) index += 1;
    changes.push({
      path,
      kind: classify(status),
      status,
      staged: (status[0] ?? ' ') !== ' ' && status[0] !== '?',
      unstaged: (status[1] ?? ' ') !== ' ',
      renamedFrom: renamedFrom && renamedFrom.length > 0 ? renamedFrom : null,
    });
  }
  return changes;
}

export async function gitSnapshot(cwd: string, options: {
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly maxChanges: number;
}): Promise<GitSnapshot> {
  const top = await runGit(cwd, ['rev-parse', '--show-toplevel'], {
    timeoutMs: options.timeoutMs,
    maxBytes: 8 * 1024,
  });
  if (top.code !== 0) {
    const missing = /not a git repository|not found|ENOENT/i.test(top.stderr);
    return {
      repo: false,
      branch: null,
      changes: [],
      truncated: false,
      error: missing ? null : top.stderr.trim() || 'git rev-parse failed',
    };
  }

  const [branch, status] = await Promise.all([
    runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], {
      timeoutMs: options.timeoutMs,
      maxBytes: 8 * 1024,
    }),
    runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes,
    }),
  ]);

  if (status.code !== 0) {
    return {
      repo: true,
      branch: branch.code === 0 ? branch.stdout.trim() || null : null,
      changes: [],
      truncated: status.truncated,
      error: status.stderr.trim() || 'git status failed',
    };
  }

  const parsed = parseStatus(status.stdout);
  // Porcelain paths are relative to the repository root even when git runs in a
  // subdirectory. The workbench only addresses the directory it was given, so a
  // change above that directory is filtered out rather than exposed as `../`.
  const workspaceRoot = await realpath(cwd).catch(() => resolve(cwd));
  const repositoryRoot = await realpath(top.stdout.trim() || cwd).catch(() =>
    resolve(top.stdout.trim() || cwd),
  );
  const toWorkspacePath = (path: string): string | null => {
    const absolute = resolve(repositoryRoot, path);
    const rel = relative(workspaceRoot, absolute);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
    return rel.split(sep).join('/');
  };
  const local: WorkspaceChange[] = [];
  for (const change of parsed) {
    const path = toWorkspacePath(change.path);
    if (path === null) continue;
    const renamedFrom = change.renamedFrom ? toWorkspacePath(change.renamedFrom) : null;
    local.push({ ...change, path, renamedFrom });
  }
  return {
    repo: true,
    branch: branch.code === 0 ? branch.stdout.trim() || null : null,
    changes: local.slice(0, options.maxChanges),
    truncated: status.truncated || local.length > options.maxChanges,
    error: null,
  };
}

export interface GitDiffResult {
  readonly patch: string;
  readonly binary: boolean;
  readonly truncated: boolean;
  readonly error: string | null;
}

/**
 * The working-tree diff for one path.
 *
 * `git diff HEAD` is used rather than `git diff` so staged and unstaged edits
 * appear in one patch; the Changes tab is about what is different from the last
 * commit, not about which side of the index it is on.
 */
export async function gitDiff(
  cwd: string,
  path: string,
  options: { readonly timeoutMs: number; readonly maxBytes: number },
): Promise<GitDiffResult> {
  const result = await runGit(
    cwd,
    [
      'diff',
      'HEAD',
      '--no-ext-diff',
      '--no-color',
      '--unified=3',
      '--relative',
      '--',
      path,
    ],
    { timeoutMs: options.timeoutMs, maxBytes: options.maxBytes },
  );
  if (result.code !== 0 && result.code !== 1) {
    return {
      patch: '',
      binary: false,
      truncated: false,
      error: result.stderr.trim() || 'git diff failed',
    };
  }
  return {
    patch: result.stdout,
    binary: /^Binary files .* differ$/m.test(result.stdout),
    truncated: result.truncated,
    error: null,
  };
}
