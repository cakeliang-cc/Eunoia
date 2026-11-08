/**
 * The single write gate for a real workspace path.
 *
 * Conversation/task ids are not workspace ids: two tasks can be bound to the
 * same source directory, and Team publishes into that source while a normal
 * turn writes a bind workspace. The lock identity is therefore the canonical
 * target path, not the caller.
 *
 * A process-wide queue serializes callers in this process; a `wx` lock file in
 * a private lock directory extends the same exclusion to another local process.
 * A crashed holder leaves a lease whose age is bounded, so the next writer can
 * recover instead of hanging forever. This is a local filesystem lease, not a
 * distributed lock; a multi-host deployment needs a shared coordinator.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const LOCK_TTL_MS = 10 * 60_000;
const ACQUIRE_TIMEOUT_MS = 20_000;
const POLL_MS = 25;
const localQueues = new Map<string, Promise<void>>();

export class WorkspaceLockTimeout extends Error {
  readonly code = 'WORKSPACE_LOCK_TIMEOUT';
  readonly status = 409;

  constructor(path: string) {
    super(`workspace path is locked by another writer: ${path}`);
    this.name = 'WorkspaceLockTimeout';
  }
}

export async function canonicalWriteTarget(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    const parent = await realpath(dirname(absolute)).catch(() => dirname(absolute));
    return join(parent, basename(absolute));
  }
}

/**
 * Acquire the locks for every target, in one global order, then run.
 *
 * Sorting is the deadlock rule: two batches touching `a` and `b` always acquire
 * `a` before `b`, whichever caller arrived first.
 */
export async function withWorkspaceWriteLocks<T>(
  paths: readonly string[],
  run: () => Promise<T>,
): Promise<T> {
  const release = await acquireWorkspaceWriteLocks(paths);
  try {
    return await run();
  } finally {
    await release();
  }
}

/** Explicit acquire/release form for code that already owns the critical body. */
export async function acquireWorkspaceWriteLocks(
  paths: readonly string[],
): Promise<() => Promise<void>> {
  const keys = [...new Set(await Promise.all(paths.map(canonicalWriteTarget)))].sort();
  const releases: Array<() => Promise<void>> = [];
  try {
    for (const key of keys) releases.push(await acquire(key));
  } catch (error) {
    for (const release of releases.reverse()) await release().catch(() => undefined);
    throw error;
  }
  return async () => {
    for (const release of releases.reverse()) await release().catch(() => undefined);
  };
}

async function acquire(key: string): Promise<() => Promise<void>> {
  const previous = localQueues.get(key) ?? Promise.resolve();
  let releaseLocal!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    releaseLocal = resolveGate;
  });
  const next = previous.then(() => gate);
  localQueues.set(key, next);
  await previous;

  let fileRelease: (() => Promise<void>) | null = null;
  try {
    fileRelease = await acquireFileLock(key);
  } catch (error) {
    releaseLocal();
    if (localQueues.get(key) === next) localQueues.delete(key);
    throw error;
  }
  return async () => {
    await fileRelease?.().catch(() => undefined);
    releaseLocal();
    if (localQueues.get(key) === next) localQueues.delete(key);
  };
}

async function acquireFileLock(key: string): Promise<() => Promise<void>> {
  const directory = process.env.EUNOIA_WRITE_LOCK_DIR?.trim() || join(tmpdir(), 'eunoia-write-locks');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const name = `${createHash('sha256').update(key).digest('hex')}.lock`;
  const file = join(directory, name);
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      const handle = await open(file, 'wx', 0o600);
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, key, token: randomUUID(), at: new Date().toISOString() }),
        'utf8',
      );
      await handle.close();
      return async () => {
        await unlink(file).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const info = await stat(file).catch(() => null);
      if (info) {
        const holder = await readHolder(file);
        const dead = holder?.pid !== undefined && holder.pid > 0 && !processAlive(holder.pid);
        if (dead || Date.now() - info.mtimeMs > LOCK_TTL_MS) {
          await unlink(file).catch(() => undefined);
          continue;
        }
      }
      if (Date.now() >= deadline) throw new WorkspaceLockTimeout(key);
      // This timer must stay referenced: an unref'd timer with no other handle
      // lets Node exit with code 0 while a lock is still pending, which is how
      // a resume child silently did nothing in the fault test.
      await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, POLL_MS));
    }
  }
}

async function readHolder(file: string): Promise<{ pid?: number } | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as { pid?: number };
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Test-only visibility; production code never needs the queue internals. */
export function pendingWorkspaceLocks(): number {
  return localQueues.size;
}
