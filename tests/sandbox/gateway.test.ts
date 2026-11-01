/**
 * The Gateway through its real control flow.
 *
 * `FakeRuntime` replaces the container, not the Gateway: idempotency, state
 * transitions, ownership, approvals, output limits and UNKNOWN reconciliation
 * all run exactly as they do in production. Those are the behaviours a fake can
 * legitimately test; isolation is in `integration.docker.test.ts`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createTestPlatform, prepareTask, TASK, type TestPlatform } from './helpers.ts';
import { SandboxConflictError, SandboxError, SandboxPolicyError } from '../../src/sandbox/errors.ts';
import { createSandboxPlatform } from '../../src/sandbox/index.ts';
import { FakeRuntime } from '../../src/sandbox/runtime/fake.ts';
import { SANDBOX_POLICY_VERSION } from '../../src/sandbox/types.ts';

const platforms: TestPlatform[] = [];

afterEach(async () => {
  while (platforms.length > 0) await (platforms.pop() as TestPlatform).cleanup();
});

async function setup(options: Parameters<typeof createTestPlatform>[0] = {}): Promise<TestPlatform> {
  const platform = await createTestPlatform(options);
  platforms.push(platform);
  return platform;
}

function context(overrides: { userId?: string; taskId?: string } = {}) {
  return {
    taskId: overrides.taskId ?? TASK.taskId,
    sessionId: TASK.sessionId,
    userId: overrides.userId ?? TASK.userId,
    toolCallId: 'call-1',
  };
}

function executeInput(sandboxId: string, overrides: Record<string, unknown> = {}) {
  return {
    sandboxId,
    executionId: 'exec_test_1',
    idempotencyKey: 'call-1',
    command: ['echo', 'hi'],
    cwd: '/workspace',
    timeoutMs: 5_000,
    ...overrides,
  };
}

describe('task and sandbox creation', () => {
  it('creates a task bound to a workspace and a sandbox bound to a task', async () => {
    const platform = await setup();
    const task = await platform.gateway.ensureTask(TASK);
    expect(task.sessionId).toBe(TASK.sessionId);
    expect(task.workspaceId).toMatch(/^ws_/);
    const sandbox = await platform.gateway.ensureSandbox(context());
    expect(sandbox.taskId).toBe(task.taskId);
    expect(sandbox.workspaceId).toBe(task.workspaceId);
    expect(sandbox.status).toBe('READY');
    expect(platform.runtime.created).toHaveLength(1);
  });

  it('applies the resource profile, bounded by the deployment ceiling', async () => {
    const platform = await setup();
    const task = await platform.gateway.ensureTask(TASK);
    const sandbox = await platform.gateway.create({
      taskId: task.taskId,
      workspaceId: task.workspaceId,
      imageDigest: platform.settings.imageDigest,
      policyVersion: platform.settings.policyVersion,
      resourceProfile: 'small',
    });
    expect(sandbox.resourceProfile).toBe('small');
    const config = platform.runtime.created.at(-1);
    expect(config?.resources.memoryLimitMB).toBe(1_024);
    expect(config?.resources.cpuQuota).toBe(1);
  });

  it('does not create a container for file-only work', async () => {
    const platform = await setup({ files: { 'src/a.ts': 'export const a = 1;\n' } });
    await platform.gateway.ensureTask(TASK);
    const slice = await platform.gateway.readFile(context(), 'src/a.ts');
    expect(slice.text).toContain('export const a');
    expect(platform.runtime.created).toHaveLength(0);
  });

  it('refuses a caller-supplied image, policy or workspace mismatch', async () => {
    const platform = await setup();
    await platform.gateway.ensureTask(TASK);
    const task = await platform.store.getTask(TASK.taskId);
    await expect(
      platform.gateway.create({
        taskId: TASK.taskId,
        workspaceId: task?.workspaceId ?? 'missing',
        imageDigest: `sha256:${'d'.repeat(64)}`,
        policyVersion: SANDBOX_POLICY_VERSION,
        resourceProfile: 'default',
      }),
    ).rejects.toThrow(/operator-configured/);

    await expect(
      platform.gateway.create({
        taskId: TASK.taskId,
        workspaceId: task?.workspaceId ?? 'missing',
        imageDigest: platform.settings.imageDigest,
        policyVersion: 'sandbox-policy-v0',
        resourceProfile: 'default',
      }),
    ).rejects.toThrow(/policy version/);
  });

  it('enforces the global sandbox quota', async () => {
    const platform = await setup({ limits: { maxConcurrentGlobal: 1 } });
    await prepareTask(platform);
    await platform.gateway.ensureTask({ taskId: 'task-2', sessionId: 'conv-2', userId: 'user-2' });
    await expect(
      platform.gateway.ensureSandbox({ taskId: 'task-2', userId: 'user-2' }),
    ).rejects.toMatchObject({ code: 'quota_exceeded' });
  });

  it('checks task ownership', async () => {
    const platform = await setup();
    await prepareTask(platform);
    await expect(platform.gateway.readFile(context({ userId: 'someone-else' }), 'README.md')).rejects.toThrow(
      /different user/,
    );
  });
});

describe('execution', () => {
  it('runs through the runtime and records the event sequence', async () => {
    const platform = await setup();
    const { sandboxId } = await prepareTask(platform);

    const result = await platform.gateway.execute(context(), executeInput(sandboxId));
    expect(result.status).toBe('SUCCEEDED');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ok: echo hi');
    expect(result.startedAt).toBeTruthy();
    expect(result.finishedAt).toBeTruthy();

    const events = await platform.store.listEvents('exec_test_1');
    expect(events.map((event) => event.eventType)).toEqual([
      'execution/created',
      'execution/authorized',
      'execution/submitted',
      'execution/started',
      'execution/stdout',
      'execution/finished',
    ]);
  });

  it('is idempotent per sandbox and key', async () => {
    const platform = await setup();
    const { sandboxId } = await prepareTask(platform);

    const first = await platform.gateway.execute(context(), executeInput(sandboxId));
    const second = await platform.gateway.execute(context(), executeInput(sandboxId));
    expect(second.executionId).toBe(first.executionId);
    expect(platform.runtime.executed).toHaveLength(1);
    expect(platform.platform.metrics.snapshot().execution_duplicate).toBe(1);
  });

  it('refuses to reuse a key for a different command', async () => {
    const platform = await setup();
    const { sandboxId } = await prepareTask(platform);
    await platform.gateway.execute(context(), executeInput(sandboxId));
    await expect(
      platform.gateway.execute(context(), executeInput(sandboxId, { command: ['echo', 'different'] })),
    ).rejects.toBeInstanceOf(SandboxConflictError);
  });

  it('does not execute the same execution id twice', async () => {
    const platform = await setup();
    const { sandboxId } = await prepareTask(platform);
    await platform.gateway.execute(context(), executeInput(sandboxId));
    // Different idempotency key, same execution id: the row already exists and
    // is terminal, so the stored result is returned.
    const replay = await platform.gateway.execute(
      context(),
      executeInput(sandboxId, { idempotencyKey: 'call-2', executionId: 'exec_test_1' }),
    );
    expect(replay.executionId).toBe('exec_test_1');
    expect(platform.runtime.executed).toHaveLength(1);
  });

  it('records a non-zero exit as FAILED and keeps the output', async () => {
    const platform = await setup();
    const { sandboxId } = await prepareTask(platform);
    platform.runtime.setScript('false', { exitCode: 1, stdout: '', stderr: 'nope' });
    const result = await platform.gateway.execute(context(), executeInput(sandboxId, { command: ['false'] }));
    expect(result.status).toBe('FAILED');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('nope');
  });

  it('bounds stored output and keeps the tail', async () => {
    const platform = await setup({ maxOutputBytes: 1_024 });
    const { sandboxId } = await prepareTask(platform);
    platform.runtime.setScript('big', { stdout: `${'x'.repeat(5_000)}END` });
    const result = await platform.gateway.execute(context(), executeInput(sandboxId, { command: ['big'] }));
    expect(result.stdout.length).toBeLessThanOrEqual(1_024 + 80);
    expect(result.stdout).toContain('END');
    expect(result.stdout).toContain('truncated');
  });

  it('turns a timeout into TIMEOUT, not FAILED, and interrupts the sandbox', async () => {
    const platform = await setup();
    const { sandboxId } = await prepareTask(platform);
    platform.runtime.setScript('sleep 30', { timedOut: true });
    const result = await platform.gateway.execute(context(), executeInput(sandboxId, { command: ['sleep', '30'] }));
    expect(result.status).toBe('TIMEOUT');
    const sandbox = await platform.store.getSandbox(sandboxId);
    expect(sandbox?.status).toBe('INTERRUPTED');
  });

  it('cancels a running execution on abort and marks the sandbox interrupted', async () => {
    const platform = await setup();
    const { sandboxId } = await prepareTask(platform);
    platform.runtime.setScript('hang', { hang: true });
    const controller = new AbortController();
    const pending = platform.gateway.execute(
      context(),
      executeInput(sandboxId, { command: ['hang'] }),
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 20);
    const result = await pending;
    expect(result.status).toBe('CANCELLED');
    expect((await platform.store.getSandbox(sandboxId))?.status).toBe('INTERRUPTED');
  });

  it('never turns an unknown outcome into FAILED, and reconciles only from evidence', async () => {
    const platform = await setup();
    const { sandboxId } = await prepareTask(platform);
    platform.runtime.setScript('flaky', { throwUnavailable: true });

    await expect(
      platform.gateway.execute(context(), executeInput(sandboxId, { command: ['flaky'] })),
    ).rejects.toThrow();

    const stored = await platform.store.findExecutionByKey(sandboxId, 'call-1');
    expect(stored?.status).toBe('UNKNOWN');

    // Without a marker, reconciliation cannot invent an outcome.
    const unresolved = await platform.gateway.reconcileExecution(sandboxId, stored?.executionId ?? '');
    expect(unresolved).toBeNull();
    expect((await platform.store.getExecution(stored?.executionId ?? ''))?.status).toBe('UNKNOWN');

    // The wrapper's marker is evidence.
    platform.runtime.setMarker(stored?.executionId ?? '', 0);
    const reconciled = await platform.gateway.reconcileExecution(sandboxId, stored?.executionId ?? '');
    expect(reconciled?.status).toBe('SUCCEEDED');
    expect(reconciled?.exitCode).toBe(0);
  });

  it('shares the bind-mode workspace between tasks without sharing sandbox identity', async () => {
    const platform = await setup({ files: { 'shared.txt': 'one project' } });
    const first = await prepareTask(platform);
    await platform.gateway.ensureTask({ taskId: 'task-2', sessionId: 'conv-2', userId: 'user-2' });
    const second = await platform.gateway.ensureSandbox({ taskId: 'task-2', userId: 'user-2' });
    expect(second.workspaceId).toBe(first.workspaceId);
    expect(second.sandboxId).not.toBe(first.sandboxId);
    const read = await platform.gateway.readFile(
      { taskId: 'task-2', userId: 'user-2', sessionId: 'conv-2' },
      'shared.txt',
    );
    expect(read.text).toContain('one project');
  });

  it('redacts brokered credential values from output and stored command', async () => {
    const platform = await setup();
    const { sandboxId } = await prepareTask(platform);
    platform.platform.credentials.register({
      credentialId: 'TEST_TOKEN',
      value: 'super-secret-value',
      scopes: ['read'],
    });
    await platform.platform.credentials.issue({
      credentialId: 'TEST_TOKEN',
      taskId: TASK.taskId,
      approvedBy: 'test',
    });
    const result = await platform.gateway.execute(
      context(),
      executeInput(sandboxId, { command: ['echo', 'super-secret-value'] }),
    );
    expect(result.stdout).not.toContain('super-secret-value');
    expect(result.stdout).toContain('[redacted]');
    const stored = await platform.store.findExecutionByKey(sandboxId, 'call-1');
    expect(stored?.command.join(' ')).not.toContain('super-secret-value');
  });

  it('serialises concurrent recovery so only one container is created', async () => {
    const platform = await setup();
    const { sandboxId } = await prepareTask(platform);
    await platform.runtime.interrupt({ sandboxId, runtimeId: `fake-${sandboxId}`, runtimeType: 'fake' });
    const [left, right] = await Promise.all([
      platform.gateway.recover(context(), sandboxId),
      platform.gateway.recover(context(), sandboxId),
    ]);
    expect(left.runtimeAlive).toBe(true);
    expect(right.runtimeAlive).toBe(true);
    expect(platform.runtime.created).toHaveLength(2);
  });

  it('refuses execution against another task sandbox', async () => {
    const platform = await setup();
    const { sandboxId } = await prepareTask(platform);
    await platform.gateway.ensureTask({ taskId: 'task-2', sessionId: 'conv-2', userId: 'user-2' });
    await expect(
      platform.gateway.execute(
        { taskId: 'task-2', sessionId: 'conv-2', userId: 'user-2' },
        executeInput(sandboxId),
      ),
    ).rejects.toThrow(/different task/);
  });
});

describe('file tools through the gateway', () => {
  it('reads, lists, globs and greps the workspace', async () => {
    const platform = await setup({ files: { 'src/a.ts': 'export const needle = 1;\n' } });
    await platform.gateway.ensureTask(TASK);

    const read = await platform.gateway.readFile(context(), 'src/a.ts');
    expect(read.text).toContain('needle');
    const listing = await platform.gateway.listDir(context(), '.', 2);
    expect(listing.text).toContain('src/');
    const glob = await platform.gateway.glob(context(), '**/*.ts');
    expect(glob.paths).toContain('src/a.ts');
    const grep = await platform.gateway.grep(context(), { pattern: 'needle' });
    expect(grep.text).toContain('src/a.ts:1:');
  });

  it('writes and edits, and updates the workspace version', async () => {
    const platform = await setup();
    const task = await platform.gateway.ensureTask(TASK);
    const before = (await platform.store.getWorkspace(task.workspaceId))?.currentVersion;

    const written = await platform.gateway.writeFile(context(), 'src/new.ts', 'export const n = 1;\n');
    expect(written.created).toBe(true);
    const edited = await platform.gateway.editFile(context(), {
      path: 'src/new.ts',
      oldString: 'n = 1',
      newString: 'n = 2',
    });
    expect(edited.replacements).toBe(1);

    const after = (await platform.store.getWorkspace(task.workspaceId))?.currentVersion;
    expect(after).not.toBe(before);
  });

  it('refuses traversal, absolute paths and credentials', async () => {
    const platform = await setup();
    await platform.gateway.ensureTask(TASK);
    await writeFile(join(platform.sourceRoot, '.env'), 'TOKEN=x\n');

    await expect(platform.gateway.readFile(context(), '../etc/passwd')).rejects.toBeInstanceOf(SandboxError);
    await expect(platform.gateway.readFile(context(), '/etc/passwd')).rejects.toBeInstanceOf(SandboxError);
    await expect(platform.gateway.readFile(context(), '.env')).rejects.toThrow(/credential/);
    await expect(platform.gateway.writeFile(context(), '.env', 'TOKEN=y')).rejects.toThrow(/credential/);
  });

  it('requires an approval grant when writes are off, and honours a scoped grant', async () => {
    const platform = await setup({ writes: false });
    const task = await platform.gateway.ensureTask(TASK);

    const denied = await platform.gateway.writeFile(context(), 'src/a.ts', 'x').catch((error: unknown) => error);
    expect(denied).toBeInstanceOf(SandboxError);
    expect((denied as SandboxError).code).toBe('approval_required');

    const grant = await platform.gateway.approve(
      { taskId: task.taskId, userId: TASK.userId },
      { action: 'fs.write', resourceScope: ['/workspace'], ttlMs: 60_000, approvedBy: 'test' },
    );

    const allowed = await platform.gateway.writeFile(context(), 'src/a.ts', 'export const a = 2;\n');
    expect(allowed.path).toBe('src/a.ts');

    expect(await platform.gateway.revokeApproval(context(), grant.approvalId)).toBe(true);
    await expect(platform.gateway.writeFile(context(), 'src/a.ts', 'x')).rejects.toMatchObject({
      code: 'approval_required',
    });
  });

  it('denies a command when approval is missing, and does not create a container', async () => {
    const platform = await setup({ commands: false });
    const { sandboxId } = await prepareTask(platform);
    await expect(
      platform.gateway.execute(context(), executeInput(sandboxId)),
    ).rejects.toMatchObject({ code: 'approval_required' });
    expect(platform.runtime.executed).toHaveLength(0);
  });

  it('does not let an approval lift a system deny', async () => {
    const platform = await setup();
    const task = await platform.gateway.ensureTask(TASK);
    await platform.store.saveApproval({
      approvalId: 'approval-read',
      taskId: task.taskId,
      action: 'fs.read',
      resourceScope: ['/etc'],
      expiresAt: new Date(platform.clock.current.getTime() + 60_000).toISOString(),
      approvedBy: 'test',
      policyVersion: SANDBOX_POLICY_VERSION,
      createdAt: platform.clock.current.toISOString(),
      revokedAt: null,
    });
    await expect(platform.gateway.readFile(context(), '../etc/shadow')).rejects.toBeInstanceOf(
      SandboxPolicyError,
    );
  });
});

