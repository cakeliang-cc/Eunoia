/**
 * The sandbox persistence layer, on the real SQLite driver.
 *
 * The in-memory store is convenient, but idempotency and compare-and-set are
 * exactly where the two implementations can drift. These tests run the SQL that
 * production runs, including the version-1 → version-2 migration path.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteStore } from '../../src/db/sqlite-store.ts';
import { SqliteSandboxStore } from '../../src/sandbox/store-sqlite.ts';
import { SQLITE_SCHEMA, SQLITE_SCHEMA_VERSION } from '../../src/db/sqlite-schema.ts';
import type { Execution, Sandbox, Task, Workspace } from '../../src/sandbox/types.ts';

const open: { close: () => void }[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (open.length > 0) (open.pop() as { close: () => void }).close();
  while (dirs.length > 0) await rm(dirs.pop() as string, { recursive: true, force: true });
});

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

async function seeded(): Promise<{ db: DatabaseSync; store: SqliteSandboxStore; f: ReturnType<typeof fixtures> }> {
  const sqlite = openSqliteStore(':memory:');
  const db = sqlite.database;
  const store = new SqliteSandboxStore(db);
  const f = fixtures();
  await store.ensureTask(f.task);
  await store.saveWorkspace(f.workspace);
  await store.saveSandbox(f.sandbox);
  return { db, store, f };
}

describe('schema and migration', () => {
  it('is on schema version 2 and creates every sandbox table', () => {
    const sqlite = openSqliteStore(':memory:');
    open.push(sqlite);
    const version = sqlite.database.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(Number(version.user_version)).toBe(SQLITE_SCHEMA_VERSION);
    expect(SQLITE_SCHEMA_VERSION).toBe(3);
    const tables = (
      sqlite.database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as { name: string }[]
    ).map((row) => row.name);
    for (const table of [
      'sandbox_tasks',
      'sandbox_workspaces',
      'sandbox_workspace_checkpoints',
      'sandboxes',
      'executions',
      'execution_events',
      'sandbox_approvals',
      'sandbox_policies',
      'sandbox_audit_events',
    ]) {
      expect(tables).toContain(table);
    }
  });

  it('adds the resource profile to an existing version-2 database', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eunoia-migrate3-'));
    dirs.push(dir);
    const path = join(dir, 'eunoia.sqlite');
    const legacy = new DatabaseSync(path);
    legacy.exec(SQLITE_SCHEMA);
    legacy.exec('ALTER TABLE sandboxes DROP COLUMN resource_profile');
    legacy.exec('PRAGMA user_version = 2');
    legacy.close();

    const opened = openSqliteStore(path);
    open.push(opened);
    const version = opened.database.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(Number(version.user_version)).toBe(3);
    const columns = opened.database
      .prepare('PRAGMA table_info(sandboxes)')
      .all() as { name: string }[];
    expect(columns.map((column) => column.name)).toContain('resource_profile');
  });

  it('upgrades an existing version-1 file without touching its rows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eunoia-migrate-'));
    dirs.push(dir);
    const path = join(dir, 'eunoia.sqlite');
    const legacy = new DatabaseSync(path);
    legacy.exec(SQLITE_SCHEMA);
    legacy.prepare(
      "INSERT INTO users (id) VALUES ('user-1')",
    ).run();
    // Remove the sandbox tables and rewind the version: this is what a file
    // written by the previous build looks like.
    for (const table of [
      'sandbox_audit_events',
      'sandbox_policies',
      'sandbox_approvals',
      'execution_events',
      'executions',
      'sandboxes',
      'sandbox_workspace_checkpoints',
      'sandbox_workspaces',
      'sandbox_tasks',
    ]) {
      legacy.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    legacy.exec('PRAGMA user_version = 1');
    legacy.close();

    const opened = openSqliteStore(path);
    open.push(opened);
    const version = opened.database.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(Number(version.user_version)).toBe(3);
    const user = opened.database.prepare("SELECT id FROM users WHERE id = 'user-1'").get() as
      | { id: string }
      | undefined;
    expect(user?.id).toBe('user-1');
    const table = opened.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sandboxes'")
      .get() as { name: string } | undefined;
    expect(table?.name).toBe('sandboxes');
  });
});

describe('task, workspace and sandbox persistence', () => {
  it('round-trips entities', async () => {
    const { store, f } = await seeded();
    expect((await store.getTask('task-1'))?.workspaceId).toBe('ws_1');
    expect((await store.getWorkspace('ws_1'))?.storageLocation).toBe('/tmp/ws');
    expect((await store.getSandbox('sbx_1'))?.status).toBe('READY');
    expect((await store.getSandbox('sbx_1'))?.resourceProfile).toBe('default');
    expect((await store.getSandboxForTask('task-1'))?.sandboxId).toBe('sbx_1');
    expect((await store.getTaskBySession('conversation-1'))?.taskId).toBe('task-1');
    expect(f.task.taskId).toBe('task-1');
  });

  it('keeps heartbeat and status updates', async () => {
    const { store } = await seeded();
    await store.touchSandboxHeartbeat('sbx_1', at(5_000));
    expect((await store.getSandbox('sbx_1'))?.lastHeartbeatAt).toBe(at(5_000));
    const updated = await store.updateSandbox('sbx_1', { status: 'INTERRUPTED' });
    expect(updated?.status).toBe('INTERRUPTED');
  });

  it('stores checkpoints per workspace', async () => {
    const { store } = await seeded();
    await store.saveCheckpoint({
      checkpointId: 'ckpt_1',
      workspaceId: 'ws_1',
      taskId: 'task-1',
      createdAt: at(),
      sourceExecutionId: null,
      contentDigest: 'sha256:1',
      storageLocation: '/tmp/ckpt',
    });
    expect(await store.listCheckpoints('ws_1')).toHaveLength(1);
  });
});

describe('executions', () => {
  it('enforces idempotency per sandbox and key', async () => {
    const { store, f } = await seeded();
    const first = await store.createExecution(f.execution);
    expect(first.created).toBe(true);
    const second = await store.createExecution({ ...f.execution, executionId: 'exec_other' });
    expect(second.created).toBe(false);
    expect(second.execution.executionId).toBe('exec_1');
    expect(await store.findExecutionByKey('sbx_1', 'call-1')).not.toBeNull();
  });

  it('does compare-and-set state transitions', async () => {
    const { store, f } = await seeded();
    await store.createExecution(f.execution);
    const authorized = await store.transitionExecution('exec_1', ['CREATED'], 'AUTHORIZED');
    expect(authorized?.status).toBe('AUTHORIZED');
    // A stale writer cannot move it again from CREATED.
    const stale = await store.transitionExecution('exec_1', ['CREATED'], 'FAILED');
    expect(stale).toBeNull();
    const running = await store.transitionExecution('exec_1', ['AUTHORIZED'], 'RUNNING', {
      startedAt: at(1_000),
    });
    expect(running?.startedAt).toBe(at(1_000));
    const finished = await store.transitionExecution('exec_1', ['RUNNING'], 'UNKNOWN');
    expect(finished?.status).toBe('UNKNOWN');
    expect(await store.listUnfinishedExecutions('sbx_1')).toHaveLength(1);
  });

  it('keeps an append-only event log in order', async () => {
    const { store, f } = await seeded();
    await store.createExecution(f.execution);
    for (const [index, type] of ['created', 'authorized', 'submitted'].entries()) {
      await store.appendEvent({
        eventId: `evt_${index}`,
        taskId: 'task-1',
        sandboxId: 'sbx_1',
        executionId: 'exec_1',
        idempotencyKey: 'call-1',
        eventType: `execution/${type}`,
        timestamp: at(index),
        policyVersion: 'sandbox-policy-v1',
        payload: { index },
      });
    }
    const events = await store.listEvents('exec_1');
    expect(events.map((event) => event.eventType)).toEqual([
      'execution/created',
      'execution/authorized',
      'execution/submitted',
    ]);
  });
});

describe('approvals, policies and audit', () => {
  it('lists only live approvals for a task', async () => {
    const { store } = await seeded();
    await store.saveApproval({
      approvalId: 'a1',
      taskId: 'task-1',
      action: 'fs.write',
      resourceScope: ['/workspace'],
      expiresAt: at(60_000),
      approvedBy: 'test',
      policyVersion: 'sandbox-policy-v1',
      createdAt: at(),
      revokedAt: null,
    });
    await store.saveApproval({
      approvalId: 'a2',
      taskId: 'task-1',
      action: 'fs.write',
      resourceScope: ['/workspace'],
      expiresAt: at(-1),
      approvedBy: 'test',
      policyVersion: 'sandbox-policy-v1',
      createdAt: at(),
      revokedAt: null,
    });
    const live = await store.listApprovals('task-1', at());
    expect(live.map((grant) => grant.approvalId)).toEqual(['a1']);
    expect(await store.revokeApproval('a1', at(1_000))).toBe(true);
    expect(await store.listApprovals('task-1', at(2_000))).toEqual([]);
  });

  it('persists policy documents and audit rows', async () => {
    const { store } = await seeded();
    await store.savePolicy('sandbox-policy-v1', 'task', { filesystem: { read: ['/workspace'] } }, at());
    expect(await store.getPolicy('sandbox-policy-v1')).toEqual({ filesystem: { read: ['/workspace'] } });

    await store.appendAudit({
      id: 'aud_1',
      timestamp: at(),
      sessionId: 'conversation-1',
      taskId: 'task-1',
      sandboxId: 'sbx_1',
      executionId: 'exec_1',
      toolCallId: 'call-1',
      policyVersion: 'sandbox-policy-v1',
      approvalId: null,
      action: 'execution.complete',
      outcome: 'succeeded',
      detail: { status: 'SUCCEEDED' },
    });
    const audit = await store.listAudit(10);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.detail).toEqual({ status: 'SUCCEEDED' });
  });
});
