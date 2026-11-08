/**
 * Process and preview lifecycle over a real local shell.
 *
 * The production executor is the sandbox gateway; this test uses the same shell
 * scripts on the host to exercise cursors, exit codes, input, stop and process
 * identity without requiring Docker in every test run. The container path is
 * covered separately by the live smoke check.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { ProcessService } from '../../src/processes/service.ts';
import type { ProcessRunContext } from '../../src/processes/service.ts';
import type { ToolExecutionResult, ToolExecutor } from '../../src/tools/types.ts';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

class LocalExecutor implements ToolExecutor {
  readonly cwd: string;
  constructor(cwd: string) {
    this.cwd = cwd;
  }
  async run(input: {
    readonly command: readonly string[];
    readonly shell?: boolean;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
    readonly toolCallId: string;
  }): Promise<ToolExecutionResult> {
    const started = Date.now();
    const [command, ...args] = input.command;
    if (!command) throw new Error('no command');
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: this.cwd,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
        if (stdout.length > 200_000) stdout = stdout.slice(0, 200_000);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
        if (stderr.length > 200_000) stderr = stderr.slice(0, 200_000);
      });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, input.timeoutMs ?? 30_000);
      timer.unref();
      const abort = (): void => {
        child.kill('SIGKILL');
      };
      input.signal?.addEventListener('abort', abort, { once: true });
      child.on('close', (code) => {
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', abort);
        resolve({
          status: timedOut ? 'TIMEOUT' : code === 0 ? 'SUCCEEDED' : 'FAILED',
          exitCode: code,
          stdout,
          stderr,
          timedOut,
          durationMs: Date.now() - started,
        });
      });
    });
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'eunoia-process-'));
  cleanups.push(async () => rm(root, { recursive: true, force: true }));
  const store = new InMemoryStore();
  const service = new ProcessService({ store });
  const context: ProcessRunContext = {
    executor: new LocalExecutor(root),
    userId: 'u1',
    conversationId: 'c1',
    taskId: 'c1',
    toolCallId: 'call-1',
  };
  return { service, store, context, root };
}

describe('process lifecycle', () => {
  it('starts without waiting for exit, reads output and stops', async () => {
    const { service, context } = await setup();
    const job = await service.start(context, { command: 'echo hello; sleep 30' });
    expect(['running', 'starting']).toContain(job.status);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const status = await service.status(context, job.id);
    expect(status.status).toBe('running');
    const read = await service.read(context, { jobId: job.id });
    expect(read.text).toContain('hello');
    const stopped = await service.stop(context, job.id);
    expect(stopped.status).toBe('stopped');
    await expect(service.status(context, job.id)).resolves.toMatchObject({ status: 'stopped' });
  }, 30_000);

  it('does not report a just-exited command as unknown before its exit file', async () => {
    const { service, context } = await setup();
    const job = await service.start(context, { command: 'exit 7' });
    expect(['exited', 'starting', 'running']).toContain(job.status);
    const waited = await service.wait(context, job.id, { timeoutMs: 5_000 });
    expect(waited.status).toBe('exited');
    expect(waited.exitCode).toBe(7);
  }, 20_000);

  it('records an exit code and serves the final output', async () => {
    const { service, context } = await setup();
    const job = await service.start(context, { command: 'echo done; exit 3' });
    const waited = await service.wait(context, job.id, { timeoutMs: 5_000 });
    expect(waited.status).toBe('exited');
    expect(waited.exitCode).toBe(3);
    const read = await service.read(context, { jobId: job.id });
    expect(read.text).toContain('done');
  }, 20_000);

  it('supports input only when a FIFO was opened', async () => {
    const { service, context } = await setup();
    const noInput = await service.start({ ...context, toolCallId: 'noinput' }, { command: 'sleep 30' });
    await expect(service.input(context, noInput.id, 'x')).rejects.toMatchObject({
      code: 'PROCESS_NO_INPUT',
    });
    await service.stop(context, noInput.id);

    const job = await service.start({ ...context, toolCallId: 'stdin' }, { command: 'cat', stdin: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await service.input(context, job.id, 'hello-input\n');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const read = await service.read(context, { jobId: job.id });
    expect(read.text).toContain('hello-input');
    await service.stop(context, job.id);
  }, 30_000);

  it('marks a missing process unknown instead of failed or running', async () => {
    const { service, context } = await setup();
    const job = await service.start(context, { command: 'sleep 30' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const running = await service.status(context, job.id);
    if (running.pid) process.kill(running.pid, 'SIGKILL');
    // The three-second starting grace exists so a fast exit is not mislabeled
    // unknown; after it, a missing process with no exit file is genuinely unknown.
    await new Promise((resolve) => setTimeout(resolve, 3_300));
    const status = await service.status(context, job.id);
    expect(status.status).toBe('unknown');
    expect(status.error).toContain('不能确认');
  }, 20_000);

  it('enforces the per-conversation job limit', async () => {
    const { service, context } = await setup();
    const jobs = [];
    for (let index = 0; index < 3; index += 1) {
      jobs.push(await service.start({ ...context, toolCallId: `limit-${index}` }, { command: 'sleep 30' }));
    }
    await expect(service.start(context, { command: 'sleep 30' })).rejects.toMatchObject({
      code: 'PROCESS_LIMIT',
    });
    for (const job of jobs) await service.stop(context, job.id);
  }, 40_000);

  it('is idempotent per tool call and conflicts on a different command', async () => {
    const { service, context } = await setup();
    const first = await service.start(context, { command: 'sleep 30' });
    const second = await service.start(context, { command: 'sleep 30' });
    expect(second.id).toBe(first.id);
    await expect(service.start(context, { command: 'sleep 31' })).rejects.toMatchObject({
      code: 'PROCESS_CONFLICT',
    });
    await service.stop(context, first.id);
  }, 20_000);

  it('keeps jobs visible after a new service instance reads the same store', async () => {
    const { service, store, context } = await setup();
    const job = await service.start(context, { command: 'sleep 30' });
    const second = new ProcessService({ store });
    const read = await second.get(context, job.id);
    expect(read?.id).toBe(job.id);
    await service.stop(context, job.id);
  }, 20_000);

  it('probes an HTTP server inside the same execution context', async () => {
    const { service, context } = await setup();
    const port = 39_000 + Math.floor(Math.random() * 1_000);
    const job = await service.start(context, {
      command: `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(${port})"`,
    });
    const probe = await service.probeHttp(context, port, 10_000);
    expect(probe.ready).toBe(true);
    await service.stop(context, job.id);
  }, 30_000);
});