describe('recovery', () => {
  it('reconnects a live container and reuses the workspace', async () => {
    const platform = await setup();
    const { sandboxId } = await prepareTask(platform);
    const snapshot = await platform.gateway.recover(context(), sandboxId);
    expect(snapshot.status).toBe('READY');
    expect(snapshot.runtimeAlive).toBe(true);
    expect(platform.runtime.created).toHaveLength(1);
  });

  it('rebuilds a sandbox whose runtime vanished, without touching the workspace', async () => {
    const platform = await setup({ files: { 'keep.txt': 'persisted' } });
    const { sandboxId } = await prepareTask(platform);
    const before = await platform.gateway.readFile(context(), 'keep.txt');

    await platform.runtime.interrupt({ sandboxId, runtimeId: `fake-${sandboxId}`, runtimeType: 'fake' });
    const recovered = await platform.gateway.recover(context(), sandboxId);
    expect(recovered.runtimeAlive).toBe(true);
    expect(platform.runtime.created).toHaveLength(2);
    const after = await platform.gateway.readFile(context(), 'keep.txt');
    expect(after.text).toBe(before.text);
  });

  it('checkpoints a workspace without a container and keeps both versions', async () => {
    const platform = await setup({ files: { 'keep.txt': 'version one' } });
    await platform.gateway.ensureTask(TASK);
    const checkpoint = await platform.gateway.checkpoint(context());
    expect(checkpoint.contentDigest).toMatch(/^sha256:/);
    await platform.gateway.writeFile(context(), 'keep.txt', 'version two');
    const current = await platform.gateway.readFile(context(), 'keep.txt');
    expect(current.text).toContain('version two');
    // Restoring is a workspace-manager operation, not an execution; the
    // checkpoint itself remains durable.
    expect((await platform.store.listCheckpoints(checkpoint.workspaceId))).toHaveLength(1);
  });

  it('expires idle sandboxes but keeps their workspace and audit trail', async () => {
    const platform = await setup({ files: { 'keep.txt': 'persisted' } });
    const { sandboxId } = await prepareTask(platform);
    platform.clock.advance(2 * 60 * 60_000);
    const result = await platform.gateway.gc({ idleMs: 60 * 60_000, checkpointRetentionMs: 0 });
    expect(result.expired).toBe(1);
    expect(platform.runtime.destroyed).toContain(sandboxId);
    const sandbox = await platform.store.getSandbox(sandboxId);
    expect(sandbox?.status).toBe('DESTROYED');
    const task = await platform.store.getTask(TASK.taskId);
    const workspace = await platform.store.getWorkspace(task?.workspaceId ?? '');
    expect(workspace).not.toBeNull();
    const after = await platform.gateway.readFile(context(), 'keep.txt');
    expect(after.text).toContain('persisted');
    const audit = await platform.store.listAudit(50);
    expect(audit.some((event) => event.action === 'sandbox.gc')).toBe(true);
  });

  it('closes executions that never reached the runtime as FAILED, not UNKNOWN', async () => {
    const platform = await setup();
    const { sandboxId } = await prepareTask(platform);
    const at = platform.clock.current.toISOString();
    await platform.store.createExecution({
      executionId: 'exec_never_sent',
      taskId: TASK.taskId,
      sandboxId,
      idempotencyKey: 'call-never-sent',
      commandDigest: 'sha256:abc',
      command: ['echo'],
      cwd: '/workspace',
      status: 'CREATED',
      exitCode: null,
      startedAt: null,
      finishedAt: null,
      stdout: '',
      stderr: '',
      policyVersion: SANDBOX_POLICY_VERSION,
      toolCallId: 'call-never-sent',
      createdAt: at,
      updatedAt: at,
    });
    const reconciled = await platform.gateway.reconcileExecution(sandboxId, 'exec_never_sent');
    expect(reconciled?.status).toBe('FAILED');
  });

  it('recovers a sandbox left in CREATING by a crash', async () => {
    const platform = await setup();
    const { sandboxId } = await prepareTask(platform);
    await platform.store.updateSandbox(sandboxId, { status: 'CREATING' });
    const report = await platform.platform.recovery.recoverAll();
    expect(report.sandboxesFailed).toBe(0);
    expect((await platform.store.getSandbox(sandboxId))?.status).toBe('READY');
  });

  it('a restarted Controller reconnects a live container instead of rebuilding it', async () => {
    const platform = await setup();
    const { sandboxId } = await prepareTask(platform);
    const restarted = await createSandboxPlatform({
      store: platform.store,
      settings: platform.settings,
      runtime: platform.runtime,
      now: platform.clock.now,
    });
    const report = await restarted.recovery.recoverAll();
    expect(report.sandboxesRecovered).toBe(1);
    // The same container is still there; no second create happened.
    expect(platform.runtime.created).toHaveLength(1);
    expect((await platform.store.getSandbox(sandboxId))?.status).toBe('READY');
  });

  it('an Agent crash does not replay an in-flight execution', async () => {
    const platform = await setup();
    const { sandboxId } = await prepareTask(platform);
    const at = platform.clock.current.toISOString();
    const command = ['echo', 'crash'];
    const digest = `sha256:${createHash('sha256')
      .update(JSON.stringify({ command, cwd: '/workspace', shell: false }))
      .digest('hex')}`;
    await platform.store.createExecution({
      executionId: 'exec_inflight',
      taskId: TASK.taskId,
      sandboxId,
      idempotencyKey: 'call-inflight',
      commandDigest: digest,
      command,
      cwd: '/workspace',
      status: 'SUBMITTED',
      exitCode: null,
      startedAt: null,
      finishedAt: null,
      stdout: '',
      stderr: '',
      policyVersion: SANDBOX_POLICY_VERSION,
      toolCallId: 'call-inflight',
      createdAt: at,
      updatedAt: at,
    });

    // A new process (same container) recovers and reconciles: no marker means
    // UNKNOWN, and the command is not executed again.
    const restarted = await createSandboxPlatform({
      store: platform.store,
      settings: platform.settings,
      runtime: platform.runtime,
      now: platform.clock.now,
    });
    await restarted.recovery.recoverAll();
    const reconciled = await platform.store.getExecution('exec_inflight');
    expect(reconciled?.status).toBe('UNKNOWN');

    const replay = await restarted.gateway.execute(
      context(),
      executeInput(sandboxId, {
        idempotencyKey: 'call-inflight',
        executionId: 'exec_inflight',
        command: ['echo', 'crash'],
      }),
    );
    expect(replay.status).toBe('UNKNOWN');
    expect(platform.runtime.executed).toHaveLength(0);
  });

  it('destroying a sandbox closes unfinished executions as UNKNOWN', async () => {
    const platform = await setup();
    const { sandboxId } = await prepareTask(platform);
    const at = platform.clock.current.toISOString();
    await platform.store.createExecution({
      executionId: 'exec_running',
      taskId: TASK.taskId,
      sandboxId,
      idempotencyKey: 'call-running',
      commandDigest: 'sha256:abc',
      command: ['sleep', '60'],
      cwd: '/workspace',
      status: 'RUNNING',
      exitCode: null,
      startedAt: at,
      finishedAt: null,
      stdout: '',
      stderr: '',
      policyVersion: SANDBOX_POLICY_VERSION,
      toolCallId: 'call-running',
      createdAt: at,
      updatedAt: at,
    });
    await platform.gateway.destroy(context(), sandboxId);
    expect((await platform.store.getExecution('exec_running'))?.status).toBe('UNKNOWN');
  });

  it('a fresh Controller recovers persisted sandboxes from the database alone', async () => {
    const platform = await setup();
    const { sandboxId } = await prepareTask(platform);

    // A new runtime has no container and no memory of the old one. Recovery must
    // use the persisted sandbox metadata, not an in-process map.
    const restarted = await createSandboxPlatform({
      store: platform.store,
      settings: platform.settings,
      runtime: new FakeRuntime(),
      now: platform.clock.now,
    });
    const report = await restarted.recovery.recoverAll();
    expect(report.sandboxesChecked).toBe(1);
    expect(report.sandboxesRecovered).toBe(1);
    const sandbox = await platform.store.getSandbox(sandboxId);
    expect(sandbox?.status).toBe('READY');
  });
});
