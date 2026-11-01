/**
 * Real-runtime security check (ADR §16.3).
 *
 * This script is deliberately not part of `npm test`: it refuses to pass without
 * a real container runtime, and a mock would make it lie. Run it on the target
 * Linux host (or a host with Docker Desktop for the non-gVisor development
 * profile) after configuring the sandbox:
 *
 *   npm run sandbox:check
 *
 * Exit codes:
 *   0  every check ran and passed against a real runtime
 *   1  a check failed, or the runtime is not available
 *   2  the sandbox is not configured
 */

import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandboxSettings } from '../src/sandbox/config.ts';
import { createSandboxPlatform } from '../src/sandbox/index.ts';
import { RESOURCE_PROFILES } from '../src/sandbox/types.ts';
import { MemorySandboxStore } from '../src/sandbox/store-memory.ts';

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const checks: Check[] = [];

function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}\n`);
}

async function main(): Promise<number> {
  const settings = sandboxSettings();
  if (!settings) {
    process.stderr.write('sandbox is not configured; set WORKSPACE_ROOT and SANDBOX_IMAGE_DIGEST\n');
    return 2;
  }

  const base = await mkdtemp(join(tmpdir(), 'eunoia-security-'));
  const sourceRoot = join(base, 'repo');
  await mkdir(join(sourceRoot, 'src'), { recursive: true });
  await writeFile(join(sourceRoot, 'README.md'), '# security check\n');

  const platform = await createSandboxPlatform({
    store: new MemorySandboxStore(),
    settings: {
      ...settings,
      workspace: {
        ...settings.workspace,
        sourceRoot,
        mode: 'bind',
        storageRoot: join(base, 'sandboxes'),
      },
      resources: { ...RESOURCE_PROFILES.small!.limits, executionTimeoutMs: 30_000 },
      limits: { ...settings.limits, maxExecutionTimeoutMs: 30_000, maxOutputBytes: 64 * 1024 },
      // The self-check exercises writes and commands; the deployment's switches
      // are not the subject of the check.
      allowWrites: true,
      allowCommands: true,
    },
  });
  const probe = platform.runtimeProbe;
  if (!probe.ok) {
    process.stderr.write(`runtime probe failed: ${probe.detail}\n`);
    return 1;
  }
  if (settings.runtime.requireGvisor && !probe.detail.includes('gvisor=present')) {
    process.stderr.write(`gVisor is required but not registered: ${probe.detail}\n`);
    return 1;
  }

  const task = { taskId: `security-${Date.now()}`, sessionId: 'security', userId: 'security' };
  await platform.gateway.ensureTask(task);
  const sandbox = await platform.gateway.ensureSandbox({ taskId: task.taskId, userId: task.userId });
  const context = { taskId: task.taskId, userId: task.userId, sessionId: task.sessionId };
  let counter = 0;
  const run = async (command: string[], timeoutMs = 15_000) => {
    counter += 1;
    return platform.gateway.execute(context, {
      sandboxId: sandbox.sandboxId,
      executionId: `sec_${counter}`,
      idempotencyKey: `sec_${counter}`,
      command,
      cwd: '/workspace',
      timeoutMs,
    });
  };

  try {
    const uid = await run(['/bin/sh', '-c', 'id -u; id -g']);
    record(
      'non-root user',
      uid.status === 'SUCCEEDED' && uid.stdout.trim() === '1000\n1000',
      uid.stdout.trim().replace(/\n/g, '/'),
    );

    const mounts = await run([
      '/bin/sh',
      '-c',
      "grep ' / ' /proc/mounts | grep -q ' ro,' && echo read-only",
    ]);
    record('read-only root filesystem', mounts.stdout.includes('read-only'), mounts.stdout.trim());

    const shadow = await run(['/bin/sh', '-c', 'cat /etc/shadow']);
    record(
      'cannot read /etc/shadow',
      shadow.status === 'FAILED' && !shadow.stdout.includes('root:'),
      `status=${shadow.status} exit=${shadow.exitCode ?? 'signal'}`,
    );

    const sockets = await run([
      '/bin/sh',
      '-c',
      'for d in /run /var/run; do [ -d "$d" ] && ls -a "$d"; done',
    ]);
    record(
      'no docker/containerd socket',
      sockets.status === 'SUCCEEDED' &&
        !/docker\.sock|containerd\.sock/.test(sockets.stdout),
      sockets.stdout.trim().split('\n').slice(0, 3).join(', '),
    );

    const outside = await run(['/bin/sh', '-c', 'echo nope > /etc/pwned']);
    record('cannot write outside /workspace', outside.status === 'FAILED', `status=${outside.status}`);

    const inside = await run(['/bin/sh', '-c', 'echo ok > /workspace/security-check.txt']);
    const hostFile = await readFile(join(sourceRoot, 'security-check.txt'), 'utf8').catch(() => '');
    record(
      'writes only inside /workspace',
      inside.status === 'SUCCEEDED' && hostFile.trim() === 'ok',
      `status=${inside.status}`,
    );

    const route = await run(['/bin/sh', '-c', 'cat /proc/net/route 2>/dev/null || true']);
    const hasDefaultRoute = /^00000000/m.test(route.stdout);
    record(
      'network is isolated (no default route)',
      route.status === 'SUCCEEDED' && (settings.network.mode === 'proxy_only' || !hasDefaultRoute),
      settings.network.mode === 'proxy_only' ? 'proxy_only mode: see firewall rule' : 'network none',
    );

    const timeout = await run(['/bin/sh', '-c', 'sleep 30'], 1_500);
    record('timeout is enforced', timeout.status === 'TIMEOUT', `status=${timeout.status}`);

    const recovered = await platform.gateway.recover(context, sandbox.sandboxId);
    record('sandbox recovers after termination', recovered.runtimeAlive, recovered.status);

    const alive = await run(['/bin/sh', '-c', 'echo alive']);
    record(
      'execution works after recovery',
      alive.status === 'SUCCEEDED' && alive.stdout.includes('alive'),
      alive.stdout.trim(),
    );

    return checks.every((check) => check.ok) ? 0 : 1;
  } finally {
    await platform.gateway.destroy(context, sandbox.sandboxId).catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`security check failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
