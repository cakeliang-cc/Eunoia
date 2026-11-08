/**
 * R04 — controlled egress for dependency installation, in a real container.
 *
 * A per-test internal Docker network contains the sandbox and a small proxy
 * container. The proxy is the sandbox's only route: it allowlists
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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createSandboxPlatform, type SandboxPlatform } from '../../src/sandbox/index.ts';
import { MemorySandboxStore } from '../../src/sandbox/store-memory.ts';
import { RESOURCE_PROFILES, SANDBOX_POLICY_VERSION } from '../../src/sandbox/types.ts';
import type { SandboxSettings } from '../../src/sandbox/config.ts';
import { testPermissionSettings } from './helpers.ts';

const exec = promisify(execFile);
const ENABLED = process.env.SANDBOX_INTEGRATION === '1';
const IMAGE = process.env.SANDBOX_TEST_IMAGE_DIGEST?.trim() ?? '';
const enabled = ENABLED && /^sha256:[a-f0-9]{64}$/.test(IMAGE);

const network = `eunoia-egress-${process.pid}-${Date.now()}`;
const proxyName = `eunoia-egress-proxy-${process.pid}`;

const PROXY = String.raw`
const http = require('http');
const https = require('https');
const net = require('net');
const allowed = new Set(['example.com:443']);
function deny(socket, text) { try { socket.end(text); } catch {} }
function check(host, port) {
  const key = host.toLowerCase() + ':' + port;
  if (!allowed.has(key)) return false;
  if (/^(127\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return false;
  return true;
}
const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url); } catch { res.writeHead(400); return res.end(); }
  const port = Number(url.port || 80);
  if (!check(url.hostname, port)) { res.writeHead(403); return res.end('denied'); }
  const upstream = http.request({ hostname: url.hostname, port, path: url.pathname + url.search, method: req.method, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode || 502, r.headers); r.pipe(res);
  });
  upstream.on('error', () => { res.writeHead(502); res.end('upstream'); });
  req.pipe(upstream);
});
server.on('connect', (req, socket, head) => {
  const [host, portText] = (req.url || '').split(':');
  const port = Number(portText || 443);
  if (!check(host, port)) return deny(socket, 'HTTP/1.1 403 Forbidden\r\n\r\n');
  const upstream = net.connect(port, host, () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) upstream.write(head);
    upstream.pipe(socket); socket.pipe(upstream);
  });
  upstream.on('error', () => deny(socket, 'HTTP/1.1 502 Bad Gateway\r\n\r\n'));
});
server.listen(3128, '0.0.0.0');
`;

interface H {
  readonly base: string;
  readonly platform: SandboxPlatform;
  readonly task: { taskId: string; sessionId: string; userId: string };
  readonly sandboxId: string;
}

let harness: H | null = null;

async function start(): Promise<H> {
  const base = await mkdtemp(join(tmpdir(), 'eunoia-egress-'));
  await exec('docker', ['network', 'create', '--internal', network]);
  await exec('docker', [
    'run', '-d', '--rm', '--name', proxyName, '--network', network, '--network-alias', 'egress-proxy',
    IMAGE, 'node', '-e', PROXY,
  ]);
  // The proxy needs an upstream route; the sandbox does not get this network.
  await exec('docker', ['network', 'connect', 'bridge', proxyName]);
  const settings: SandboxSettings = {
    enabled: true,
    imageDigest: IMAGE,
    policyVersion: SANDBOX_POLICY_VERSION,
    runtime: {
      kind: 'docker', binary: 'docker', globalArgs: [], runtimeClass: 'runc', requireGvisor: false,
      seccompProfile: null, apparmorProfile: null, egressNetwork: network,
    },
    workspace: {
      storageRoot: join(base, 'sandboxes'), sourceRoot: null, mode: 'copy', ignore: [],
      allowSensitive: false, maxFileBytes: 2 * 1024 * 1024,
    },
    network: {
      mode: 'proxy_only',
      allowedDomains: ['example.com'],
      allowedPorts: [443],
      proxyUrl: 'http://egress-proxy:3128',
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
  const platform = await createSandboxPlatform({ store: new MemorySandboxStore(), settings });
  const task = { taskId: `egress-${Date.now()}`, sessionId: 'egress-it', userId: 'egress-user' };
  await platform.gateway.ensureTask(task);
  const sandbox = await platform.gateway.ensureSandbox({ taskId: task.taskId, userId: task.userId });
  return { base, platform, task, sandboxId: sandbox.sandboxId };
}

async function curl(h: H, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const context = { taskId: h.task.taskId, userId: h.task.userId, sessionId: h.task.sessionId };
  const current = await h.platform.gateway.currentDirectory(context);
  const result = await h.platform.gateway.execute(context, {
    sandboxId: h.sandboxId,
    executionId: `exec_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    idempotencyKey: `egress-${Date.now()}_${Math.random().toString(16).slice(2)}`,
    command: ['/bin/sh', '-c', `curl ${args.join(' ')}`],
    cwd: current.cwd,
    cwdVersion: current.cwdVersion,
    timeoutMs: 30_000,
    shell: false,
  });
  return { code: result.exitCode ?? 0, stdout: result.stdout, stderr: result.stderr };
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
    await exec('docker', ['rm', '-f', proxyName]).catch(() => undefined);
    await exec('docker', ['network', 'rm', network]).catch(() => undefined);
    await rm(harness.base, { recursive: true, force: true });
    harness = null;
  }, 60_000);

  it('allows the approved dependency host through the proxy', async () => {
    const h = harness as H;
    const result = await curl(h, ['-x', 'http://egress-proxy:3128', '-sS', '-o', '/dev/null', '-w', '%{http_code}', 'https://example.com/']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe('200');
  }, 60_000);

  it('refuses an unapproved host before the upstream request', async () => {
    const h = harness as H;
    const result = await curl(h, ['-x', 'http://egress-proxy:3128', '-sS', '-o', '/dev/null', '-w', '%{http_code}', 'https://example.org/']);
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toBe('200');
  }, 60_000);

  it('refuses metadata/private targets and has no direct route that bypasses the proxy', async () => {
    const h = harness as H;
    const metadata = await curl(h, ['-x', 'http://egress-proxy:3128', '-sS', '-o', '/dev/null', '-w', '%{http_code}', 'http://169.254.169.254/latest/meta-data/']);
    expect(metadata.stdout).not.toBe('200');
    const direct = await curl(h, ['--noproxy', '*', '-sS', '-m', '5', '-o', '/dev/null', '-w', '%{http_code}', 'https://example.com/']);
    expect(direct.code).not.toBe(0);
  }, 60_000);
});
