/**
 * `CwdManager` in isolation (ADR 021 §3, §4, §9, §10.2).
 *
 * The Gateway-level tests cover the tool flow; this file covers the rules that
 * are easier to see without a sandbox: the compare-and-set contract, the
 * `expectedCwdVersion` guard and the mapping from a permission decision to a
 * structured failure. The permission port is a stub because the manager's job is
 * to *use* the decision, not to compute it.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySandboxStore } from '../../src/sandbox/store-memory.ts';
import { AuditLog, SandboxMetrics } from '../../src/sandbox/audit.ts';
import { TaskContextStore } from '../../src/sandbox/cwd/task-context-store.ts';
import { FilesystemCwdValidator } from '../../src/sandbox/cwd/cwd-validator.ts';
import { CwdManager, type CwdPermissionPort } from '../../src/sandbox/cwd/cwd-manager.ts';
import type {
  EffectivePermissionPolicy,
  PermissionDecision,
  PermissionEvaluationRequest,
} from '../../src/sandbox/permissions/types.ts';
import { WORKSPACE_MOUNT_PATH, type SandboxPolicy } from '../../src/sandbox/types.ts';

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop() as string, { recursive: true, force: true });
});

const policy: SandboxPolicy = {
  policyVersion: 'test-policy',
  filesystem: { read: ['/workspace'], write: ['/workspace'], deny: ['/etc'] },
  network: { mode: 'none', allowedDomains: [], allowedPorts: [] },
  process: { maxProcesses: 8, allowShell: true },
  resources: {
    cpuQuota: 1,
    memoryLimitMB: 512,
    diskLimitMB: 1_024,
    executionTimeoutMs: 5_000,
    maxProcesses: 8,
    outputLimitBytes: 1_024,
    idleTimeoutMs: 5_000,
  },
  tools: { allowedTools: [], deniedTools: [] },
  runtime: { class: 'runc', requireGvisor: false },
};

const effective: EffectivePermissionPolicy = {
  mode: 'auto',
  version: 'ppv1:test',
  permissionVersion: 1,
  rules: [],
  autoReview: { enabled: false, allowedRiskLevels: ['low'], maxTtlMs: 1_000 },
  approval: { allowed: true, requireHumanForRiskLevels: ['high'], maxTtlMs: 1_000 },
  restricted: {
    allowedTools: [],
    filesystem: { read: ['/workspace'], write: [] },
    network: { mode: 'none', allowedDomains: [], allowedPorts: [] },
  },
  sandboxPolicy: policy,
  scopes: [],
};

function decision(request: PermissionEvaluationRequest, effect: PermissionDecision['effect']): PermissionDecision {
  return {
    effect,
    decisionId: 'dec_test',
    requestId: request.requestId,
    mode: effective.mode,
    permissionPolicyVersion: effective.version,
    layer: 'policy',
    reason: effect === 'allow' ? 'allowed by test policy' : 'denied by test policy',
    resources: [request.resource.identifier],
  };
}

async function harness(options: { effect?: PermissionDecision['effect'] } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'eunoia-cwd-manager-'));
  roots.push(base);
  const hostRoot = join(base, 'workspace');
  await mkdir(join(hostRoot, 'src'), { recursive: true });
  await mkdir(join(hostRoot, 'tests'), { recursive: true });

  const store = new MemorySandboxStore();
  const now = () => new Date('2026-11-01T12:00:00.000Z');
  const audit = new AuditLog({ store, now });
  const contexts = new TaskContextStore({ store, now, audit });
  const seen: PermissionEvaluationRequest[] = [];
  const permissions: CwdPermissionPort = {
    effectivePolicy: async () => effective,
    evaluate: async (request) => {
      seen.push(request);
      return decision(request, options.effect ?? 'allow');
    },
    revalidate: async (current) => current,
    consume: async () => true,
  };
  const manager = new CwdManager({
    store,
    contexts,
    validator: new FilesystemCwdValidator(),
    permissions,
    audit,
    metrics: new SandboxMetrics(),
    now,
  });

  await store.ensureTask({
    taskId: 'task-1',
    sessionId: 'session-1',
    userId: 'user-1',
    status: 'ACTIVE',
    workspaceId: 'ws_1',
    sandboxId: 'sbx_1',
    workspaceRoot: WORKSPACE_MOUNT_PATH,
    currentCwd: WORKSPACE_MOUNT_PATH,
    cwdVersion: 1,
    createdAt: '2026-11-01T12:00:00.000Z',
    updatedAt: '2026-11-01T12:00:00.000Z',
  });
  await store.saveWorkspace({
    workspaceId: 'ws_1',
    taskId: 'task-1',
    storageLocation: hostRoot,
    mode: 'bind',
    currentVersion: 'v1',
    createdAt: '2026-11-01T12:00:00.000Z',
    updatedAt: '2026-11-01T12:00:00.000Z',
  });

  return { manager, store, contexts, seen, hostRoot };
}

describe('CwdManager', () => {
  it('returns the current directory without changing it', async () => {
    const { manager } = await harness();
    expect(await manager.getCurrentDirectory('task-1')).toEqual({
      cwd: '/workspace',
      workspaceRoot: '/workspace',
      cwdVersion: 1,
    });
  });

  it('increments the version and records the previous directory', async () => {
    const { manager } = await harness();
    const result = await manager.changeDirectory({ taskId: 'task-1', path: 'src' });
    expect(result).toEqual({
      success: true,
      previousCwd: '/workspace',
      cwd: '/workspace/src',
      cwdVersion: 2,
      workspaceRoot: '/workspace',
    });
  });

  it('refuses an expected version that is stale, without re-resolving the path', async () => {
    const { manager, store } = await harness();
    await manager.changeDirectory({ taskId: 'task-1', path: 'src' });
    const stale = await manager.changeDirectory({
      taskId: 'task-1',
      path: '..',
      expectedCwdVersion: 1,
    });
    expect(stale).toMatchObject({ success: false, error: 'CWD_VERSION_CONFLICT' });
    expect((await store.getTask('task-1'))?.currentCwd).toBe('/workspace/src');
  });

  it('asks the permission layer about the target directory', async () => {
    const { manager, seen } = await harness();
    await manager.changeDirectory({ taskId: 'task-1', path: 'src' });
    expect(seen.at(-1)?.action).toEqual({ tool: 'change_directory', operation: 'fs.chdir' });
    expect(seen.at(-1)?.resource.identifier).toBe('/workspace/src');
    expect(seen.at(-1)?.context?.cwd).toBe('/workspace');
  });

  it('maps a denied decision to PERMISSION_DENIED and keeps the cwd', async () => {
    const { manager, store } = await harness({ effect: 'deny' });
    const result = await manager.changeDirectory({ taskId: 'task-1', path: 'src' });
    expect(result).toMatchObject({ success: false, error: 'PERMISSION_DENIED' });
    expect((await store.getTask('task-1'))?.currentCwd).toBe('/workspace');
  });

  it('maps an approval_required decision to a refusal the model can act on', async () => {
    const { manager } = await harness({ effect: 'approval_required' });
    const result = await manager.changeDirectory({ taskId: 'task-1', path: 'src' });
    expect(result).toMatchObject({ success: false, error: 'PERMISSION_DENIED' });
  });

  it('refuses a task that does not exist', async () => {
    const { manager } = await harness();
    const result = await manager.changeDirectory({ taskId: 'task-missing', path: 'src' });
    expect(result).toMatchObject({ success: false, error: 'TASK_NOT_FOUND' });
  });

  it('validates the current directory and reports an invalid one', async () => {
    const { manager, hostRoot } = await harness();
    await manager.changeDirectory({ taskId: 'task-1', path: 'src' });
    await rm(join(hostRoot, 'src'), { recursive: true, force: true });
    await expect(manager.validateCurrent('task-1')).rejects.toMatchObject({
      code: 'DIRECTORY_NOT_FOUND',
    });
    await expect(manager.validateCurrent('task-1')).rejects.toMatchObject({ code: 'CWD_INVALID' });
  });

  it('is idempotent per operation id, down to the returned value', async () => {
    const { manager } = await harness();
    const first = await manager.changeDirectory({
      taskId: 'task-1',
      path: 'src',
      operationId: 'op-1',
    });
    const second = await manager.changeDirectory({
      taskId: 'task-1',
      path: 'src',
      operationId: 'op-1',
    });
    expect(second).toEqual(first);
  });

  it('rejects an operation id reused with a different path', async () => {
    const { manager } = await harness();
    await manager.changeDirectory({ taskId: 'task-1', path: 'src', operationId: 'op-1' });
    expect(
      await manager.changeDirectory({ taskId: 'task-1', path: 'tests', operationId: 'op-1' }),
    ).toMatchObject({ success: false, error: 'IDEMPOTENCY_CONFLICT' });
  });
});
