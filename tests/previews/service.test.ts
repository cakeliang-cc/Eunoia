/**
 * R04 — preview service: job + readiness + durable lease + route.
 *
 * The executor is a controlled local shell (the same ProcessService code path,
 * real background process, real HTTP probe). The Docker runtime is exercised
 * separately by the deploy smoke; this test proves the lease/route/recovery
 * logic without pretending a fake process manager is a container.
 */

import { rootExecutionScope } from '../../src/tools/scope.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { connect as netConnect } from 'node:net';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessService } from '../../src/processes/service.ts';
import { FilePreviewStore, MemoryPreviewStore } from '../../src/previews/store.ts';
import { PreviewGateway } from '../../src/previews/gateway.ts';
import { PreviewService } from '../../src/previews/service.ts';
import type { ToolExecutor, ToolExecutionResult } from '../../src/tools/types.ts';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import type { ProcessRunContext } from '../../src/processes/service.ts';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function hostExecutor(): ToolExecutor {
  return {
    run(input): Promise<ToolExecutionResult> {
      const started = Date.now();
      const script =
        input.command[0] === 'sh' && input.command[1] === '-c'
          ? String(input.command[2])
          : input.command.join(' ');
      return new Promise((resolve) => {
        execFile(
          'sh',
          ['-c', script],
          {
            timeout: input.timeoutMs ?? 30_000,
            signal: input.signal,
            maxBuffer: 4 * 1024 * 1024,
          },
          (error, stdout, stderr) => {
            resolve({
              status:
                error && (error as NodeJS.ErrnoException).code === 'ABORT_ERR'
                  ? 'CANCELLED'
                  : error
                    ? 'FAILED'
                    : 'SUCCEEDED',
              exitCode: error ? ((error as { code?: number }).code ?? 1) : 0,
              stdout: String(stdout),
              stderr: String(stderr),
              timedOut: Boolean(error && (error as { killed?: boolean }).killed),
              durationMs: Date.now() - started,
              executionId: `exec_${randomUUID()}`,
              cwd: '/workspace',
            });
          },
        );
      });
    },
    tunnel(input) {
      return Promise.resolve(netConnect(input.port, '127.0.0.1'));
    },
  };
}

async function freePort(): Promise<number> {
  const server = createHttpServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function get(port: number, host: string, path = '/'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, headers: { host } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk as Buffer));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function context(toolCallId = `call_${randomUUID()}`): ProcessRunContext {
  return {
    executor: hostExecutor(),
    userId: 'user-1',
    conversationId: 'conv-1',
    taskId: 'conv-1',
    toolCallId,
  };
}

async function setup(options: { store?: MemoryPreviewStore | FilePreviewStore; now?: () => Date } = {}) {
  const store = new InMemoryStore();
  const processes = new ProcessService({ store });
  const gateway = new PreviewGateway({ host: '127.0.0.1', port: 0, baseDomain: 'preview.localhost' });
  const address = await gateway.start();
  const service = new PreviewService({
    processes,
    store: options.store ?? new MemoryPreviewStore(),
    gateway,
    baseDomain: 'preview.localhost',
    gatewayPort: address.port,
    limits: { readyTimeoutMs: 8_000, ttlMs: 60_000, maxPerConversation: 2 },
    sessionFor: async () => ({ executor: hostExecutor() } as never),
    ...(options.now ? { now: options.now } : {}),
  });
  cleanups.push(async () => {
    await gateway.stop();
    for (const job of await store.listDevJobs('user-1', 'conv-1')) {
      await processes.stop(context(`cleanup_${job.id}`), job.id).catch(() => undefined);
    }
  });
  return { store, processes, gateway, service, gatewayPort: address.port };
}

function command(port: number, body: string): string {
  return `node -e "require('http').createServer((q,s)=>s.end('${body}')).listen(${port},'127.0.0.1')"`;
}

