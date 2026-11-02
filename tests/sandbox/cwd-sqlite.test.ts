/**
 * The task cwd in SQLite (ADR 021 §2.3, §3.1, §11.5).
 *
 * The in-memory store has the same semantics; this file exists because the
 * guarantees the ADR asks for — the compare-and-set and the audit row landing
 * together, and the value surviving a process restart — are properties of the
 * database, not of an object graph.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteStore } from '../../src/db/sqlite-store.ts';
import { SqliteSandboxStore } from '../../src/sandbox/store-sqlite.ts';
import type { AuditEvent, Task } from '../../src/sandbox/types.ts';

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void> | void)();
});

const NOW = '2026-11-01T12:00:00.000Z';

function task(): Task {
  return {
    taskId: 'task-1',
    sessionId: 'session-1',
    userId: 'user-1',
    status: 'ACTIVE',
    workspaceId: 'ws_1',
    sandboxId: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function database() {
  const sqlite = openSqliteStore(':memory:');
  cleanups.push(() => sqlite.database.close());
  const store = new SqliteSandboxStore(sqlite.database);
  await store.ensureTask(task());
  return { sqlite, store };
}

function auditRow(action: string): AuditEvent {
  return {
    id: `aud_${action}`,
    timestamp: NOW,
    sessionId: 'session-1',
    taskId: task().taskId,
    sandboxId: null,
    executionId: null,
    toolCallId: null,
    policyVersion: null,
    approvalId: null,
    action,
    outcome: 'succeeded',
    detail: { action },
  };
}

describe('task cwd persistence', () => {
  it('initialises legacy columns to the workspace root at version 1', async () => {
    const { store } = await database();
    expect((await store.getTask('task-1'))?.currentCwd).toBeNull();
    await store.initializeTaskCwd({ taskId: 'task-1', workspaceRoot: '/workspace', at: NOW });
    const task = await store.getTask('task-1');
    expect(task).toMatchObject({
      workspaceRoot: '/workspace',
      currentCwd: '/workspace',
      cwdVersion: 1,
    });
  });

  it('never moves an already initialised cwd when initialising again', async () => {
    const { store } = await database();
    await store.initializeTaskCwd({ taskId: 'task-1', workspaceRoot: '/workspace', at: NOW });
    await store.compareAndSetTaskCwd({
      taskId: 'task-1',
      expectedVersion: 1,
      cwd: '/workspace/src',
      at: NOW,
      audit: auditRow('task.cwd.change.succeeded'),
    });
    await store.initializeTaskCwd({ taskId: 'task-1', workspaceRoot: '/workspace', at: NOW });
    expect((await store.getTask('task-1'))?.currentCwd).toBe('/workspace/src');
  });

  it('changes the cwd and writes the audit row in one step', async () => {
    const { store } = await database();
    await store.initializeTaskCwd({ taskId: 'task-1', workspaceRoot: '/workspace', at: NOW });
    const result = await store.compareAndSetTaskCwd({
      taskId: 'task-1',
      expectedVersion: 1,
      cwd: '/workspace/src',
      at: NOW,
      audit: auditRow('task.cwd.change.succeeded'),
    });
    expect(result.updated).toBe(true);
    expect(result.updated ? result.task.currentCwd : null).toBe('/workspace/src');
    expect(result.updated ? result.task.cwdVersion : 0).toBe(2);
    const audit = await store.listAudit(10);
    expect(audit.some((event) => event.action === 'task.cwd.change.succeeded')).toBe(true);
  });

  it('reports a stale version and changes nothing', async () => {
    const { store } = await database();
    await store.initializeTaskCwd({ taskId: 'task-1', workspaceRoot: '/workspace', at: NOW });
    await store.compareAndSetTaskCwd({
      taskId: 'task-1',
      expectedVersion: 1,
      cwd: '/workspace/src',
      at: NOW,
      audit: auditRow('task.cwd.change.succeeded'),
    });
    const stale = await store.compareAndSetTaskCwd({
      taskId: 'task-1',
      expectedVersion: 1,
      cwd: '/workspace/tests',
      at: NOW,
      audit: auditRow('task.cwd.change.succeeded'),
    });
    expect(stale).toMatchObject({ updated: false, reason: 'version_conflict' });
    expect((await store.getTask('task-1'))?.currentCwd).toBe('/workspace/src');
    const audits = await store.listAudit(10);
    expect(audits.filter((event) => event.action === 'task.cwd.change.succeeded')).toHaveLength(1);
  });

  it('refuses a change on a task that is not active', async () => {
    const { store } = await database();
    await store.initializeTaskCwd({ taskId: 'task-1', workspaceRoot: '/workspace', at: NOW });
    await store.updateTask('task-1', { status: 'COMPLETED' });
    const result = await store.compareAndSetTaskCwd({
      taskId: 'task-1',
      expectedVersion: 1,
      cwd: '/workspace/src',
      at: NOW,
      audit: auditRow('task.cwd.change.succeeded'),
    });
    expect(result).toMatchObject({ updated: false, reason: 'not_active' });
  });

  it('clears an invalidation on a successful change', async () => {
    const { store } = await database();
    await store.initializeTaskCwd({ taskId: 'task-1', workspaceRoot: '/workspace', at: NOW });
    await store.setTaskCwdInvalidation({
      taskId: 'task-1',
      reason: 'DIRECTORY_NOT_FOUND',
      at: NOW,
    });
    expect((await store.getTask('task-1'))?.cwdInvalidReason).toBe('DIRECTORY_NOT_FOUND');
    await store.compareAndSetTaskCwd({
      taskId: 'task-1',
      expectedVersion: 1,
      cwd: '/workspace/src',
      at: NOW,
      audit: auditRow('task.cwd.change.succeeded'),
    });
    const task = await store.getTask('task-1');
    expect(task?.cwdInvalidatedAt).toBeNull();
    expect(task?.cwdInvalidReason).toBeNull();
  });

  it('stores an idempotent operation result', async () => {
    const { store } = await database();
    const record = {
      operationId: 'op-1',
      taskId: 'task-1',
      path: 'src',
      result: {
        success: true as const,
        previousCwd: '/workspace',
        cwd: '/workspace/src',
        cwdVersion: 2,
        workspaceRoot: '/workspace',
      },
      cwdVersion: 2,
      createdAt: NOW,
    };
    await store.saveCwdOperation(record);
    await store.saveCwdOperation({ ...record, path: 'other' });
    expect(await store.findCwdOperation('op-1')).toEqual(record);
    expect(await store.findCwdOperation('op-missing')).toBeNull();
  });

  it('survives a reopen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eunoia-cwd-sqlite-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'eunoia.db');

    const first = openSqliteStore(path);
    const store = new SqliteSandboxStore(first.database);
    await store.ensureTask(task());
    await store.initializeTaskCwd({ taskId: 'task-1', workspaceRoot: '/workspace', at: NOW });
    await store.compareAndSetTaskCwd({
      taskId: 'task-1',
      expectedVersion: 1,
      cwd: '/workspace/src',
      at: NOW,
      audit: auditRow('task.cwd.change.succeeded'),
    });
    first.database.close();

    const second = openSqliteStore(path);
    cleanups.push(() => second.database.close());
    const reopened = new SqliteSandboxStore(second.database);
    const restored = await reopened.getTask('task-1');
    expect(restored).toMatchObject({ currentCwd: '/workspace/src', cwdVersion: 2 });
  });
});
