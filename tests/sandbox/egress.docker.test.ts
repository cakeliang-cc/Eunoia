/**
 * R04 — controlled egress for dependency installation, in a real container.
 *
 * The production managed proxy crosses a control pipe into network:none.
 * The proxy is the sandbox's only route: it allowlists
 * example.com:443, refuses metadata/private targets, and the sandbox has no
 * direct external route. This is the dependency-install channel, not the
 * preview tunnel.
 *
 * Gated:
 *   SANDBOX_INTEGRATION=1 SANDBOX_TEST_IMAGE_DIGEST=sha256:... \
 *   npx vitest run tests/sandbox/egress.docker.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandboxPlatform, type SandboxPlatform } from '../../src/sandbox/index.ts';
import { MemorySandboxStore } from '../../src/sandbox/store-memory.ts';
import { RESOURCE_PROFILES, SANDBOX_POLICY_VERSION } from '../../src/sandbox/types.ts';
import type { SandboxSettings } from '../../src/sandbox/config.ts';
import { testPermissionSettings } from './helpers.ts';

const ENABLED = process.env.SANDBOX_INTEGRATION === '1';
const IMAGE = process.env.SANDBOX_TEST_IMAGE_DIGEST?.trim() ?? '';
const enabled = ENABLED && /^sha256:[a-f0-9]{64}$/.test(IMAGE);

interface H {
  readonly base: string;
  platform: SandboxPlatform;
  readonly settings: SandboxSettings;
  readonly store: MemorySandboxStore;
  readonly task: { taskId: string; sessionId: string; userId: string };
  readonly sandboxId: string;
}

let harness: H | null = null;

async function start(): Promise<H> {
  const base = await mkdtemp(join(tmpdir(), 'eunoia-egress-'));
  const settings: SandboxSettings = {
    enabled: true,
    imageDigest: IMAGE,
    policyVersion: SANDBOX_POLICY_VERSION,
    runtime: {
      kind: 'docker', binary: 'docker', globalArgs: [], runtimeClass: 'runc', requireGvisor: false,
      seccompProfile: null, apparmorProfile: null, egressNetwork: null,
    },
    workspace: {
      storageRoot: join(base, 'sandboxes'), sourceRoot: null, mode: 'copy', ignore: [],
      allowSensitive: false, maxFileBytes: 2 * 1024 * 1024,
    },
    network: {
      mode: 'proxy_only',
      allowedDomains: ['example.com', 'registry.npmjs.org'],
      allowedPorts: [443],
      proxyUrl: 'http://127.0.0.1:3128',
    },
    resources: { ...RESOURCE_PROFILES.small!.limits, executionTimeoutMs: 60_000 },
    limits: {
      maxConcurrentGlobal: 2, maxConcurrentPerUser: 2, maxConcurrentPerTask: 1,
      maxExecutionTimeoutMs: 60_000, maxOutputBytes: 64 * 1024,
    },
    allowWrites: false,
    allowCommands: true,
    deniedTools: [],
    permission: testPermissionSettings({ mode: 'auto' }),
    heartbeatMs: 30_000,
    nonGvisorAcknowledged: true,
  };
  const store = new MemorySandboxStore();
  const platform = await createSandboxPlatform({ store, settings });
  const task = { taskId: `egress-${Date.now()}`, sessionId: 'egress-it', userId: 'egress-user' };
  await platform.gateway.ensureTask(task);
  const sandbox = await platform.gateway.ensureSandbox({ taskId: task.taskId, userId: task.userId });
  return { base, platform, settings, store, task, sandboxId: sandbox.sandboxId };
}

async function run(h: H, command: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const context = { taskId: h.task.taskId, userId: h.task.userId, sessionId: h.task.sessionId };
  const current = await h.platform.gateway.currentDirectory(context);
  const result = await h.platform.gateway.execute(context, {
    sandboxId: h.sandboxId,
    executionId: `exec_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    idempotencyKey: `egress-${Date.now()}_${Math.random().toString(16).slice(2)}`,
    command,
    cwd: current.cwd,
    cwdVersion: current.cwdVersion,
    timeoutMs: 30_000,
    shell: false,
  });
  return { code: result.exitCode ?? 0, stdout: result.stdout, stderr: result.stderr };
}

async function curl(h: H, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return run(h, ['curl', ...args]);
}

describe.skipIf(!enabled)('R04 — controlled sandbox egress', () => {
  beforeAll(async () => {
    harness = await start();
  }, 120_000);

  afterAll(async () => {
    if (!harness) return;
    await harness.platform.gateway
      .destroy({ taskId: harness.task.taskId, userId: harness.task.userId }, harness.sandboxId)
      .catch(() => undefined);


    await rm(harness.base, { recursive: true, force: true });
    harness = null;
  }, 60_000);

  it('allows the approved dependency host through the proxy', async () => {
    const h = harness as H;
    const result = await curl(h, ['-x', 'http://127.0.0.1:3128', '-sS', '-o', '/dev/null', '-w', '%{http_code}', 'https://example.com/']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe('200');
  }, 60_000);

  it('uses the real npm client to read a dependency from the permitted registry', async () => {
    const result = await run(harness as H, ['npm', 'view', 'is-number@7.0.0', 'version', '--fetch-retries=0', '--fetch-timeout=15000']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('7.0.0');
  }, 30_000);

  it('refuses an unapproved host before the upstream request', async () => {
    const h = harness as H;
    const result = await curl(h, ['-x', 'http://127.0.0.1:3128', '-sS', '-o', '/dev/null', '-w', '%{http_code}', 'https://example.org/']);
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toBe('200');
  }, 60_000);

  it('refuses metadata/private targets and has no direct route that bypasses the proxy', async () => {
    const h = harness as H;
    const metadata = await curl(h, ['-x', 'http://127.0.0.1:3128', '-sS', '-o', '/dev/null', '-w', '%{http_code}', 'http://169.254.169.254/latest/meta-data/']);
    expect(metadata.stdout).not.toBe('200');
    const direct = await curl(h, ['--noproxy', '*', '-sS', '-m', '5', '-o', '/dev/null', '-w', '%{http_code}', 'https://example.com/']);
    expect(direct.code).not.toBe(0);
  }, 60_000);
  it('fails closed when the proxy pipe is lost and reconnects through the real runtime', async () => {
    const h = harness as H;
    h.platform.stop();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const { ContainerCli } = await import('../../src/sandbox/runtime/container-cli.ts');
    const cli = new ContainerCli({ binary: 'docker', kind: 'docker' });
    const stopped = await cli.run(['exec', `eunoia-sbx-${h.sandboxId.toLowerCase()}`, 'curl', '-x', 'http://127.0.0.1:3128', '-m', '2', '-sS', 'https://example.com/']);
    expect(stopped.code).not.toBe(0);
    h.platform = await createSandboxPlatform({ store: h.store, settings: h.settings });
    const restored = await curl(h, ['-x', 'http://127.0.0.1:3128', '-m', '15', '-sS', '-o', '/dev/null', '-w', '%{http_code}', 'https://example.com/']);
    expect(restored.code, restored.stderr).toBe(0);
    expect(restored.stdout).toBe('200');
  }, 60_000);

});
