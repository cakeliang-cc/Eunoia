/**
 * R12 — real process kills, not in-memory exceptions.
 *
 * The parent starts the child with an IPC channel, waits for the child to reach
 * an exact fault point, then SIGKILLs it. The restart uses the same SQLite file
 * or target directory; assertions are made on the durable state and on an
 * external side-effect counter, not on the child's own claim.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHILD = fileURLToPath(new URL('../fixtures/fault-child.ts', import.meta.url));
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function sha(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function runChild(
  args: readonly string[],
  faultPoints = '',
): {
  child: ChildProcess;
  fault: Promise<{ point?: string; state?: Record<string, unknown> }>;
  closed: Promise<void>;
  output: () => string;
} {
  const child = spawn(process.execPath, ['--experimental-strip-types', CHILD, ...args], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, EUNOIA_TEST_FAULT_POINTS: faultPoints },
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => (stdout += String(chunk)));
  child.stderr?.on('data', (chunk) => (stderr += String(chunk)));
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const fault = new Promise<{ point?: string; state?: Record<string, unknown> }>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`child did not reach a fault point: ${stderr}`)),
      20_000,
    );
    child.once('message', (message) => {
      clearTimeout(timer);
      resolve(message as { point?: string; state?: Record<string, unknown> });
    });
    child.once('exit', (code) => {
      if (code !== 0) {
        clearTimeout(timer);
        reject(new Error(`child exited ${String(code)} before a fault: ${stderr}`));
      }
    });
  });
  return { child, fault, closed, output: () => stdout };
}

async function kill(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  child.kill('SIGKILL');
  return new Promise<number | null>((resolve) => child.once('exit', (value) => resolve(value)));
}

async function runAndWait(args: readonly string[]): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, ['--experimental-strip-types', CHILD, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  let output = '';
  let error = '';
  child.stdout?.on('data', (chunk) => (output += String(chunk)));
  child.stderr?.on('data', (chunk) => (error += String(chunk)));
  const code = await new Promise<number | null>((resolve) => child.once('exit', (value) => resolve(value)));
  if (code !== 0) throw new Error(`child exited ${String(code)}: ${error}`);
  return { code, output };
}

describe('R12 — process-level fault injection', () => {
  it('kills after a real tool effect; restart marks the outcome unknown and never re-runs it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eunoia-fault-tool-'));
    cleanups.push(async () => rm(directory, { recursive: true, force: true }));
    const db = join(directory, 'db.sqlite');
    const counter = join(directory, 'counter.txt');
    const done = join(directory, 'done');
    const request = '00000000-0000-4000-8000-0000000000a1';
    const first = runChild(
      ['tool-effect', '--db', db, '--counter', counter, '--request', request, '--done', done],
      'tool.effect.done',
    );
    const info = await first.fault;
    expect(info.point).toBe('tool.effect.done');
    expect(await readFile(counter, 'utf8')).toBe('one\n');
    await kill(first.child);
    expect(await readFile(counter, 'utf8')).toBe('one\n');

    const recovery = runChild(['recover', '--db', db]);
    const code = await new Promise<number | null>((resolve) =>
      recovery.child.once('exit', (value) => resolve(value)),
    );
    expect(code).toBe(0);
    const report = JSON.parse(recovery.output().trim().split('\n').at(-1) as string) as {
      report: { recovered: number; unknownExecutions: number };
      running: number;
    };
    expect(report.report.recovered).toBe(1);
    expect(report.report.unknownExecutions).toBe(1);
    expect(report.running).toBe(0);
    // No replay: the external counter is still exactly one effect.
    expect(await readFile(counter, 'utf8')).toBe('one\n');
  }, 60_000);

  it('kills after the first file of a multi-file publish; the journal says what was applied, and resume finishes the rest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eunoia-fault-publish-'));
    cleanups.push(async () => rm(directory, { recursive: true, force: true }));
    const target = join(directory, 'target');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'a.txt'), 'a0\n');
    await writeFile(join(target, 'b.txt'), 'b0\n');
    const journal = join(directory, 'journal.json');
    const done = join(directory, 'done');
    const spec = join(directory, 'spec.json');
    const files = [
      {
        path: 'a.txt',
        change: 'modified',
        baseHash: sha('a0\n'),
        contentHash: sha('a1\n'),
        bytes: 3,
        executable: false,
        binary: false,
        content: 'a1\n',
      },
      {
        path: 'b.txt',
        change: 'modified',
        baseHash: sha('b0\n'),
        contentHash: sha('b1\n'),
        bytes: 3,
        executable: false,
        binary: false,
        content: 'b1\n',
      },
    ];
    await writeFile(
      spec,
      JSON.stringify({
        targetRoot: target,
        files,
        sourceHashes: { 'a.txt': sha('a0\n'), 'b.txt': sha('b0\n') },
        expectedHashes: { 'a.txt': sha('a0\n'), 'b.txt': sha('b0\n') },
        idempotencyKey: 'publish-fault-1',
        journalPath: journal,
      }),
    );
    const first = runChild(['publish', '--spec', spec, '--done', done], 'team.publish.after-file');
    const info = await first.fault;
    expect(info.point).toBe('team.publish.after-file');
    expect(info.state).toMatchObject({ path: 'a.txt' });
    await kill(first.child);
    const saved = JSON.parse(await readFile(journal, 'utf8')) as {
      applied: string[];
      journal: Array<{ action: string; files?: string[] }>;
    };
    expect(saved.applied).toEqual(['a.txt']);
    expect(saved.journal.some((entry) => entry.action === 'published')).toBe(false);
    expect(await readFile(join(target, 'a.txt'), 'utf8')).toBe('a1\n');
    expect(await readFile(join(target, 'b.txt'), 'utf8')).toBe('b0\n');

    const resume = await runAndWait(['publish', '--spec', spec, '--done', done]);
    expect(resume.code).toBe(0);
    const result = JSON.parse(resume.output.trim().split('\n').at(-1) as string) as {
      ok: boolean;
      applied: string[];
      journal: Array<{ action: string }>;
    };
    expect(result.ok).toBe(true);
    expect(result.journal.some((entry) => entry.action === 'published')).toBe(true);
    expect(await readFile(join(target, 'a.txt'), 'utf8')).toBe('a1\n');
    expect(await readFile(join(target, 'b.txt'), 'utf8')).toBe('b1\n');
    const after = JSON.parse(await readFile(journal, 'utf8')) as { applied: string[] };
    expect(after.applied.sort()).toEqual(['a.txt', 'b.txt']);
  }, 60_000);

  it('does not overwrite a user edit made after the interrupted first file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eunoia-fault-user-'));
    cleanups.push(async () => rm(directory, { recursive: true, force: true }));
    const target = join(directory, 'target');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'a.txt'), 'a0\n');
    await writeFile(join(target, 'b.txt'), 'b0\n');
    const journal = join(directory, 'journal.json');
    const done = join(directory, 'done');
    const spec = join(directory, 'spec.json');
    const files = [
      { path: 'a.txt', change: 'modified', baseHash: sha('a0\n'), contentHash: sha('a1\n'), bytes: 3, executable: false, binary: false, content: 'a1\n' },
      { path: 'b.txt', change: 'modified', baseHash: sha('b0\n'), contentHash: sha('b1\n'), bytes: 3, executable: false, binary: false, content: 'b1\n' },
    ];
    await writeFile(
      spec,
      JSON.stringify({
        targetRoot: target,
        files,
        sourceHashes: { 'a.txt': sha('a0\n'), 'b.txt': sha('b0\n') },
        expectedHashes: { 'a.txt': sha('a0\n'), 'b.txt': sha('b0\n') },
        idempotencyKey: 'publish-fault-user-1',
        journalPath: journal,
      }),
    );
    const first = runChild(['publish', '--spec', spec, '--done', done], 'team.publish.after-file');
    await first.fault;
    await kill(first.child);
    // The user edits the file the interrupted publish already wrote.
    await writeFile(join(target, 'a.txt'), 'user-edit\n');

    const resume = await runAndWait(['publish', '--spec', spec, '--done', done]);
    expect(resume.code).toBe(0);
    const result = JSON.parse(resume.output.trim().split('\n').at(-1) as string) as {
      conflicts: Array<{ path: string; reason: string }>;
    };
    expect(result.conflicts.some((entry) => entry.path === 'a.txt')).toBe(true);
    expect(await readFile(join(target, 'a.txt'), 'utf8')).toBe('user-edit\n');
    expect(await readFile(join(target, 'b.txt'), 'utf8')).toBe('b1\n');
  }, 60_000);

  it('mailbox: a message accepted but not injected survives restart and is consumed exactly once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eunoia-fault-mailbox-'));
    cleanups.push(async () => rm(directory, { recursive: true, force: true }));
    const db = join(directory, 'teams.sqlite');
    const ids = join(directory, 'ids.json');
    const first = runChild(['mailbox-accepted', '--db', db, '--ids', ids], 'mailbox.accepted');
    expect((await first.fault).point).toBe('mailbox.accepted');
    await kill(first.child);
    const drain = await runAndWait(['mailbox-drain', '--db', db, '--ids', ids]);
    const result = JSON.parse(drain.output.trim().split('\n').at(-1) as string) as {
      injected: string[];
      secondPending: number;
    };
    expect(result.injected).toHaveLength(1);
    expect(result.secondPending).toBe(0);
    const again = await runAndWait(['mailbox-drain', '--db', db, '--ids', ids]);
    const second = JSON.parse(again.output.trim().split('\n').at(-1) as string) as {
      injected: string[];
      secondPending: number;
    };
    expect(second.injected).toHaveLength(0);
    expect(second.secondPending).toBe(0);
  }, 60_000);

  it('mailbox: an injected-but-unacknowledged message is not injected again after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eunoia-fault-mailbox-'));
    cleanups.push(async () => rm(directory, { recursive: true, force: true }));
    const db = join(directory, 'teams.sqlite');
    const ids = join(directory, 'ids.json');
    const first = runChild(['mailbox-injected', '--db', db, '--ids', ids], 'mailbox.injected');
    expect((await first.fault).point).toBe('mailbox.injected');
    await kill(first.child);
    const recovered = await runAndWait(['mailbox-injected-recover', '--db', db, '--ids', ids]);
    const result = JSON.parse(recovered.output.trim().split('\n').at(-1) as string) as {
      pending: number;
      before: string | null;
      after: string | null;
    };
    expect(result.pending).toBe(0);
    expect(result.before).toBe('injected');
    expect(result.after).toBe('processed');
  }, 60_000);

  it('team: an expired lease is reconciled after kill/restart and the write task is not re-dispatched', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eunoia-fault-team-'));
    cleanups.push(async () => rm(directory, { recursive: true, force: true }));
    const db = join(directory, 'product.sqlite');
    const teamDb = join(directory, 'teams.sqlite');
    const ids = join(directory, 'ids.json');
    const first = runChild(['team-start', '--db', db, '--team-db', teamDb, '--ids', ids], 'team.model,team.started');
    const info = await first.fault;
    expect(['team.model', 'team.started']).toContain(info.point);
    await kill(first.child);
    const recovered = await runAndWait(['team-recover', '--db', db, '--team-db', teamDb, '--ids', ids]);
    const result = JSON.parse(recovered.output.trim().split('\n').at(-1) as string) as {
      recovered: { interrupted: number; unknown: number };
      runStatus: string | null;
      activationStatus: string | null;
      memberStatus: string | null;
      tasks: string[];
      activationCount: number;
    };
    expect(result.recovered.interrupted + result.recovered.unknown).toBeGreaterThanOrEqual(1);
    expect(['interrupted', 'unknown']).toContain(result.activationStatus);
    expect(result.memberStatus).toBe('idle');
    expect(result.tasks).toContain('pending');
    expect(result.activationCount).toBe(1);
  }, 60_000);

  it('team: a missing model after restart is an explicit failed activation, not a silent replay', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eunoia-fault-team-'));
    cleanups.push(async () => rm(directory, { recursive: true, force: true }));
    const db = join(directory, 'product.sqlite');
    const teamDb = join(directory, 'teams.sqlite');
    const ids = join(directory, 'ids.json');
    const first = runChild(['team-start', '--db', db, '--team-db', teamDb, '--ids', ids], 'team.model,team.started');
    await first.fault;
    await kill(first.child);
    const recovered = await runAndWait([
      'team-recover', '--db', db, '--team-db', teamDb, '--ids', ids, '--followup', '1',
    ]);
    const lines = recovered.output.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const follow = lines.find((entry) => entry['followStatus'] !== undefined);
    expect(follow?.['followStatus']).toBe('failed');
    expect(String(follow?.['followError'] ?? '')).toContain('missing');
  }, 60_000);

  it('team: a response arriving after stop stays interrupted and does not make the run succeed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eunoia-fault-late-'));
    cleanups.push(async () => rm(directory, { recursive: true, force: true }));
    const db = join(directory, 'product.sqlite');
    const teamDb = join(directory, 'teams.sqlite');
    const result = await runAndWait(['team-late', '--db', db, '--team-db', teamDb]);
    const parsed = JSON.parse(result.output.trim().split('\n').at(-1) as string) as {
      status: string;
      runStatus: string | null;
    };
    expect(parsed.status).toBe('interrupted');
    expect(parsed.runStatus).not.toBe('succeeded');
  }, 60_000);
});
