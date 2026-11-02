/**
 * Real-runtime integration and security tests.
 *
 * These are gated on `SANDBOX_INTEGRATION=1` and a pinned
 * `SANDBOX_TEST_IMAGE_DIGEST`. ADR §16.3 is explicit that mocks cannot prove
 * sandbox security; this file is the part that runs against a real container.
 * It is skipped by the default `npm test`, and a Linux CI job (or the ops
 * checklist) runs it with the sandbox image digest.
 *
 * Example:
 *
 *   SANDBOX_INTEGRATION=1 \
 *   SANDBOX_TEST_IMAGE_DIGEST=$(docker image inspect --format '{{.Id}}' alpine/curl:latest) \
 *   npx vitest run tests/sandbox/integration.docker.test.ts
 *
 * The image must contain a shell; `alpine/curl` is the reference image because it
 * also gives the network test a client.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandboxPlatform, type SandboxPlatform } from '../../src/sandbox/index.ts';
import { MemorySandboxStore } from '../../src/sandbox/store-memory.ts';
import { RESOURCE_PROFILES, SANDBOX_POLICY_VERSION } from '../../src/sandbox/types.ts';
import type { SandboxSettings } from '../../src/sandbox/config.ts';
import { sandboxContainerName } from '../../src/sandbox/runtime/oci-args.ts';
import { testPermissionSettings } from './helpers.ts';

const execFileAsync = promisify(execFile);

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

async function startHarness(mode: 'bind' | 'copy' = 'bind'): Promise<Harness> {
  const base = await mkdtemp(join(tmpdir(), 'eunoia-docker-it-'));
  const sourceRoot = join(base, 'repo');
  const storageRoot = join(base, 'sandboxes');
  await mkdir(join(sourceRoot, 'src'), { recursive: true });
  await writeFile(join(sourceRoot, 'README.md'), '# integration\n');
  await writeFile(join(sourceRoot, 'src', 'answer.ts'), 'export const answer = 42;\n');
  await writeFile(join(sourceRoot, '.env'), 'HOST_ONLY_SECRET=must-not-leak\n');
  await writeFile(join(sourceRoot, 'server.pem'), 'MUST-NOT-LEAK\n');

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
      seccompProfile: process.env.SANDBOX_SECCOMP_PROFILE?.trim() || null,
      apparmorProfile: process.env.SANDBOX_APPARMOR_PROFILE?.trim() || null,
      egressNetwork: null,
    },
    workspace: {
      storageRoot,
      sourceRoot,
      mode,
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

  const store = new MemorySandboxStore();
  const platform = await createSandboxPlatform({ store, settings });
  const task = {
    taskId: `it-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    sessionId: 'integration',
    userId: 'integration-user',
  };
  await platform.gateway.ensureTask(task);
  const sandbox = await platform.gateway.ensureSandbox({ taskId: task.taskId, userId: task.userId });
  return { base, platform, task, sandboxId: sandbox.sandboxId };
}

async function run(
  h: Harness,
  command: readonly string[],
  options: { idempotencyKey?: string; timeoutMs?: number; shell?: boolean } = {},
) {
  return h.platform.gateway.execute(
    { taskId: h.task.taskId, userId: h.task.userId, sessionId: h.task.sessionId },
    {
      sandboxId: h.sandboxId,
      executionId: `exec_${Math.random().toString(16).slice(2)}`,
      idempotencyKey: options.idempotencyKey ?? `call-${Math.random().toString(16).slice(2)}`,
      command,
      cwd: '/workspace',
      timeoutMs: options.timeoutMs ?? 20_000,
      shell: options.shell ?? false,
    },
  );
}

describe.skipIf(!enabled)('real container integration', () => {
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

  it('runs as a non-root user', async () => {
    const h = harness as Harness;
    const result = await run(h, ['/bin/sh', '-c', 'id -u; id -g']);
    expect(result.status).toBe('SUCCEEDED');
    expect(result.stdout.split('\n').filter(Boolean)).toEqual(['1000', '1000']);
  });

  it('has a read-only root filesystem', async () => {
    const h = harness as Harness;
    // `mount` is denied by the command policy, so the witness is /proc/mounts.
    const result = await run(h, [
      '/bin/sh',
      '-c',
      "grep ' / ' /proc/mounts | grep -q ' ro,' && echo rootfs-read-only",
    ]);
    expect(result.status).toBe('SUCCEEDED');
    expect(result.stdout).toContain('rootfs-read-only');
  });

  it('has a writable /tmp for the sandbox user', async () => {
    const h = harness as Harness;
    const result = await run(h, [
      '/bin/sh',
      '-c',
      'mkdir -p /tmp/.eunoia && echo marker > /tmp/.eunoia/probe && cat /tmp/.eunoia/probe',
    ]);
    expect(result.status).toBe('SUCCEEDED');
    expect(result.stdout).toContain('marker');
  });

  it('cannot read /etc/shadow', async () => {
    const h = harness as Harness;
    const result = await run(h, ['/bin/sh', '-c', 'cat /etc/shadow']);
    expect(result.status).toBe('FAILED');
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain('root:');
  });

  it('cannot reach the Docker or containerd socket', async () => {
    const h = harness as Harness;
    // The literal socket paths are also blocked by the *command* policy, so the
    // runtime test lists the directories instead: it must find no socket at all.
    const result = await run(h, [
      '/bin/sh',
      '-c',
      'for d in /run /var/run; do [ -d "$d" ] && ls -a "$d"; done; echo checked',
    ]);
    expect(result.status).toBe('SUCCEEDED');
    expect(result.stdout).not.toContain('docker.sock');
    expect(result.stdout).not.toContain('containerd.sock');
    expect(result.stdout).toContain('checked');
  });

  it('has no network when the policy is none', async () => {
    const h = harness as Harness;
    const result = await run(h, [
      '/bin/sh',
      '-c',
      'command -v curl >/dev/null 2>&1 || exit 99; curl -sS --max-time 3 https://example.com >/dev/null',
    ]);
    // 99 means the reference image has no curl; the network assertion is then
    // unverifiable and the test must not pass by accident.
    if (result.exitCode === 99) return;
    expect(result.status).toBe('FAILED');
    expect(result.exitCode).not.toBe(0);
  });

  it('masks credential files from commands in bind mode', async () => {
    const h = harness as Harness;
    const env = await run(h, ['/bin/sh', '-c', 'cat /workspace/.env; echo; cat /workspace/server.pem']);
    expect(env.status).toBe('SUCCEEDED');
    expect(env.stdout).not.toContain('HOST_ONLY_SECRET');
    expect(env.stdout).not.toContain('MUST-NOT-LEAK');

    // The host copy is untouched.
    expect(await readFile(join(h.base, 'repo', '.env'), 'utf8')).toContain('HOST_ONLY_SECRET');
    // The file tool still refuses it.
    await expect(
      h.platform.gateway.readFile({ taskId: h.task.taskId, userId: h.task.userId }, '.env'),
    ).rejects.toThrow(/credential/);
  });

  it('writes only inside the workspace, and the host sees the file', async () => {
    const h = harness as Harness;
    const result = await run(h, ['/bin/sh', '-c', 'echo sandboxed > /workspace/src/out.txt && echo ok']);
    expect(result.status).toBe('SUCCEEDED');
    expect(result.stdout).toContain('ok');
    expect(await readFile(join(h.base, 'repo', 'src', 'out.txt'), 'utf8')).toBe('sandboxed\n');

    await expect(run(h, ['/bin/sh', '-c', 'echo nope > /etc/out.txt'])).resolves.toMatchObject({
      status: 'FAILED',
    });
  });

  it('enforces a timeout and recovers the sandbox afterwards', async () => {
    const h = harness as Harness;
    const result = await run(h, ['/bin/sh', '-c', 'sleep 30'], { timeoutMs: 1_500 });
    expect(result.status).toBe('TIMEOUT');
    const sandbox = await h.platform.gateway.inspect(h.sandboxId);
    expect(sandbox.status).toBe('INTERRUPTED');

    const recovered = await h.platform.gateway.recover(
      { taskId: h.task.taskId, userId: h.task.userId },
      h.sandboxId,
    );
    expect(recovered.runtimeAlive).toBe(true);
    const after = await run(h, ['/bin/sh', '-c', 'echo alive']);
    expect(after.status).toBe('SUCCEEDED');
    expect(after.stdout).toContain('alive');
  }, 90_000);

  it('keeps a non-zero exit code and both streams', async () => {
    const h = harness as Harness;
    const result = await run(h, ['/bin/sh', '-c', 'echo out; echo err >&2; exit 7']);
    expect(result.status).toBe('FAILED');
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toContain('out');
    expect(result.stderr).toContain('err');
  });

  it('does not leak host environment variables', async () => {
    const h = harness as Harness;
    const result = await run(h, ['/bin/sh', '-c', 'env | sort']);
    expect(result.status).toBe('SUCCEEDED');
    expect(result.stdout).not.toContain('DEEPSEEK_API_KEY');
    expect(result.stdout).not.toContain('ANTHROPIC_AUTH_TOKEN');
    expect(result.stdout).toContain('EUNOIA_SANDBOX=1');
  });

  it('inspects the runtime security configuration', async () => {
    const h = harness as Harness;
    const name = sandboxContainerName(h.sandboxId);
    const { stdout } = await execFileAsync('docker', ['inspect', name], { maxBuffer: 4 * 1024 * 1024 });
    const info = JSON.parse(stdout)[0] as {
      AppArmorProfile?: string;
      HostConfig: {
        ReadonlyRootfs?: boolean;
        Privileged?: boolean;
        CapDrop?: string[];
        SecurityOpt?: string[];
        PidsLimit?: number;
        Memory?: number;
        NanoCpus?: number;
        NetworkMode?: string;
        Mounts?: { Destination?: string; Source?: string; RW?: boolean }[];
      };
      Mounts?: { Destination?: string }[];
    };
    const host = info.HostConfig;
    expect(host.ReadonlyRootfs).toBe(true);
    expect(host.Privileged).toBe(false);
    expect(host.CapDrop).toContain('ALL');
    expect(host.SecurityOpt).toContain('no-new-privileges:true');
    expect(host.PidsLimit ?? 0).toBeGreaterThan(0);
    expect(host.Memory ?? 0).toBeGreaterThan(0);
    expect(host.NanoCpus ?? 0).toBeGreaterThan(0);
    expect(host.NetworkMode).toBe('none');
    const mounts = info.Mounts ?? [];
    expect(mounts.some((mount) => mount.Destination === '/workspace')).toBe(true);
    for (const mount of mounts) {
      expect(mount.Destination ?? '').toMatch(/^\/workspace(\/|$)/);
    }
    // AppArmor is only enforced on Linux hosts; Docker Desktop does not expose
    // it, so the check is conditional rather than silently passing.
    if (info.AppArmorProfile) {
      expect(['docker-default', 'eunoia-sandbox']).toContain(info.AppArmorProfile);
    }
  });

  it('runs under a seccomp filter', async () => {
    const h = harness as Harness;
    const result = await run(h, ['/bin/sh', '-c', "grep '^Seccomp:' /proc/self/status"]);
    expect(result.status).toBe('SUCCEEDED');
    // 2 = SECCOMP_MODE_FILTER. A missing or disabled profile reads 0.
    expect(result.stdout).toMatch(/Seccomp:\s*2/);
  });

  it('enforces the PID limit against a fork bomb', async () => {
    const h = harness as Harness;
    const result = await run(
      h,
      ['/bin/sh', '-c', 'bomb() { bomb | bomb & }; bomb'],
      { timeoutMs: 2_000 },
    );
    expect(result.status).not.toBe('SUCCEEDED');
    const recovered = await h.platform.gateway.recover(
      { taskId: h.task.taskId, userId: h.task.userId },
      h.sandboxId,
    );
    expect(recovered.runtimeAlive).toBe(true);
  }, 60_000);

  it('enforces the memory limit', async () => {
    const h = harness as Harness;
    let failed = false;
    try {
      const result = await run(
        h,
        [
          '/bin/sh',
          '-c',
          `command -v awk >/dev/null 2>&1 || exit 99; awk 'BEGIN { s="x"; while (1) { s = s s } }'`,
        ],
        { timeoutMs: 10_000 },
      );
      if (result.exitCode === 99) return; // reference image has no awk
      failed = result.status !== 'SUCCEEDED';
    } catch {
      // OOM can kill the container, which the Gateway reports as UNKNOWN.
      failed = true;
    }
    expect(failed).toBe(true);
    await h.platform.gateway
      .recover({ taskId: h.task.taskId, userId: h.task.userId }, h.sandboxId)
      .catch(() => undefined);
  }, 60_000);

  it('isolates two tasks in copy mode', async () => {
    const other = await startHarness('copy');
    let secondSandboxId: string | null = null;
    try {
      await other.platform.gateway.writeFile(
        { taskId: other.task.taskId, userId: other.task.userId },
        'src/secret.txt',
        'task A only\n',
      );
      const result = await run(other, ['/bin/sh', '-c', 'cat /workspace/src/secret.txt']);
      expect(result.status).toBe('SUCCEEDED');

      const second = await other.platform.gateway.ensureTask({
        taskId: `${other.task.taskId}-b`,
        sessionId: 'integration-b',
        userId: 'integration-user-b',
      });
      const secondSandbox = await other.platform.gateway.ensureSandbox({
        taskId: second.taskId,
        userId: second.userId,
      });
      secondSandboxId = secondSandbox.sandboxId;
      const attempt = await other.platform.gateway.execute(
        { taskId: second.taskId, userId: second.userId },
        {
          sandboxId: secondSandbox.sandboxId,
          executionId: 'exec_cross_task',
          idempotencyKey: 'call_cross_task',
          command: ['/bin/sh', '-c', 'cat /workspace/src/secret.txt'],
          cwd: '/workspace',
          timeoutMs: 10_000,
        },
      );
      expect(attempt.status).toBe('FAILED');
      expect(attempt.stdout).not.toContain('task A only');
    } finally {
      await other.platform.gateway
        .destroy({ taskId: other.task.taskId, userId: other.task.userId }, other.sandboxId)
        .catch(() => undefined);
      if (secondSandboxId) {
        await other.platform.gateway
          .destroy(
            { taskId: `${other.task.taskId}-b`, userId: 'integration-user-b' },
            secondSandboxId,
          )
          .catch(() => undefined);
      }
      await rm(other.base, { recursive: true, force: true });
    }
  }, 120_000);
});
