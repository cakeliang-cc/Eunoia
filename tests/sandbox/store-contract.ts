/**
 * The behaviours both sandbox stores must agree on.
 *
 * `MemorySandboxStore` and `SqliteSandboxStore` implement the same 56-method
 * port by hand. The SQLite one is the only one production uses, but most
 * control-plane tests run on the memory one, so a divergence is a test that
 * passes against semantics production does not have. This suite is the contract:
 * the same scenarios run against whichever store the caller hands it.
 *
 * It deliberately covers the semantics where drift is most expensive —
 * idempotency, compare-and-set, and the audit row that must commit with the cwd
 * change — not every method. A method that is a plain map lookup is not worth a
 * second test; a second implementation of "did I lose a write" is.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SandboxStore } from '../../src/sandbox/store.ts';
import type { AuditEvent, Execution, Sandbox, Task, Workspace } from '../../src/sandbox/types.ts';

export interface SandboxStoreHarness {
  readonly store: SandboxStore;
  close(): Promise<void> | void;
}

function at(offsetMs = 0): string {
  return new Date(Date.UTC(2026, 10, 1, 12, 0, 0) + offsetMs).toISOString();
}

function fixtures(): { task: Task; workspace: Workspace; sandbox: Sandbox; execution: Execution } {
  const task: Task = {
    taskId: 'task-1',
    sessionId: 'conversation-1',
    userId: 'user-1',
    status: 'ACTIVE',
    workspaceId: 'ws_1',
    sandboxId: 'sbx_1',
    createdAt: at(),
    updatedAt: at(),
  };
  const workspace: Workspace = {
    workspaceId: 'ws_1',
    taskId: 'task-1',
    storageLocation: '/tmp/ws',
    mode: 'bind',
    currentVersion: 'sha256:0',
    createdAt: at(),
    updatedAt: at(),
  };
  const sandbox: Sandbox = {
    sandboxId: 'sbx_1',
    taskId: 'task-1',
    runtimeType: 'docker',
    runtimeId: 'eunoia-sbx-1',
    imageDigest: `sha256:${'a'.repeat(64)}`,
    workspaceId: 'ws_1',
    policyVersion: 'sandbox-policy-v1',
    resourceProfile: 'default',
    status: 'READY',
    createdAt: at(),
    lastHeartbeatAt: null,
    updatedAt: at(),
  };
  const execution: Execution = {
    executionId: 'exec_1',
    taskId: 'task-1',
    sandboxId: 'sbx_1',
    idempotencyKey: 'call-1',
    commandDigest: 'sha256:abc',
    command: ['echo', 'hi'],
    cwd: '/workspace',
    status: 'CREATED',
    exitCode: null,
    startedAt: null,
    finishedAt: null,
    stdout: '',
    stderr: '',
    policyVersion: 'sandbox-policy-v1',
    toolCallId: 'call-1',
    createdAt: at(),
    updatedAt: at(),
  };
  return { task, workspace, sandbox, execution };
}

function auditEvent(): AuditEvent {
  return {
    id: 'audit-cwd-1',
    timestamp: at(3_000),
    sessionId: 'conversation-1',
    taskId: 'task-1',
    sandboxId: 'sbx_1',
    executionId: null,
    toolCallId: null,
    policyVersion: null,
    approvalId: null,
    action: 'task.cwd.change.succeeded',
    outcome: 'succeeded',
    detail: { cwd: '/workspace/src' },
  };
}

export function sandboxStoreContract(
  label: string,
  open: () => Promise<SandboxStoreHarness>,
): void {
  describe(`SandboxStore contract: ${label}`, () => {
    let harness: SandboxStoreHarness;
    let store: SandboxStore;
    let f: ReturnType<typeof fixtures>;

    beforeEach(async () => {
      harness = await open();
      store = harness.store;
      f = fixtures();
      await store.ensureTask(f.task);
      await store.saveWorkspace(f.workspace);
      await store.saveSandbox(f.sandbox);
    });

    afterEach(async () => {
      await harness.close();
    });

    it('ensureTask is idempotent and does not overwrite the existing row', async () => {
      const again = await store.ensureTask({ ...f.task, status: 'ARCHIVED', sandboxId: null });
      expect(again.status).toBe('ACTIVE');
      expect(again.sandboxId).toBe('sbx_1');
    });

    it('finds a task by its session', async () => {
      expect(await store.getTaskBySession('conversation-1')).toMatchObject({ taskId: 'task-1' });
      expect(await store.getTaskBySession('no-such-session')).toBeNull();
    });

    it('updateTask patches only what it is given, and reports a missing task', async () => {
      const updated = await store.updateTask('task-1', { status: 'ARCHIVED' });
      expect(updated?.status).toBe('ARCHIVED');
      expect(updated?.sessionId).toBe('conversation-1');
      expect(await store.updateTask('missing', { status: 'ARCHIVED' })).toBeNull();
    });

    it('initializes the cwd once and never silently moves it', async () => {
      const first = await store.initializeTaskCwd({
        taskId: 'task-1',
        workspaceRoot: '/workspace',
        at: at(1_000),
      });
      expect(first?.currentCwd).toBe('/workspace');
      expect(first?.cwdVersion).toBe(1);

      const second = await store.initializeTaskCwd({
        taskId: 'task-1',
        workspaceRoot: '/workspace/elsewhere',
        at: at(2_000),
      });
      expect(second?.currentCwd).toBe('/workspace');
      expect(second?.workspaceRoot).toBe('/workspace');
    });

    it('compareAndSetTaskCwd rejects a stale version and commits its audit row', async () => {
      const initialized = await store.initializeTaskCwd({
        taskId: 'task-1',
        workspaceRoot: '/workspace',
        at: at(1_000),
      });
      const version = initialized?.cwdVersion ?? 1;
      const audit = auditEvent();

      const moved = await store.compareAndSetTaskCwd({
        taskId: 'task-1',
        expectedVersion: version,
        cwd: '/workspace/src',
        at: at(3_000),
        audit,
      });
      expect(moved.updated).toBe(true);
      if (moved.updated) expect(moved.task.currentCwd).toBe('/workspace/src');

      const stale = await store.compareAndSetTaskCwd({
        taskId: 'task-1',
        expectedVersion: version,
        cwd: '/workspace/lib',
        at: at(4_000),
        audit: { ...audit, id: 'audit-cwd-2' },
      });
      expect(stale.updated).toBe(false);
      if (!stale.updated) expect(stale.reason).toBe('version_conflict');

      // A cwd change with no audit row is the failure the ADR forbids, so the
      // row is asserted here rather than trusted.
      const events = await store.listAudit({ taskId: 'task-1' });
      expect(events.map((event) => event.id)).toContain('audit-cwd-1');
      expect(events.map((event) => event.id)).not.toContain('audit-cwd-2');
    });

    it('createExecution is idempotent by key and findExecutionByKey agrees', async () => {
      const first = await store.createExecution(f.execution);
      expect(first.created).toBe(true);

      const second = await store.createExecution({ ...f.execution, executionId: 'exec_2' });
      expect(second.created).toBe(false);
      expect(second.execution.executionId).toBe('exec_1');

      expect(await store.findExecutionByKey('sbx_1', 'call-1')).toMatchObject({
        executionId: 'exec_1',
        idempotencyKey: 'call-1',
      });
    });

    it('transitionExecution only applies from an allowed state', async () => {
      await store.createExecution(f.execution);
      expect(await store.transitionExecution('exec_1', ['RUNNING'], 'SUCCEEDED')).toBeNull();

      const moved = await store.transitionExecution('exec_1', ['CREATED'], 'AUTHORIZED');
      expect(moved?.status).toBe('AUTHORIZED');
    });

    it('listUnfinishedExecutions excludes terminal rows', async () => {
      await store.createExecution(f.execution);
      expect((await store.listUnfinishedExecutions('sbx_1')).map((row) => row.executionId)).toEqual([
        'exec_1',
      ]);

      await store.transitionExecution('exec_1', ['CREATED'], 'FAILED', {
        finishedAt: at(5_000),
      });
      expect(await store.listUnfinishedExecutions('sbx_1')).toEqual([]);
    });

    it('updateSandbox patches the runtime fields and keeps the identity', async () => {
      const updated = await store.updateSandbox('sbx_1', {
        status: 'RUNNING',
        configDigest: 'sha256:cfg',
      });
      expect(updated?.status).toBe('RUNNING');
      expect(updated?.configDigest).toBe('sha256:cfg');
      expect(updated?.sandboxId).toBe('sbx_1');
      expect(await store.updateSandbox('missing', { status: 'RUNNING' })).toBeNull();
    });
  });
}
