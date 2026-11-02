/**
 * The permission layer through the real Gateway control flow.
 *
 * `FakeRuntime` replaces the container, not the Gateway: requests, approvals,
 * grants, policy versions, mode switching and fail-closed handling all run as
 * they do in production. What this file proves is the part ADR 020 calls the
 * acceptance criteria: no tool executes without a decision, a mode switch
 * invalidates old grants and rebuilds a container that no longer matches, and a
 * crash cannot turn a pending approval into an approved one.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestPlatform,
  prepareTask,
  TASK,
  type TestPlatform,
} from './helpers.ts';
import { MemorySandboxStore } from '../../src/sandbox/store-memory.ts';
import { SandboxApprovalRequiredError, SandboxPolicyError } from '../../src/sandbox/errors.ts';
import type { PermissionScopeLevel } from '../../src/sandbox/permissions/types.ts';

const platforms: TestPlatform[] = [];

afterEach(async () => {
  while (platforms.length > 0) await (platforms.pop() as TestPlatform).cleanup();
});

async function setup(options: Parameters<typeof createTestPlatform>[0] = {}): Promise<TestPlatform> {
  const platform = await createTestPlatform(options);
  platforms.push(platform);
  return platform;
}

function context(taskId: string = TASK.taskId) {
  return { taskId, sessionId: TASK.sessionId, userId: TASK.userId, toolCallId: 'call-1' };
}

async function write(platform: TestPlatform, path: string, taskId: string = TASK.taskId) {
  return platform.gateway.writeFile(context(taskId), path, 'x\n');
}

async function pendingApproval(platform: TestPlatform) {
  const approvals = await platform.gateway.listPermissionApprovals(context());
  return approvals.filter((approval) => approval.status === 'PENDING');
}

describe('permission modes at the tool boundary', () => {
  it('read-only denies file writes and compiles a read-only mount', async () => {
    const platform = await setup({ permission: { mode: 'read-only' } });
    const { sandboxId } = await prepareTask(platform);
    await expect(write(platform, 'src/a.ts')).rejects.toBeInstanceOf(SandboxPolicyError);
    const created = platform.runtime.created.find((config) => config.sandboxId === sandboxId);
    expect(created?.workspaceWritable).toBe(false);
  });

  it('on-request opens one request and one approval, then a decision grants it', async () => {
    const platform = await setup({ writes: false });
    await platform.gateway.ensureTask(TASK);

    const denied = await write(platform, 'src/a.ts').catch((error: unknown) => error);
    expect(denied).toBeInstanceOf(SandboxApprovalRequiredError);
    const approvalRequestId = (denied as SandboxApprovalRequiredError).approvalRequestId;
    expect(approvalRequestId).toBeTruthy();

    const requests = await platform.gateway.listPermissionRequests(context());
    expect(requests).toHaveLength(1);
    expect(requests[0]?.status).toBe('PENDING');

    const approvals = await pendingApproval(platform);
    expect(approvals).toHaveLength(1);

    const decision = await platform.gateway.approvePermissionRequest(context(), {
      approvalRequestId: approvalRequestId as string,
      decidedBy: 'alice',
    });
    expect(decision.grantId).toBeTruthy();

    const written = await write(platform, 'src/a.ts');
    expect(written.path).toBe('src/a.ts');

    await expect(
      platform.gateway.denyPermissionRequest(context(), {
        approvalRequestId: approvalRequestId as string,
        decidedBy: 'alice',
      }),
    ).rejects.toThrow(/already approved/);

    const audit = await platform.store.listAudit(100);
    expect(audit.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        'permission.approval.required',
        'permission.request.created',
        'permission.decision.allow',
        'permission.human_approval.approved',
        'permission.grant.created',
      ]),
    );
  });

  it('auto mode approves a low-risk request without a human', async () => {
    const platform = await setup({
      writes: false,
      permission: { mode: 'auto', autoReview: { enabled: true } },
    });
    await platform.gateway.ensureTask(TASK);
    const written = await write(platform, 'src/a.ts');
    expect(written.path).toBe('src/a.ts');

    expect(await pendingApproval(platform)).toHaveLength(0);
    const grants = await platform.gateway.listPermissionGrants(context());
    expect(grants).toHaveLength(1);
    expect(grants[0]?.source).toBe('auto_review');
  });

  it('restricted allows only its whitelist and never auto-widens it', async () => {
    const platform = await setup({
      permission: {
        mode: 'restricted',
        autoReview: { enabled: true },
        restricted: {
          allowedTools: ['read', 'list_dir', 'write', 'edit'],
          filesystem: { read: ['/workspace'], write: ['/workspace/tests'] },
          network: { mode: 'none', allowedDomains: [], allowedPorts: [] },
        },
      },
    });
    await platform.gateway.ensureTask(TASK);

    await expect(write(platform, 'tests/a.ts')).resolves.toMatchObject({ path: 'tests/a.ts' });
    const denied = await write(platform, 'src/a.ts').catch((error: unknown) => error);
    expect(denied).toBeInstanceOf(SandboxApprovalRequiredError);
    expect(await pendingApproval(platform)).toHaveLength(1);
  });

  it('lets a human widen a restricted tool whitelist, but not auto-review', async () => {
    const platform = await setup({
      permission: {
        mode: 'restricted',
        autoReview: { enabled: true },
        restricted: {
          allowedTools: ['read', 'list_dir'],
          filesystem: { read: ['/workspace'], write: ['/workspace/tests'] },
          network: { mode: 'none', allowedDomains: [], allowedPorts: [] },
        },
      },
    });
    await platform.gateway.ensureTask(TASK);
    const denied = await write(platform, 'tests/a.ts').catch((error: unknown) => error);
    expect(denied).toBeInstanceOf(SandboxApprovalRequiredError);
    const approvalRequestId = (denied as SandboxApprovalRequiredError).approvalRequestId as string;
    await platform.gateway.approvePermissionRequest(context(), {
      approvalRequestId,
      decidedBy: 'alice',
      scope: 'task',
    });
    await expect(write(platform, 'tests/a.ts')).resolves.toMatchObject({ path: 'tests/a.ts' });
  });

  it('a one-time grant is consumed and the next attempt asks again', async () => {
    const platform = await setup({ writes: false });
    await platform.gateway.ensureTask(TASK);

    const first = await write(platform, 'src/a.ts').catch((error: unknown) => error);
    const firstApproval = (first as SandboxApprovalRequiredError).approvalRequestId as string;
    await platform.gateway.approvePermissionRequest(context(), {
      approvalRequestId: firstApproval,
      decidedBy: 'alice',
      scope: 'once',
    });
    await expect(write(platform, 'src/a.ts')).resolves.toBeTruthy();

    const second = await write(platform, 'src/a.ts').catch((error: unknown) => error);
    expect(second).toBeInstanceOf(SandboxApprovalRequiredError);
    expect((second as SandboxApprovalRequiredError).approvalRequestId).not.toBe(firstApproval);
  });
});

describe('policy versions and mode switches', () => {
  it('switching to read-only expires old grants and rebuilds the container', async () => {
    const platform = await setup({
      writes: false,
      commands: true,
      now: undefined,
    });
    const { sandboxId } = await prepareTask(platform);
    await platform.gateway.approve(context(), {
      action: 'process.exec',
      resourceScope: ['/workspace'],
      ttlMs: 60 * 60_000,
      approvedBy: 'alice',
    });

    const before = platform.runtime.created.length;
    await platform.gateway.execute(context(), {
      sandboxId,
      executionId: 'exec_before',
      idempotencyKey: 'call-before',
      command: ['echo', 'hi'],
      cwd: '/workspace',
      timeoutMs: 5_000,
    });
    expect(platform.runtime.created.length).toBe(before);

    await platform.gateway.setPermissionPolicy({
      scopeType: 'task',
      scopeId: TASK.taskId,
      mode: 'read-only',
      actor: 'alice',
    });

    const sandbox = await platform.store.getSandbox(sandboxId);
    expect(sandbox?.status).toBe('INTERRUPTED');
    const grants = await platform.gateway.listPermissionGrants(context());
    expect(grants.every((grant) => grant.status === 'expired')).toBe(true);

    await expect(write(platform, 'src/a.ts')).rejects.toBeInstanceOf(SandboxPolicyError);

    const after = platform.runtime.created.length;
    await platform.gateway.execute(context(), {
      sandboxId,
      executionId: 'exec_after',
      idempotencyKey: 'call-after',
      command: ['echo', 'hi'],
      cwd: '/workspace',
      timeoutMs: 5_000,
    });
    expect(platform.runtime.created.length).toBe(after + 1);
    const latest = platform.runtime.created[platform.runtime.created.length - 1];
    expect(latest?.workspaceWritable).toBe(false);
  });

  it('a grant expires with the clock and a new approval is required', async () => {
    const platform = await setup({ writes: false });
    await platform.gateway.ensureTask(TASK);

    const first = await write(platform, 'src/a.ts').catch((error: unknown) => error);
    const firstApproval = (first as SandboxApprovalRequiredError).approvalRequestId as string;
    await platform.gateway.approvePermissionRequest(context(), {
      approvalRequestId: firstApproval,
      decidedBy: 'alice',
      scope: 'task',
      ttlSeconds: 60,
    });
    await expect(write(platform, 'src/a.ts')).resolves.toBeTruthy();

    platform.clock.advance(61_000);
    const second = await write(platform, 'src/a.ts').catch((error: unknown) => error);
    expect(second).toBeInstanceOf(SandboxApprovalRequiredError);
    expect((second as SandboxApprovalRequiredError).approvalRequestId).not.toBe(firstApproval);
  });

  it('a session-scoped mode applies to the task without changing the deployment default', async () => {
    const platform = await setup();
    await platform.gateway.ensureTask(TASK);
    await platform.gateway.setPermissionPolicy({
      scopeType: 'session',
      scopeId: TASK.sessionId,
      mode: 'read-only',
      actor: 'alice',
    });
    await expect(write(platform, 'src/a.ts')).rejects.toBeInstanceOf(SandboxPolicyError);
    const status = await platform.gateway.permissionStatus(context());
    expect(status.mode).toBe('read-only');
    const scopes = status.scopes as { scopeType: PermissionScopeLevel }[];
    expect(scopes.map((scope) => scope.scopeType)).toContain('session');
  });

  it('destroying a task cancels its requests and revokes its grants', async () => {
    const platform = await setup({ writes: false });
    const { sandboxId } = await prepareTask(platform);
    const denied = await write(platform, 'src/a.ts').catch((error: unknown) => error);
    const approvalRequestId = (denied as SandboxApprovalRequiredError).approvalRequestId as string;
    await platform.gateway.approvePermissionRequest(context(), {
      approvalRequestId,
      decidedBy: 'alice',
      scope: 'task',
    });
    expect((await platform.gateway.listPermissionGrants(context())).length).toBeGreaterThan(0);

    await platform.gateway.destroy(context(), sandboxId);

    const grants = await platform.gateway.listPermissionGrants(context());
    expect(grants.every((grant) => grant.status === 'revoked')).toBe(true);
    const requests = await platform.gateway.listPermissionRequests(context());
    expect(requests.some((request) => request.status === 'CANCELLED')).toBe(true);
  });
});

describe('security properties', () => {
  it('does not let an approval lift a system denial', async () => {
    const platform = await setup({ writes: true });
    await platform.gateway.ensureTask(TASK);
    await platform.gateway.approve(context(), {
      action: 'fs.write',
      resourceScope: ['/etc'],
      ttlMs: 60_000,
      approvedBy: 'alice',
    });
    await expect(write(platform, '../etc/shadow')).rejects.toBeInstanceOf(SandboxPolicyError);
  });

  it('does not reuse a grant from another task', async () => {
    const platform = await setup({ writes: false });
    const other = { taskId: 'task-2', sessionId: 'conversation-2', userId: TASK.userId };
    await platform.gateway.ensureTask(TASK);
    await platform.gateway.ensureTask(other);
    await platform.gateway.approve(
      { taskId: other.taskId, sessionId: other.sessionId, userId: other.userId },
      { action: 'fs.write', resourceScope: ['/workspace'], ttlMs: 60_000, approvedBy: 'alice' },
    );
    await expect(write(platform, 'src/a.ts')).rejects.toBeInstanceOf(SandboxApprovalRequiredError);
    await expect(write(platform, 'src/a.ts', other.taskId)).resolves.toBeTruthy();
  });

  it('refuses an agent identity as the approver', async () => {
    const platform = await setup({ writes: false });
    await platform.gateway.ensureTask(TASK);
    const denied = await write(platform, 'src/a.ts').catch((error: unknown) => error);
    const approvalRequestId = (denied as SandboxApprovalRequiredError).approvalRequestId as string;
    await expect(
      platform.gateway.approvePermissionRequest(context(), {
        approvalRequestId,
        decidedBy: `agent:${TASK.taskId}`,
      }),
    ).rejects.toThrow(/agent cannot approve/);
  });

  it('fails closed when the permission policy cannot be loaded', async () => {
    class FailingStore extends MemorySandboxStore {
      override async latestPermissionPolicy(): Promise<never> {
        throw new Error('permission store unavailable');
      }
    }
    const platform = await setup({ store: new FailingStore() });
    await platform.gateway.ensureTask(TASK);
    await expect(write(platform, 'src/a.ts')).rejects.toThrow(/failed closed/);
    expect(platform.runtime.created).toHaveLength(0);
  });
});

describe('recovery', () => {
  it('never turns a pending approval into an approved one', async () => {
    const platform = await setup({ writes: false });
    await platform.gateway.ensureTask(TASK);
    await write(platform, 'src/a.ts').catch(() => undefined);

    const report = await platform.permissionRecovery.recoverAll();
    expect(report.requestsRestored).toBe(0);
    const approvals = await platform.gateway.listPermissionApprovals(context());
    expect(approvals[0]?.status).toBe('PENDING');
    const requests = await platform.gateway.listPermissionRequests(context());
    expect(requests[0]?.status).toBe('PENDING');
  });

  it('denies an approved request that has no grant after a crash', async () => {
    const platform = await setup({ writes: false });
    await platform.gateway.ensureTask(TASK);
    await write(platform, 'src/a.ts').catch(() => undefined);
    const approvals = await platform.gateway.listPermissionApprovals(context());
    const approval = approvals[0];
    expect(approval).toBeDefined();
    await platform.store.decideHumanApproval(
      approval!.approvalRequestId,
      ['PENDING'],
      'APPROVED',
      { decidedBy: 'alice', decidedAt: platform.clock.current.toISOString() },
    );
    await platform.store.updatePermissionRequest(approval!.requestId, ['PENDING'], 'APPROVED');

    const report = await platform.permissionRecovery.recoverAll();
    expect(report.requestsDenied).toBe(1);
    const request = await platform.store.getPermissionRequest(approval!.requestId);
    expect(request?.status).toBe('DENIED');
    expect(await platform.gateway.listPermissionGrants(context())).toHaveLength(0);
  });
});
