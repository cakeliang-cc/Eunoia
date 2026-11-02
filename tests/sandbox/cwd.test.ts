/**
 * Task-scoped working directory, end to end through the Gateway (ADR 021).
 *
 * `FakeRuntime` replaces the container, not the control plane: the task context,
 * the compare-and-set, the physical validation, the permission decision, the
 * execution snapshot and the audit rows all run exactly as they do in production.
 * Real temporary directories are used so symlink and deletion cases are real.
 *
 * Isolation (a container truly starting in the cwd) is in
 * `integration.docker.test.ts`; what a fake cannot prove is what it does not
 * claim to.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createTestPlatform, prepareTask, TASK, type TestPlatform } from './helpers.ts';
import { CwdError } from '../../src/sandbox/cwd/cwd-types.ts';
import { runCommandTool } from '../../src/tools/coding/command-tool.ts';

const platforms: TestPlatform[] = [];

afterEach(async () => {
  while (platforms.length > 0) await (platforms.pop() as TestPlatform).cleanup();
});

async function setup(options: Parameters<typeof createTestPlatform>[0] = {}): Promise<TestPlatform> {
  const platform = await createTestPlatform(options);
  platforms.push(platform);
  return platform;
}

function context() {
  return {
    taskId: TASK.taskId,
    sessionId: TASK.sessionId,
    userId: TASK.userId,
    toolCallId: 'call-1',
  };
}

async function ready(options: Parameters<typeof createTestPlatform>[0] = {}) {
  const platform = await setup(options);
  const { sandboxId } = await prepareTask(platform);
  return { platform, sandboxId };
}

describe('initial context', () => {
  it('starts every task at the workspace root, version 1', async () => {
    const { platform } = await ready();
    const current = await platform.gateway.currentDirectory(context());
    expect(current).toEqual({ cwd: '/workspace', workspaceRoot: '/workspace', cwdVersion: 1 });
    const task = await platform.gateway.taskContext(context());
    expect(task.status).toBe('active');
    expect(task.invalidatedAt).toBeNull();
  });

  it('records one initialisation audit row', async () => {
    const { platform } = await ready();
    await platform.gateway.ensureTask(TASK);
    const initialized = (await platform.store.listAudit(200)).filter(
      (event) => event.action === 'task.cwd.initialized',
    );
    expect(initialized).toHaveLength(1);
    expect(initialized[0]?.detail).toMatchObject({ cwd: '/workspace', cwd_version: 1 });
  });
});

describe('change_directory', () => {
  it('resolves a relative path against the task directory', async () => {
    const { platform } = await ready();
    const result = await platform.gateway.changeDirectory(context(), { path: 'src' });
    expect(result).toMatchObject({
      ok: true,
      previousCwd: '/workspace',
      cwd: '/workspace/src',
      cwdVersion: 2,
    });
    expect(await platform.gateway.currentDirectory(context())).toMatchObject({
      cwd: '/workspace/src',
      cwdVersion: 2,
    });
  });

  it('resolves .. against the current directory, not the workspace root', async () => {
    const { platform } = await ready();
    await platform.gateway.changeDirectory(context(), { path: 'src' });
    const result = await platform.gateway.changeDirectory(context(), { path: '../' });
    expect(result).toMatchObject({ ok: true, cwd: '/workspace' });
    const nested = await platform.gateway.changeDirectory(context(), { path: './src/../src' });
    expect(nested).toMatchObject({ ok: true, cwd: '/workspace/src' });
  });

  it('accepts an absolute path inside the workspace', async () => {
    const { platform } = await ready();
    const result = await platform.gateway.changeDirectory(context(), { path: '/workspace/src' });
    expect(result).toMatchObject({ ok: true, cwd: '/workspace/src', cwdVersion: 2 });
  });

  it('increments the version on every successful change', async () => {
    const { platform } = await ready();
    await platform.gateway.changeDirectory(context(), { path: 'src' });
    await platform.gateway.changeDirectory(context(), { path: '/workspace' });
    await platform.gateway.changeDirectory(context(), { path: 'src' });
    expect(await platform.gateway.currentDirectory(context())).toMatchObject({ cwdVersion: 4 });
  });

  it('refuses a path outside the workspace without leaking the host path', async () => {
    const { platform } = await ready();
    const result = await platform.gateway.changeDirectory(context(), { path: '../../etc' });
    expect(result).toMatchObject({ ok: false, error: 'PATH_OUTSIDE_WORKSPACE' });
    expect(result.ok ? '' : result.message).not.toContain(platform.sourceRoot);
    expect(await platform.gateway.currentDirectory(context())).toMatchObject({ cwd: '/workspace' });
  });

  it('refuses a path that does not exist, is a file, or escapes through a symlink', async () => {
    const { platform } = await ready();
    expect(
      await platform.gateway.changeDirectory(context(), { path: 'missing' }),
    ).toMatchObject({ ok: false, error: 'DIRECTORY_NOT_FOUND' });
    expect(
      await platform.gateway.changeDirectory(context(), { path: 'README.md' }),
    ).toMatchObject({ ok: false, error: 'NOT_A_DIRECTORY' });

    await symlink(platform.base, join(platform.sourceRoot, 'escape'));
    expect(
      await platform.gateway.changeDirectory(context(), { path: 'escape' }),
    ).toMatchObject({ ok: false, error: 'SYMLINK_ESCAPE' });
    // A refused change never moves the task.
    expect(await platform.gateway.currentDirectory(context())).toMatchObject({ cwd: '/workspace' });
  });

  it('refuses a task that is no longer active', async () => {
    const { platform } = await ready();
    await platform.store.updateTask(TASK.taskId, { status: 'COMPLETED' });
    const result = await platform.gateway.changeDirectory(context(), { path: 'src' });
    expect(result).toMatchObject({ ok: false, error: 'TASK_NOT_ACTIVE' });
  });

  it('replays an idempotent operation instead of moving twice', async () => {
    const { platform } = await ready();
    const first = await platform.gateway.changeDirectory(context(), {
      path: 'src',
      operationId: 'op-1',
    });
    const replay = await platform.gateway.changeDirectory(context(), {
      path: 'src',
      operationId: 'op-1',
    });
    expect(first).toMatchObject({ ok: true, cwdVersion: 2 });
    expect(replay).toEqual(first);
    expect(await platform.gateway.currentDirectory(context())).toMatchObject({ cwdVersion: 2 });
  });

  it('rejects a reused operation id with a different path', async () => {
    const { platform } = await ready();
    await platform.gateway.changeDirectory(context(), { path: 'src', operationId: 'op-1' });
    const conflict = await platform.gateway.changeDirectory(context(), {
      path: '/workspace',
      operationId: 'op-1',
    });
    expect(conflict).toMatchObject({ ok: false, error: 'IDEMPOTENCY_CONFLICT' });
  });

  it('serialises two concurrent changes on one task', async () => {
    const { platform } = await ready();
    const [left, right] = await Promise.all([
      platform.gateway.changeDirectory(context(), { path: 'src' }),
      platform.gateway.changeDirectory(context(), { path: '/workspace' }),
    ]);
    const succeeded = [left, right].filter((result) => result.ok);
    const failed = [left, right].filter((result) => !result.ok);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ ok: false, error: 'CWD_VERSION_CONFLICT' });
    expect(await platform.gateway.currentDirectory(context())).toMatchObject({ cwdVersion: 2 });
  });

  it('writes a success audit row with both directories', async () => {
    const { platform } = await ready();
    await platform.gateway.changeDirectory(context(), { path: 'src' });
    const changed = (await platform.store.listAudit(100)).filter(
      (event) => event.action === 'task.cwd.change.succeeded',
    );
    expect(changed).toHaveLength(1);
    expect(changed[0]?.detail).toMatchObject({
      previous_cwd: '/workspace',
      new_cwd: '/workspace/src',
      cwd_version: 2,
    });
  });
});

describe('audit queries', () => {
  it('narrows the trail by task and action', async () => {
    const { platform } = await ready();
    await platform.gateway.changeDirectory(context(), { path: 'src' });
    const changed = await platform.store.listAudit({
      taskId: TASK.taskId,
      action: 'task.cwd.change.succeeded',
    });
    expect(changed).toHaveLength(1);
    expect(changed[0]?.taskId).toBe(TASK.taskId);
    expect(await platform.store.listAudit({ taskId: 'task-other' })).toEqual([]);
  });
});

describe('permission modes', () => {
  it('allows a change inside the readable workspace in read-only mode', async () => {
    const { platform } = await ready({ writes: false, commands: false, permission: { mode: 'read-only' } });
    expect(await platform.gateway.changeDirectory(context(), { path: 'src' })).toMatchObject({
      ok: true,
      cwd: '/workspace/src',
    });
  });

  it('refuses a directory outside the restricted read allow-list', async () => {
    const { platform } = await ready({
      permission: {
        mode: 'restricted',
        restricted: {
          allowedTools: ['read_file', 'list_dir', 'run_command', 'change_directory'],
          filesystem: { read: ['/workspace/src'], write: [] },
        },
      },
    });
    // `/workspace/src` is on the allow-list...
    expect(await platform.gateway.changeDirectory(context(), { path: 'src' })).toMatchObject({
      ok: true,
    });
    // ...its parent is not, even though it is inside the workspace boundary.
    expect(await platform.gateway.changeDirectory(context(), { path: '..' })).toMatchObject({
      ok: false,
      error: 'PERMISSION_DENIED',
    });
  });

  it('records a denial in the audit log', async () => {
    const { platform } = await ready({ writes: false, commands: false, permission: { mode: 'read-only' } });
    await platform.gateway.changeDirectory(context(), { path: '../..' });
    const denied = (await platform.store.listAudit(100)).filter(
      (event) => event.action === 'task.cwd.change.denied',
    );
    expect(denied.length).toBeGreaterThan(0);
    expect(denied[0]?.outcome).toBe('denied');
  });
});

describe('run_command uses the task directory', () => {
  it('passes the task cwd and workspace root to the runtime', async () => {
    const { platform } = await ready();
    await platform.gateway.changeDirectory(context(), { path: 'src' });
    const session = await platform.platform.provider.forTask({
      taskId: TASK.taskId,
      sessionId: TASK.sessionId,
      userId: TASK.userId,
    });
    const result = await session.executor.run({ command: ['pwd'], shell: true, toolCallId: 'call-pwd' });
    expect(result.status).toBe('SUCCEEDED');
    const request = platform.runtime.executed.at(-1);
    expect(request?.cwd).toBe('/workspace/src');
    expect(request?.workspaceRoot).toBe('/workspace');
  });

  it('keeps a cd inside one command from moving the task', async () => {
    const { platform } = await ready();
    const session = await platform.platform.provider.forTask({
      taskId: TASK.taskId,
      sessionId: TASK.sessionId,
      userId: TASK.userId,
    });
    await session.executor.run({ command: ['cd /tmp && pwd'], shell: true, toolCallId: 'call-cd' });
    expect(platform.runtime.executed.at(-1)?.cwd).toBe('/workspace');
    expect(await platform.gateway.currentDirectory(context())).toMatchObject({ cwd: '/workspace' });
  });

  it('does not accept a workdir from the model', () => {
    // ADR §6.1: the tool schema has no cwd field, so a model cannot name one.
    const parsed = runCommandTool.parameters.safeParse({ command: 'pwd', cwd: '/etc' });
    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data : {}).not.toHaveProperty('cwd');
  });
});

describe('execution snapshot and gateway re-validation', () => {
  async function executed(platform: TestPlatform, sandboxId: string, overrides: Record<string, unknown> = {}) {
    return platform.gateway.execute(context(), {
      sandboxId,
      executionId: `exec_${Math.random().toString(16).slice(2)}`,
      idempotencyKey: `key_${Math.random().toString(16).slice(2)}`,
      command: ['echo', 'hi'],
      cwd: '/workspace',
      timeoutMs: 5_000,
      ...overrides,
    });
  }

  it('freezes cwd and cwd_version on the execution and its event', async () => {
    const { platform, sandboxId } = await ready();
    await platform.gateway.changeDirectory(context(), { path: 'src' });
    const result = await executed(platform, sandboxId, {
      cwd: '/workspace/src',
      cwdVersion: 2,
    });
    const stored = await platform.store.getExecution(result.executionId);
    expect(stored?.cwd).toBe('/workspace/src');
    expect(stored?.cwdVersion).toBe(2);

    const events = await platform.store.listEvents(result.executionId);
    const snapshot = events.find((event) => event.eventType === 'execution.cwd.snapshot.created');
    expect(snapshot?.payload).toMatchObject({
      cwd: '/workspace/src',
      cwd_version: 2,
      workspace_root: '/workspace',
    });
    // The task can move on; the execution keeps its own snapshot.
    await platform.gateway.changeDirectory(context(), { path: '..' });
    expect((await platform.store.getExecution(result.executionId))?.cwd).toBe('/workspace/src');
  });

  it('refuses a stale cwd version', async () => {
    const { platform, sandboxId } = await ready();
    await platform.gateway.changeDirectory(context(), { path: 'src' });
    await expect(
      executed(platform, sandboxId, { cwd: '/workspace/src', cwdVersion: 1 }),
    ).rejects.toMatchObject({ code: 'CWD_VERSION_MISMATCH' });
  });

  it('refuses a cwd that is not the task directory', async () => {
    const { platform, sandboxId } = await ready();
    await expect(
      executed(platform, sandboxId, { cwd: '/workspace/elsewhere' }),
    ).rejects.toMatchObject({ code: 'EXECUTION_CONTEXT_INVALID' });
  });

  it('refuses an execution against a different task sandbox contract', async () => {
    const { platform, sandboxId } = await ready();
    await expect(
      platform.gateway.execute(
        { taskId: 'task-other', userId: TASK.userId },
        {
          sandboxId,
          executionId: 'exec_other',
          idempotencyKey: 'call_other',
          command: ['echo', 'hi'],
          cwd: '/workspace',
          timeoutMs: 1_000,
        },
      ),
    ).rejects.toThrow();
  });
});

describe('invalid cwd and recovery', () => {
  it('refuses to execute in a deleted directory and marks the context invalid', async () => {
    const { platform, sandboxId } = await ready();
    await platform.gateway.changeDirectory(context(), { path: 'src' });
    await rm(join(platform.sourceRoot, 'src'), { recursive: true, force: true });

    const before = platform.runtime.executed.length;
    await expect(
      platform.gateway.execute(context(), {
        sandboxId,
        executionId: 'exec_missing',
        idempotencyKey: 'call_missing',
        command: ['echo', 'hi'],
        cwd: '/workspace/src',
        cwdVersion: 2,
        timeoutMs: 1_000,
      }),
    ).rejects.toBeInstanceOf(CwdError);
    // The command never became a container process.
    expect(platform.runtime.executed.length).toBe(before);

    const task = await platform.gateway.taskContext(context());
    expect(task.invalidatedAt).not.toBeNull();
    expect(task.invalidReason).toBe('DIRECTORY_NOT_FOUND');
    // The recorded cwd is kept, not rewritten to `/workspace`.
    expect(task.cwd).toBe('/workspace/src');

    const audit = await platform.store.listAudit(200);
    expect(audit.some((event) => event.action === 'execution.cwd.validation.failed')).toBe(true);
  });

  it('refuses every execution until an explicit change_directory fixes it', async () => {
    const { platform, sandboxId } = await ready();
    await platform.gateway.changeDirectory(context(), { path: 'src' });
    await rm(join(platform.sourceRoot, 'src'), { recursive: true, force: true });
    const input = {
      sandboxId,
      executionId: 'exec_invalid',
      idempotencyKey: 'call_invalid',
      command: ['echo', 'hi'],
      cwd: '/workspace/src',
      cwdVersion: 2,
      timeoutMs: 1_000,
    };
    await expect(platform.gateway.execute(context(), input)).rejects.toMatchObject({
      code: 'DIRECTORY_NOT_FOUND',
    });
    // Now the context is marked, so even a would-be valid retry is refused: the
    // platform must not quietly behave as if nothing happened.
    await expect(platform.gateway.execute(context(), input)).rejects.toMatchObject({
      code: 'CWD_INVALID',
    });

    expect(await platform.gateway.changeDirectory(context(), { path: '/workspace' })).toMatchObject({
      ok: true,
      cwdVersion: 3,
    });
    expect((await platform.gateway.taskContext(context())).invalidatedAt).toBeNull();
    const result = await platform.gateway.execute(context(), {
      ...input,
      executionId: 'exec_recovered',
      idempotencyKey: 'call_recovered',
      cwd: '/workspace',
      cwdVersion: 3,
    });
    expect(result.status).toBe('SUCCEEDED');
  });

  it('re-validates on recovery without inventing a directory', async () => {
    const { platform, sandboxId } = await ready();
    await platform.gateway.changeDirectory(context(), { path: 'src' });
    await rm(join(platform.sourceRoot, 'src'), { recursive: true, force: true });
    await platform.gateway.recover(context(), sandboxId);
    const task = await platform.gateway.taskContext(context());
    expect(task.invalidatedAt).not.toBeNull();
    expect(task.cwd).toBe('/workspace/src');

    await mkdir(join(platform.sourceRoot, 'src'), { recursive: true });
    await platform.gateway.recover(context(), sandboxId);
    expect((await platform.gateway.taskContext(context())).invalidatedAt).toBeNull();
  });
});
