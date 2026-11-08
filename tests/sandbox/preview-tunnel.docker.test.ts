/**
 * R04 — a real preview tunnel through a real sandbox container.
 *
 * Gated like the other Docker integration test:
 *   SANDBOX_INTEGRATION=1 SANDBOX_TEST_IMAGE_DIGEST=sha256:... \
 *   npx vitest run tests/sandbox/preview-tunnel.docker.test.ts
 *
 * The container keeps `network:none`; the host has no published port. The only
 * path to the HTTP server is the gateway's stdio tunnel.
 */

import sharp from 'sharp';
import { BrowserRuntime } from '../../src/browser/runtime.ts';
import { McpConnection } from '../../src/mcp/client.ts';
import { DEFAULT_CONFIG_PARSE_OPTIONS, parseServerInput } from '../../src/mcp/config.ts';
import { readBrowserScreenshot } from '../../src/mcp/browser-output.ts';
import { rootExecutionScope } from '../../src/tools/scope.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { createSandboxPlatform, type SandboxPlatform } from '../../src/sandbox/index.ts';
import { MemorySandboxStore } from '../../src/sandbox/store-memory.ts';
import { RESOURCE_PROFILES, SANDBOX_POLICY_VERSION } from '../../src/sandbox/types.ts';
import type { SandboxSettings } from '../../src/sandbox/config.ts';
import { testPermissionSettings } from './helpers.ts';
import { ProcessService } from '../../src/processes/service.ts';
import { PreviewGateway } from '../../src/previews/gateway.ts';
import { PreviewService } from '../../src/previews/service.ts';
import { MemoryPreviewStore } from '../../src/previews/store.ts';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import type { ToolExecutor } from '../../src/tools/types.ts';

const ENABLED = process.env.SANDBOX_INTEGRATION === '1';
const IMAGE = process.env.SANDBOX_TEST_IMAGE_DIGEST?.trim() ?? '';
const RUNTIME_CLASS = (process.env.SANDBOX_TEST_RUNTIME_CLASS?.trim() ?? 'runc') as
  | 'gvisor'
  | 'runc'
  | 'default';
const enabled = ENABLED && /^sha256:[a-f0-9]{64}$/.test(IMAGE);

interface Harness {
  readonly base: string;
  readonly platform: SandboxPlatform;
  readonly task: { taskId: string; sessionId: string; userId: string };
  readonly sandboxId: string;
}

let harness: Harness | null = null;

async function startHarness(): Promise<Harness> {
  const base = await mkdtemp(join(tmpdir(), 'eunoia-preview-it-'));
  const sourceRoot = join(base, 'repo');
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(join(sourceRoot, 'index.html'), '<h1>preview</h1>\n');
  const settings: SandboxSettings = {
    enabled: true,
    imageDigest: IMAGE,
    policyVersion: SANDBOX_POLICY_VERSION,
    runtime: {
      kind: 'docker',
      binary: 'docker',
      globalArgs: [],
      runtimeClass: RUNTIME_CLASS,
      requireGvisor: RUNTIME_CLASS === 'gvisor',
      seccompProfile: null,
      apparmorProfile: null,
      egressNetwork: null,
    },
    workspace: {
      storageRoot: join(base, 'sandboxes'),
      sourceRoot,
      mode: 'bind',
      ignore: [],
      allowSensitive: false,
      maxFileBytes: 2 * 1024 * 1024,
    },
    network: { mode: 'none', allowedDomains: [], allowedPorts: [], proxyUrl: null },
    resources: { ...RESOURCE_PROFILES.small!.limits, executionTimeoutMs: 30_000 },
    limits: {
      maxConcurrentGlobal: 4,
      maxConcurrentPerUser: 4,
      maxConcurrentPerTask: 2,
      maxExecutionTimeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
    },
    allowWrites: true,
    allowCommands: true,
    deniedTools: [],
    permission: testPermissionSettings({ mode: 'auto' }),
    heartbeatMs: 30_000,
    nonGvisorAcknowledged: RUNTIME_CLASS !== 'gvisor',
  };
  const platform = await createSandboxPlatform({ store: new MemorySandboxStore(), settings });
  const task = { taskId: `pv-${Date.now()}`, sessionId: 'preview-it', userId: 'preview-user' };
  await platform.gateway.ensureTask(task);
  const sandbox = await platform.gateway.ensureSandbox({ taskId: task.taskId, userId: task.userId });
  return { base, platform, task, sandboxId: sandbox.sandboxId };
}

