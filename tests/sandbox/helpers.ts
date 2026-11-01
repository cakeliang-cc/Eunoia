/**
 * Test fixture for the sandbox platform.
 *
 * The control-plane tests use `FakeRuntime` and `MemorySandboxStore`; the
 * real-runtime tests live in `integration.docker.test.ts` and are gated, because
 * ADR §16.3 is right that a fake runtime cannot prove isolation. This fixture is
 * for idempotency, state transitions, ownership, recovery and policy — the things
 * where a deterministic provider is the *better* test.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandboxPlatform, type SandboxPlatform } from '../../src/sandbox/index.ts';
import { MemorySandboxStore } from '../../src/sandbox/store-memory.ts';
import { FakeRuntime } from '../../src/sandbox/runtime/fake.ts';
import {
  RESOURCE_PROFILES,
  SANDBOX_POLICY_VERSION,
  type SandboxLimits,
} from '../../src/sandbox/types.ts';
import type { SandboxSettings } from '../../src/sandbox/config.ts';

export interface TestClock {
  current: Date;
  now: () => Date;
  advance: (ms: number) => void;
}

export function testClock(start = '2026-11-01T12:00:00.000Z'): TestClock {
  const clock: TestClock = {
    current: new Date(start),
    now: () => new Date(clock.current),
    advance: (ms: number) => {
      clock.current = new Date(clock.current.getTime() + ms);
    },
  };
  return clock;
}

export interface TestPlatform {
  readonly base: string;
  readonly sourceRoot: string;
  readonly storageRoot: string;
  readonly store: MemorySandboxStore;
  readonly settings: SandboxSettings;
  readonly runtime: FakeRuntime;
  readonly platform: SandboxPlatform;
  readonly gateway: SandboxPlatform['gateway'];
  readonly clock: TestClock;
  cleanup: () => Promise<void>;
}

export interface TestPlatformOptions {
  readonly writes?: boolean;
  readonly commands?: boolean;
  readonly network?: 'none' | 'proxy_only';
  readonly allowedDomains?: readonly string[];
  readonly allowedPorts?: readonly number[];
  readonly now?: TestClock;
  readonly mode?: 'bind' | 'copy';
  readonly maxOutputBytes?: number;
  readonly limits?: Partial<SandboxLimits>;
  /** Files to seed in the source project. */
  readonly files?: Readonly<Record<string, string>>;
}

export async function createTestPlatform(options: TestPlatformOptions = {}): Promise<TestPlatform> {
  const base = await mkdtemp(join(tmpdir(), 'eunoia-sandbox-'));
  const sourceRoot = join(base, 'repo');
  const storageRoot = join(base, 'sandboxes');
  await mkdir(sourceRoot, { recursive: true });
  const seed: Record<string, string> = {
    'README.md': '# demo\n',
    'src/app.ts': 'const answer = 42;\n',
    ...options.files,
  };
  for (const [path, content] of Object.entries(seed)) {
    await mkdir(join(sourceRoot, path, '..'), { recursive: true });
    await writeFile(join(sourceRoot, path), content);
  }

  const clock = options.now ?? testClock();
  const store = new MemorySandboxStore();
  const settings: SandboxSettings = {
    enabled: true,
    imageDigest: `sha256:${'a'.repeat(64)}`,
    policyVersion: SANDBOX_POLICY_VERSION,
    runtime: {
      kind: 'docker',
      binary: 'docker',
      globalArgs: [],
      runtimeClass: 'runc',
      requireGvisor: false,
      seccompProfile: null,
      apparmorProfile: null,
      egressNetwork: options.network === 'proxy_only' ? 'eunoia-egress-test' : null,
    },
    workspace: {
      storageRoot,
      sourceRoot,
      mode: options.mode ?? 'bind',
      ignore: [],
      allowSensitive: false,
      maxFileBytes: 2 * 1024 * 1024,
    },
    network: {
      mode: options.network ?? 'none',
      allowedDomains: options.allowedDomains ?? [],
      allowedPorts: options.allowedPorts ?? [],
      proxyUrl: null,
    },
    resources: { ...RESOURCE_PROFILES.default!.limits },
    limits: {
      maxConcurrentGlobal: 4,
      maxConcurrentPerUser: 2,
      maxConcurrentPerTask: 1,
      maxExecutionTimeoutMs: 60_000,
      maxOutputBytes: options.maxOutputBytes ?? 64 * 1024,
      ...options.limits,
    },
    allowWrites: options.writes ?? true,
    allowCommands: options.commands ?? true,
    deniedTools: [],
    heartbeatMs: 30_000,
    nonGvisorAcknowledged: true,
  };
  const runtime = new FakeRuntime();
  const platform = await createSandboxPlatform({
    store,
    settings,
    runtime,
    now: clock.now,
  });

  return {
    base,
    sourceRoot,
    storageRoot,
    store,
    settings,
    runtime,
    platform,
    gateway: platform.gateway,
    clock,
    cleanup: async () => {
      await rm(base, { recursive: true, force: true });
    },
  };
}

export const TASK = {
  taskId: 'task-1',
  sessionId: 'conversation-1',
  userId: 'user-1',
} as const;

export async function prepareTask(platform: TestPlatform): Promise<{
  sandboxId: string;
  workspaceId: string;
}> {
  await platform.gateway.ensureTask(TASK);
  const sandbox = await platform.gateway.ensureSandbox({ taskId: TASK.taskId, userId: TASK.userId });
  return { sandboxId: sandbox.sandboxId, workspaceId: sandbox.workspaceId };
}