describe('R04 — preview service', () => {
  it('starts a real server, becomes ready, routes it, and invalidates the old address on stop', async () => {
    const h = await setup();
    const port = await freePort();
    const started = await h.service.start(context(), {
      command: command(port, 'hello preview'),
      port,
      readyTimeoutMs: 8_000,
    });
    expect(started.ready).toBe(true);
    const scope = rootExecutionScope({ userId: 'user-1', conversationId: 'conv-1' });
    const preview = new URL(started.lease.browserUrl!);
    expect(await h.service.browserRoute(scope, preview)).toEqual({ address: '127.0.0.1', port: h.gatewayPort });
    expect(await h.service.browserRoute(rootExecutionScope({ userId: 'other', conversationId: 'conv-1' }), preview)).toBeNull();
    expect(await h.service.browserRoute(rootExecutionScope({ userId: 'user-1', conversationId: 'other' }), preview)).toBeNull();
    expect(await h.service.browserRoute({ ...scope, identity: { ...scope.identity, role: 'member', memberId: 'other-member' } }, preview)).toBeNull();
    const wrongPort = new URL(preview); wrongPort.port = String(Number(preview.port) + 1);
    expect(await h.service.browserRoute(scope, wrongPort)).toBeNull();

    expect(started.lease.status).toBe('ready');
    expect(started.lease.userUrl).toContain(started.lease.routeId);
    const routeHost = new URL(started.lease.userUrl!).host;
    const page = await get(h.gatewayPort, routeHost);
    expect(page.status).toBe(200);
    expect(page.body).toBe('hello preview');

    const stopped = await h.service.stop(context(), started.lease.id);
    expect(stopped.status).toBe('stopped');
    const after = await get(h.gatewayPort, routeHost);
    expect(after.status).toBe(404);
    expect(after.body).toContain('not active');
  }, 30_000);

  it('reports a failed preview with logs instead of a null URL success', async () => {
    const h = await setup();
    const port = await freePort();
    const started = await h.service.start(context(), {
      command: 'echo "cannot listen" >&2; exit 3',
      port,
      readyTimeoutMs: 4_000,
    });
    expect(started.ready).toBe(false);
    expect(started.lease.status).toBe('failed');
    expect(started.lease.userUrl).toBeNull();
    expect(started.lease.error).toBeTruthy();
  }, 30_000);

  it('expires a due lease, removes its route and stops the job', async () => {
    let now = new Date('2026-11-08T10:00:00.000Z');
    const h = await setup({ now: () => now });
    const port = await freePort();
    const started = await h.service.start(context(), {
      command: command(port, 'ttl'),
      port,
      readyTimeoutMs: 8_000,
    });
    expect(started.ready).toBe(true);
    const routeHost = new URL(started.lease.userUrl!).host;
    now = new Date(Date.parse(started.lease.expiresAt) + 1);
    expect(await h.service.expireDue()).toBe(1);
    const after = await get(h.gatewayPort, routeHost);
    expect(after.status).toBe(404);
    const job = await h.processes.get(context(), started.job.id);
    expect(['stopped', 'exited']).toContain(job?.status);
  }, 30_000);

  it('rejects a preview owned by another conversation', async () => {
    const h = await setup();
    const port = await freePort();
    const started = await h.service.start(context(), {
      command: command(port, 'owned'),
      port,
      readyTimeoutMs: 8_000,
    });
    const other = { ...context(), conversationId: 'conv-2' };
    await expect(h.service.status(other, started.lease.id)).rejects.toMatchObject({
      code: 'PREVIEW_NOT_FOUND',
    });
  }, 30_000);

  it('re-registers a live lease from the same file after a restart, then expires a dead one', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eunoia-preview-'));
    cleanups.push(async () => rm(directory, { recursive: true, force: true }));
    const file = join(directory, 'previews.json');
    const h = await setup({ store: new FilePreviewStore(file) });
    const port = await freePort();
    const started = await h.service.start(context(), {
      command: command(port, 'resume'),
      port,
      readyTimeoutMs: 8_000,
    });
    expect(started.ready).toBe(true);
    const routeHost = new URL(started.lease.userUrl!).host;

    const gateway2 = new PreviewGateway({ host: '127.0.0.1', port: 0, baseDomain: 'preview.localhost' });
    const address2 = await gateway2.start();
    cleanups.push(async () => gateway2.stop());
    const service2 = new PreviewService({
      processes: h.processes,
      store: new FilePreviewStore(file),
      gateway: gateway2,
      baseDomain: 'preview.localhost',
      gatewayPort: address2.port,
      sessionFor: async () => ({ executor: hostExecutor() } as never),
    });
    const resumed = await service2.resume();
    expect(resumed).toEqual({ live: 1, expired: 0 });
    expect((await get(address2.port, routeHost)).body).toBe('resume');

    // Kill the backing process, then a fresh restart must not re-register the
    // lease: a file saying "ready" is not evidence that the job still runs.
    await h.processes.stop(context(), started.job.id);
    const gateway3 = new PreviewGateway({ host: '127.0.0.1', port: 0, baseDomain: 'preview.localhost' });
    const address3 = await gateway3.start();
    cleanups.push(async () => gateway3.stop());
    const service3 = new PreviewService({
      processes: h.processes,
      store: new FilePreviewStore(file),
      gateway: gateway3,
      baseDomain: 'preview.localhost',
      gatewayPort: address3.port,
      sessionFor: async () => ({ executor: hostExecutor() } as never),
    });
    const second = await service3.resume();
    expect(second).toEqual({ live: 0, expired: 1 });
    expect((await get(address3.port, routeHost)).status).toBe(404);
  }, 30_000);
});