async function run(h: Harness, command: readonly string[]) {
  const context = { taskId: h.task.taskId, userId: h.task.userId, sessionId: h.task.sessionId };
  const current = await h.platform.gateway.currentDirectory(context);
  return h.platform.gateway.execute(context, {
    sandboxId: h.sandboxId,
    executionId: `exec_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    idempotencyKey: `call-${Date.now()}_${Math.random().toString(16).slice(2)}`,
    command,
    cwd: current.cwd,
    cwdVersion: current.cwdVersion,
    timeoutMs: 20_000,
    shell: true,
  });
}

function guestGet(
  tunnel: import('node:stream').Duplex,
  path: string,
): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const agent = new Agent({ keepAlive: false, maxSockets: 1 });
    (agent as unknown as { createConnection: () => import('node:stream').Duplex }).createConnection =
      () => tunnel;
    const request = httpRequest(
      { method: 'GET', path, headers: { host: '127.0.0.1' }, agent },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk as Buffer));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: response.headers,
          }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });
}

describe.skipIf(!enabled)('R04 — preview tunnel in a real container', () => {
  beforeAll(async () => {
    harness = await startHarness();
  }, 120_000);

  afterAll(async () => {
    if (!harness) return;
    await harness.platform.gateway
      .destroy({ taskId: harness.task.taskId, userId: harness.task.userId }, harness.sandboxId)
      .catch(() => undefined);
    await rm(harness.base, { recursive: true, force: true });
    harness = null;
  }, 60_000);

  it('starts a real dev server, leases it and serves the user URL through the gateway', async () => {
    const h = harness as Harness;
    const context = { taskId: h.task.taskId, userId: h.task.userId, sessionId: h.task.sessionId };
    const executor: ToolExecutor = {
      run: async (input) => {
        const current = await h.platform.gateway.currentDirectory(context);
        const result = await h.platform.gateway.execute(context, {
          sandboxId: h.sandboxId,
          executionId: `exec_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          idempotencyKey: `exec_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          command: [...input.command],
          cwd: current.cwd,
          cwdVersion: current.cwdVersion,
          timeoutMs: input.timeoutMs ?? 20_000,
          shell: input.shell ?? false,
        });
        return {
          status: result.status,
          exitCode: result.exitCode ?? null,
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: result.status === 'TIMEOUT',
          durationMs: 0,
          executionId: result.executionId,
          cwd: current.cwd,
        };
      },
      tunnel: (input) => h.platform.gateway.openTunnel(context, h.sandboxId, input.port, input.signal),
    };
    const processes = new ProcessService({ store: new InMemoryStore() });
    const gateway = new PreviewGateway({ host: '127.0.0.1', port: 0, baseDomain: 'preview.localhost' });
    const address = await gateway.start();
    const service = new PreviewService({
      processes,
      store: new MemoryPreviewStore(),
      gateway,
      baseDomain: 'preview.localhost',
      gatewayPort: address.port,
      limits: { readyTimeoutMs: 15_000, ttlMs: 60_000, maxPerConversation: 2 },
    });
    try {
      const port = 43300 + Math.floor(Math.random() * 100);
      const started = await service.start(
        {
          executor,
          userId: h.task.userId,
          conversationId: h.task.taskId,
          taskId: h.task.taskId,
          toolCallId: 'preview-it',
        },
        {
          command: `node -e "require('http').createServer((q,s)=>s.end('real-preview')).listen(${port},'127.0.0.1')"`,
          port,
          readyTimeoutMs: 15_000,
        },
      );
      expect(started.ready).toBe(true);
      expect(started.lease.userUrl).toMatch(/preview\.localhost/);
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = httpRequest(
          {
            host: '127.0.0.1',
            port: address.port,
            path: '/',
            headers: { host: new URL(started.lease.userUrl as string).host },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(chunk as Buffer));
            res.on('end', () =>
              resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
            );
          },
        );
        request.on('error', reject);
        request.end();
      });
      expect(response.status).toBe(200);
      expect(response.body).toBe('real-preview');
      if (process.env.BROWSER_INTEGRATION === '1') {
        const config = parseServerInput({ name: 'Real preview browser', transport: 'stdio', stdio: { command: 'eunoia-browser', args: [], runLocation: 'browser' } }, { ...DEFAULT_CONFIG_PARSE_OPTIONS, userId: h.task.userId }).config;
        const runtime = new BrowserRuntime({ env: { ...process.env, SANDBOX_RUNTIME_CLASS: RUNTIME_CLASS, SANDBOX_ALLOW_NON_GVISOR: '1' }, previewRoute: (scope, url) => service.browserRoute(scope, url) });
        const scope = rootExecutionScope({ userId: h.task.userId, conversationId: h.task.taskId });
        const connection = await McpConnection.open({ config, identity: 'preview-integration', generation: 1, stdioFactory: () => runtime.create(config, scope) });
        try {
          const navigated = await connection.callTool({ name: 'browser_navigate', arguments: { url: started.lease.browserUrl } });
          expect(navigated.isError).toBe(false);
          const snapshot = await connection.callTool({ name: 'browser_snapshot', arguments: {} });
          expect(JSON.stringify(snapshot.content)).toContain('real-preview');
          const shot = await connection.callTool({ name: 'browser_take_screenshot', arguments: { type: 'png', filename: 'container-preview.png' } });
          const output = connection.browserOutput!;
          const image = await readBrowserScreenshot({ config: output.config, toolName: 'browser_take_screenshot', result: shot, fs: output.fs, importImage: async (input) => {
            const bytes = Buffer.from(input.bytes); const meta = await sharp(bytes).metadata();
            expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
            return { assetId: 'real-container-preview', name: input.name, mediaType: input.mediaType, bytes: bytes.length, width: meta.width!, height: meta.height! };
          } });
          expect(image.state, JSON.stringify(image)).toBe('imported');
        } finally { await connection.close(); }
      }

      await service.stop(
        {
          executor,
          userId: h.task.userId,
          conversationId: h.task.taskId,
          taskId: h.task.taskId,
          toolCallId: 'preview-it-stop',
        },
        started.lease.id,
      );
    } finally {
      await gateway.stop();
    }
  }, 60_000);

  it('serves HTTP inside network:none only through the tunnel, with no published host port', async () => {
    const h = harness as Harness;
    const port = 43210 + Math.floor(Math.random() * 100);
    const started = await run(h, [
      `/bin/sh -c "nohup node -e \\"require('http').createServer((q,s)=>s.end('tunnel-ok')).listen(${port},'127.0.0.1')\\" >/tmp/preview.log 2>&1 & echo started"`,
    ]);
    expect(started.status).toBe('SUCCEEDED');
    await new Promise((resolve) => setTimeout(resolve, 800));
    const context = { taskId: h.task.taskId, userId: h.task.userId, sessionId: h.task.sessionId };
    const tunnel = await h.platform.gateway.openTunnel(context, h.sandboxId, port);
    const response = await guestGet(tunnel, '/');
    expect(response.status).toBe(200);
    expect(response.body).toBe('tunnel-ok');

    // The port is not published on the host: a direct connection must fail.
    const refused = await new Promise<boolean>((resolve) => {
      const request = httpRequest({ host: '127.0.0.1', port, path: '/', timeout: 800 }, () => resolve(false));
      request.on('error', () => resolve(true));
      request.on('timeout', () => {
        request.destroy();
        resolve(true);
      });
      request.end();
    });
    expect(refused).toBe(true);
  }, 60_000);
});
