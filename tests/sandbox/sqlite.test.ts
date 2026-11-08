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
import type { ApprovalGrant, Execution, Sandbox, Task, Workspace } from '../../src/sandbox/types.ts';
import type {
  HumanApprovalRecord,
  PermissionDecision,
  PermissionPolicyRecord,
  PermissionRequestRecord,
} from '../../src/sandbox/permissions/types.ts';

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
  it('is on the current schema version and creates every sandbox, permission and cwd table', () => {
    const sqlite = openSqliteStore(':memory:');
    open.push(sqlite);
    const version = sqlite.database.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(Number(version.user_version)).toBe(SQLITE_SCHEMA_VERSION);
    expect(SQLITE_SCHEMA_VERSION).toBe(14);
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
      'permission_policies',
      'permission_requests',
      'permission_approval_requests',
      'permission_decisions',
      'task_cwd_operations',
    ]) {
      expect(tables).toContain(table);
    }
    const taskColumns = (
      sqlite.database.prepare('PRAGMA table_info(sandbox_tasks)').all() as { name: string }[]
    ).map((row) => row.name);
    for (const column of [
      'workspace_root',
      'current_cwd',
      'cwd_version',
      'cwd_invalidated_at',
      'cwd_invalid_reason',
    ]) {
      expect(taskColumns).toContain(column);
    }
    const executionColumns = (
      sqlite.database.prepare('PRAGMA table_info(executions)').all() as { name: string }[]
    ).map((row) => row.name);
    expect(executionColumns).toContain('cwd_version');
  });

  it('migrates a version-2 database to the current version', async () => {
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
    expect(Number(version.user_version)).toBe(SQLITE_SCHEMA_VERSION);
    expect(SQLITE_SCHEMA_VERSION).toBe(14);
    const columns = opened.database
      .prepare('PRAGMA table_info(sandboxes)')
      .all() as { name: string }[];
    expect(columns.map((column) => column.name)).toContain('resource_profile');
    expect(columns.map((column) => column.name)).toContain('config_digest');
  });

  it('adds the version-6 indexes to a version-5 database', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eunoia-migrate6-'));
    dirs.push(dir);
    const path = join(dir, 'eunoia.sqlite');
    const legacy = new DatabaseSync(path);
    legacy.exec(SQLITE_SCHEMA);
    const indexes = [
      'messages_user_time_idx',
      'memories_user_updated_idx',
      'agent_runs_user_idx',
      'agent_runs_conversation_idx',
      'evaluation_results_case_idx',
    ];
    for (const index of indexes) legacy.exec(`DROP INDEX IF EXISTS ${index}`);
    legacy.exec('PRAGMA user_version = 5');
    legacy.close();

    const opened = openSqliteStore(path);
    open.push(opened);
    const version = opened.database.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(Number(version.user_version)).toBe(SQLITE_SCHEMA_VERSION);
    const present = (
      opened.database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all() as { name: string }[]
    ).map((row) => row.name);
    for (const index of indexes) expect(present).toContain(index);
  });

  it('upgrades an existing version-1 file to the current version without touching its rows', async () => {
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
      'permission_approval_requests',
      'permission_requests',
      'permission_decisions',
      'permission_policies',
    ]) {
      legacy.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    legacy.exec('PRAGMA user_version = 1');
    legacy.close();

    const opened = openSqliteStore(path);
    open.push(opened);
    const version = opened.database.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(Number(version.user_version)).toBe(SQLITE_SCHEMA_VERSION);
    expect(SQLITE_SCHEMA_VERSION).toBe(14);
    const user = opened.database.prepare("SELECT id FROM users WHERE id = 'user-1'").get() as
      | { id: string }
      | undefined;
    expect(user?.id).toBe('user-1');
    const table = opened.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sandboxes'")
      .get() as { name: string } | undefined;
    expect(table?.name).toBe('sandboxes');

    // Version 8: a version-1 file gets the turn-admission tables and the run
    // finish reason as part of the same open.
    const tables = (
      opened.database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]
    ).map((row) => row.name);
    expect(tables).toContain('turn_requests');
    expect(tables).toContain('turn_events');
    const runColumns = (
      opened.database.prepare('PRAGMA table_info(agent_runs)').all() as { name: string }[]
    ).map((column) => column.name);
    expect(runColumns).toContain('finish_reason');
  });

  it('migrates a version-3 database to the current version and adds the permission and cwd columns', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eunoia-migrate4-'));
    dirs.push(dir);
    const path = join(dir, 'eunoia.sqlite');
    const legacy = new DatabaseSync(path);
    legacy.exec(SQLITE_SCHEMA);
    for (const table of [
      'permission_decisions',
      'permission_approval_requests',
      'permission_requests',
      'permission_policies',
    ]) {
      legacy.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    legacy.exec('ALTER TABLE sandboxes DROP COLUMN config_digest');
    legacy.exec('ALTER TABLE sandbox_approvals DROP COLUMN grant_id');
    legacy.exec('ALTER TABLE executions DROP COLUMN decision_id');
    legacy.exec('PRAGMA user_version = 3');
    legacy.close();

    const opened = openSqliteStore(path);
    open.push(opened);
    const version = opened.database.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(Number(version.user_version)).toBe(SQLITE_SCHEMA_VERSION);
    expect(SQLITE_SCHEMA_VERSION).toBe(14);
    const sandboxColumns = (
      opened.database.prepare('PRAGMA table_info(sandboxes)').all() as { name: string }[]
    ).map((column) => column.name);
    expect(sandboxColumns).toContain('config_digest');
    const approvalColumns = (
      opened.database.prepare('PRAGMA table_info(sandbox_approvals)').all() as { name: string }[]
    ).map((column) => column.name);
    expect(approvalColumns).toContain('grant_id');
    const tables = (
      opened.database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]
    ).map((row) => row.name);
    expect(tables).toContain('permission_requests');
    expect(tables).toContain('turn_requests');
    expect(tables).toContain('turn_events');
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

describe('permission persistence', () => {
  function policyRow(version: number): PermissionPolicyRecord {
    return {
      policyId: `policy_task_task-1_v${version}`,
      scopeType: 'task',
      scopeId: 'task-1',
      version,
      mode: version === 1 ? 'auto' : 'read-only',
      rules: [],
      autoReview: { enabled: true, allowedRiskLevels: ['low'], maxTtlMs: 600_000 },
      approval: { allowed: true, requireHumanForRiskLevels: ['high'], maxTtlMs: 900_000 },
      restricted: {
        allowedTools: ['read'],
        filesystem: { read: ['/workspace'], write: [] },
        network: { mode: 'none', allowedDomains: [], allowedPorts: [] },
      },
      expiresAt: null,
      createdAt: at(),
      updatedAt: at(),
    };
  }

  function requestRow(): PermissionRequestRecord {
    return {
      requestId: 'preq_1',
      requestKey: 'pk_1',
      organizationId: 'default',
      projectId: 'default',
      sessionId: 'conversation-1',
      taskId: 'task-1',
      sandboxId: 'sbx_1',
      executionId: null,
      mode: 'on-request',
      principalType: 'agent',
      principalId: 'agent:task-1',
      action: 'fs.write',
      toolName: 'write',
      resourceType: 'path',
      resourceIdentifier: '/workspace/a.ts',
      resourceScope: ['/workspace/a.ts'],
      status: 'EVALUATING',
      reason: 'writes are off',
      riskLevel: 'low',
      permissionPolicyVersion: 'ppv1:test.t1',
      decisionId: null,
      grantId: null,
      approvalRequestId: null,
      autoReview: null,
      expiresAt: at(60_000),
      createdAt: at(),
      updatedAt: at(),
    };
  }

  it('persists policy versions and reads the latest', async () => {
    const { store } = await seeded();
    await store.savePermissionPolicy(policyRow(1));
    await store.savePermissionPolicy(policyRow(2));
    const latest = await store.latestPermissionPolicy('task', 'task-1');
    expect(latest?.version).toBe(2);
    expect(latest?.mode).toBe('read-only');
    expect((await store.getPermissionPolicy('task', 'task-1', 1))?.mode).toBe('auto');
    expect(await store.listPermissionPolicies('task', 'task-1')).toHaveLength(2);
  });

  it('creates, finds and compare-and-sets a request', async () => {
    const { store } = await seeded();
    const created = await store.createPermissionRequest(requestRow());
    expect(created.created).toBe(true);
    expect((await store.findOpenPermissionRequest('pk_1'))?.requestId).toBe('preq_1');

    const pending = await store.updatePermissionRequest('preq_1', ['EVALUATING'], 'PENDING', {
      approvalRequestId: 'papr_1',
    });
    expect(pending?.status).toBe('PENDING');
    expect(await store.updatePermissionRequest('preq_1', ['EVALUATING'], 'DENIED')).toBeNull();
    const approved = await store.updatePermissionRequest('preq_1', ['PENDING'], 'APPROVED', {
      decisionId: 'dec_1',
    });
    expect(approved?.status).toBe('APPROVED');
    expect((await store.listPermissionRequests({ taskId: 'task-1', statuses: ['APPROVED'] }))).toHaveLength(1);
  });

  it('persists and decides a human approval', async () => {
    const { store } = await seeded();
    await store.createPermissionRequest(requestRow());
    const approval: HumanApprovalRecord = {
      approvalRequestId: 'papr_1',
      requestId: 'preq_1',
      taskId: 'task-1',
      sessionId: 'conversation-1',
      sandboxId: 'sbx_1',
      scope: 'once',
      status: 'PENDING',
      requestedBy: 'agent:task-1',
      decidedBy: null,
      decisionReason: null,
      expiresAt: at(60_000),
      decidedAt: null,
      createdAt: at(),
    };
    await store.createHumanApproval(approval);
    const decided = await store.decideHumanApproval('papr_1', ['PENDING'], 'APPROVED', {
      decidedBy: 'alice',
      decidedAt: at(1_000),
      scope: 'task',
    });
    expect(decided?.status).toBe('APPROVED');
    expect(decided?.decidedBy).toBe('alice');
    expect(decided?.scope).toBe('task');
    expect(await store.decideHumanApproval('papr_1', ['PENDING'], 'DENIED')).toBeNull();
  });

  it('persists grants with source/status/scope and consumes them', async () => {
    const { store } = await seeded();
    const grant: ApprovalGrant = {
      approvalId: 'gr_1',
      grantId: 'gr_1',
      organizationId: 'default',
      projectId: 'default',
      sessionId: 'conversation-1',
      sandboxId: 'sbx_1',
      taskId: 'task-1',
      principalId: 'agent:task-1',
      action: 'fs.write',
      resourceScope: ['/workspace/a.ts'],
      source: 'human_approval',
      status: 'active',
      scope: 'once',
      requestId: 'preq_1',
      approvalRequestId: 'papr_1',
      expiresAt: at(60_000),
      approvedBy: 'alice',
      policyVersion: 'ppv1:test.t1',
      createdAt: at(),
      revokedAt: null,
      usedAt: null,
    };
    await store.saveApproval(grant);
    const listed = await store.listGrants({ taskId: 'task-1' });
    expect(listed[0]?.source).toBe('human_approval');
    expect(listed[0]?.scope).toBe('once');
    expect(await store.markGrantUsed('gr_1', at(1_000))).toBe(true);
    expect(await store.markGrantUsed('gr_1', at(2_000))).toBe(false);
    expect((await store.getApproval('gr_1'))?.usedAt).toBe(at(1_000));
    expect(await store.setGrantStatus('gr_1', 'revoked', at(3_000))).toBe(true);
    const revoked = await store.getApproval('gr_1');
    expect(revoked?.status).toBe('revoked');
    expect(revoked?.revokedAt).toBe(at(3_000));
  });

  it('persists permission decisions', async () => {
    const { store } = await seeded();
    const decision: PermissionDecision = {
      decisionId: 'dec_1',
      requestId: 'eval-1',
      effect: 'deny',
      layer: 'fail_closed',
      mode: 'on-request',
      permissionPolicyVersion: 'ppv1:test.t1',
      reason: 'store unavailable',
      resources: ['/workspace/a.ts'],
      taskId: 'task-1',
      sessionId: 'conversation-1',
      sandboxId: 'sbx_1',
      createdAt: at(),
    };
    await store.savePermissionDecision(decision);
    const stored = await store.getPermissionDecision('dec_1');
    expect(stored?.effect).toBe('deny');
    expect(stored?.taskId).toBe('task-1');
  });
});
