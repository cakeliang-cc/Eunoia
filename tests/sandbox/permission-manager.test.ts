/**
 * The unified Permission Manager, isolated from the Gateway.
 *
 * These are the properties an agent cannot talk its way out of: a mode hint is
 * not an authority, a grant is checked against every field, and a retry of the
 * same ask does not open a second approval.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { PermissionManager } from '../../src/sandbox/permissions/permission-manager.ts';
import { GrantManager, validateGrant } from '../../src/sandbox/permissions/grant-manager.ts';
import { AuditLog, SandboxMetrics } from '../../src/sandbox/audit.ts';
import { taskPolicy } from '../../src/sandbox/policy.ts';
import { deploymentPermissionPolicy } from '../../src/sandbox/permissions/policy.ts';
import type {
  EffectivePermissionPolicy,
  PermissionEvaluationRequest,
  PermissionPolicyRecord,
} from '../../src/sandbox/permissions/types.ts';
import { createTestPlatform, testPermissionSettings, type TestPlatform } from './helpers.ts';

const platforms: TestPlatform[] = [];

afterEach(async () => {
  while (platforms.length > 0) await (platforms.pop() as TestPlatform).cleanup();
});

async function setup(options: Parameters<typeof createTestPlatform>[0] = {}) {
  const platform = await createTestPlatform(options);
  platforms.push(platform);
  const now = platform.clock.now;
  const audit = new AuditLog({ store: platform.store, now });
  const metrics = new SandboxMetrics();
  const manager = new PermissionManager({
    store: platform.store,
    audit,
    metrics,
    settings: platform.settings,
    deploymentPolicy: taskPolicy(),
    now,
  });
  return { platform, manager, audit, metrics, now };
}

function req(overrides: Partial<PermissionEvaluationRequest> = {}): PermissionEvaluationRequest {
  return {
    requestId: 'eval-1',
    sessionId: 'conversation-1',
    taskId: 'task-1',
    sandboxId: 'sbx-1',
    principal: { type: 'agent', id: 'agent:task-1' },
    action: { tool: 'write_file', operation: 'fs.write' },
    resource: { type: 'path', identifier: '/workspace/a.ts', scope: ['/workspace/a.ts'] },
    ...overrides,
  };
}

function effective(
  overrides: Parameters<typeof testPermissionSettings>[0] = {},
  permissionVersion = 1,
): EffectivePermissionPolicy {
  const deployment: PermissionPolicyRecord = deploymentPermissionPolicy({
    settings: testPermissionSettings(overrides),
    policy: taskPolicy(),
    now: new Date('2026-11-01T12:00:00.000Z'),
  });
  return {
    mode: deployment.mode,
    version: `ppv1:test.t${permissionVersion}`,
    permissionVersion,
    rules: [],
    autoReview: deployment.autoReview,
    approval: deployment.approval,
    restricted: deployment.restricted,
    sandboxPolicy: taskPolicy(),
    scopes: [],
  };
}

describe('mode hints are not authority', () => {
  it('ignores a permissionMode supplied in the request', async () => {
    const { manager } = await setup({
      writes: true,
      permission: { mode: 'read-only' },
    });

    const decision = await manager.evaluate(req({ permissionMode: 'auto' }));
    expect(decision.effect).toBe('deny');
    expect(decision.mode).toBe('read-only');
  });

  it('reuses one open request when the same ask is evaluated twice', async () => {
    const { manager } = await setup({ writes: false });
    const first = await manager.evaluate(req());
    const second = await manager.evaluate(req({ requestId: 'eval-2' }));
    expect(first.effect).toBe('approval_required');
    expect(second.effect).toBe('approval_required');
    expect(second.requestId).toBe(first.requestId);
    const requests = await manager.listRequests('task-1');
    expect(requests).toHaveLength(1);
  });
});

describe('grants are checked field by field', () => {
  it('rejects a grant issued under another policy version', async () => {
    const { platform } = await setup({ writes: false });
    const grants = new GrantManager({ store: platform.store, audit: new AuditLog({ store: platform.store, now: platform.clock.now }), now: platform.clock.now });
    const grant = await grants.create({
      request: req(),
      effective: effective({ mode: 'auto' }, 1),
      source: 'human_approval',
      scope: 'task',
      ttlSeconds: 60,
      approvedBy: 'alice',
      requestId: 'preq-1',
      resourceScope: ['/workspace/a.ts'],
    });
    expect(validateGrant(grant, req(), effective({ mode: 'auto' }, 1), platform.clock.current).valid).toBe(true);
    const stale = validateGrant(grant, req(), effective({ mode: 'auto' }, 2), platform.clock.current);
    expect(stale.valid).toBe(false);
    expect(stale.reason).toMatch(/policy version/);
  });

  it('does not cover a different action or a different path', async () => {
    const { platform } = await setup({ writes: false });
    const grants = new GrantManager({ store: platform.store, audit: new AuditLog({ store: platform.store, now: platform.clock.now }), now: platform.clock.now });
    const grant = await grants.create({
      request: req(),
      effective: effective({ mode: 'auto' }, 1),
      source: 'human_approval',
      scope: 'task',
      ttlSeconds: 60,
      approvedBy: 'alice',
      requestId: 'preq-1',
      resourceScope: ['/workspace/a.ts'],
    });
    expect(
      validateGrant(
        grant,
        req({ action: { tool: 'run_command', operation: 'process.exec' } }),
        effective({ mode: 'auto' }, 1),
        platform.clock.current,
      ).valid,
    ).toBe(false);
    expect(
      validateGrant(
        grant,
        req({ resource: { type: 'path', identifier: '/workspace/b.ts', scope: ['/workspace/b.ts'] } }),
        effective({ mode: 'auto' }, 1),
        platform.clock.current,
      ).valid,
    ).toBe(false);
  });

  it('consumes a one-time grant exactly once', async () => {
    const { platform } = await setup({ writes: false });
    const grants = new GrantManager({ store: platform.store, audit: new AuditLog({ store: platform.store, now: platform.clock.now }), now: platform.clock.now });
    const grant = await grants.create({
      request: req(),
      effective: effective({ mode: 'auto' }, 1),
      source: 'human_approval',
      scope: 'once',
      ttlSeconds: 60,
      approvedBy: 'alice',
      requestId: 'preq-1',
      resourceScope: ['/workspace/a.ts'],
    });
    expect(await grants.consume(grant)).toBe(true);
    expect(await grants.consume(grant)).toBe(false);
    const after = await platform.store.getApproval(grant.approvalId);
    expect(after?.usedAt).toBeTruthy();
  });

  it('revocation is immediate', async () => {
    const { platform } = await setup({ writes: false });
    const grants = new GrantManager({ store: platform.store, audit: new AuditLog({ store: platform.store, now: platform.clock.now }), now: platform.clock.now });
    const grant = await grants.create({
      request: req(),
      effective: effective({ mode: 'auto' }, 1),
      source: 'human_approval',
      scope: 'task',
      ttlSeconds: 60,
      approvedBy: 'alice',
      requestId: 'preq-1',
      resourceScope: ['/workspace/a.ts'],
    });
    expect(await grants.revoke(grant.approvalId, 'test', 'alice')).toBe(true);
    const revoked = await platform.store.getApproval(grant.approvalId);
    expect(revoked?.status).toBe('revoked');
    expect(
      validateGrant(revoked!, req(), effective({ mode: 'auto' }, 1), platform.clock.current).valid,
    ).toBe(false);
  });
});
