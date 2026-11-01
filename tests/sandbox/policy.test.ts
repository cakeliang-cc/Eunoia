/**
 * Policy is the part that must be right before a container exists.
 *
 * These tests are pure: no workspace, no runtime, no clock beyond a fixed one.
 * They cover the two mistakes that are easy to make and expensive to find in
 * production:
 *
 *   - a `..` path that a string prefix check would accept;
 *   - an approval that lifts a system denial.
 */

import { describe, expect, it } from 'vitest';
import {
  PermissionManager,
  compileRuntimeConfig,
  evaluatePolicy,
  intersectPolicies,
  normalizeContainerPath,
  systemPolicy,
  taskPolicy,
  tenantPolicy,
} from '../../src/sandbox/policy.ts';
import type { ApprovalGrant } from '../../src/sandbox/types.ts';
import { SANDBOX_POLICY_VERSION } from '../../src/sandbox/types.ts';
import { SandboxPolicyError, SandboxRuntimeUnavailableError } from '../../src/sandbox/errors.ts';

const NOW = new Date('2026-11-01T12:00:00Z');

function grant(overrides: Partial<ApprovalGrant> = {}): ApprovalGrant {
  return {
    approvalId: 'approval-1',
    taskId: 'task-1',
    action: 'fs.write',
    resourceScope: ['/workspace'],
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    approvedBy: 'operator',
    policyVersion: SANDBOX_POLICY_VERSION,
    createdAt: NOW.toISOString(),
    revokedAt: null,
    ...overrides,
  };
}

describe('path normalisation', () => {
  it('resolves traversal before the allow-list sees it', () => {
    expect(normalizeContainerPath('/workspace/../etc/passwd')).toBe('/etc/passwd');
    expect(normalizeContainerPath('/workspace/./src/../src/a.ts')).toBe('/workspace/src/a.ts');
  });

  it('rejects relative, empty and control-character paths', () => {
    expect(() => normalizeContainerPath('workspace/a')).toThrow(SandboxPolicyError);
    expect(() => normalizeContainerPath('')).toThrow(SandboxPolicyError);
    expect(() => normalizeContainerPath('/workspace/a\nb')).toThrow(SandboxPolicyError);
  });

  it('denies a traversal that a naive prefix check would allow', () => {
    const decision = evaluatePolicy(taskPolicy(), {
      action: 'fs.read',
      resources: ['/workspace/../etc/passwd'],
    });
    expect(decision.decision).toBe('DENY');
    expect(decision.reason).toMatch(/system deny|outside/);
  });
});

describe('system denials', () => {
  const policy = taskPolicy();

  it.each([
    '/etc/shadow',
    '/etc/sudoers',
    '/root/.ssh/id_rsa',
    '/proc/sys/kernel/core_pattern',
    '/var/run/docker.sock',
    '/run/containerd/containerd.sock',
    '/sys/fs/cgroup',
  ])('denies %s', (path) => {
    const decision = evaluatePolicy(policy, { action: 'fs.read', resources: [path] });
    expect(decision.decision).toBe('DENY');
    expect(decision.layer).toBe('system');
  });

  it('denies credential files even inside the workspace', () => {
    for (const path of ['/workspace/.env', '/workspace/.env.local', '/workspace/key.pem']) {
      expect(evaluatePolicy(policy, { action: 'fs.read', resources: [path] }).decision).toBe('DENY');
    }
    // The example file is documentation, not a credential.
    expect(evaluatePolicy(policy, { action: 'fs.read', resources: ['/workspace/.env.example'] }).decision).toBe('ALLOW');
  });

  it('denies container-management commands', () => {
    for (const command of ['docker ps', 'nerdctl ps', 'mount /dev/sda /mnt', 'nsenter -t 1 -m sh']) {
      const decision = evaluatePolicy(policy, {
        action: 'process.exec',
        resources: ['/workspace'],
        command,
        cwd: '/workspace',
      });
      expect(decision.decision, command).toBe('DENY');
      expect(decision.layer).toBe('system');
    }
  });

  it('allows a normal command in the workspace', () => {
    const decision = evaluatePolicy(policy, {
      action: 'process.exec',
      resources: ['/workspace'],
      command: 'npm test',
      cwd: '/workspace',
    });
    expect(decision.decision).toBe('ALLOW');
  });
});

describe('approval grants', () => {
  const policy = taskPolicy();
  const manager = new PermissionManager(policy, {
    allowWorkspaceWrites: false,
    allowCommands: false,
  });

  it('requires approval when the process switch is off', () => {
    const decision = manager.evaluate(
      { action: 'fs.write', resources: ['/workspace/src/a.ts'] },
      [],
      NOW,
    );
    expect(decision.decision).toBe('APPROVAL_REQUIRED');
  });

  it('is lifted only by a matching, unexpired, same-policy grant', () => {
    expect(
      manager.evaluate({ action: 'fs.write', resources: ['/workspace/src/a.ts'] }, [grant()], NOW)
        .decision,
    ).toBe('ALLOW');

    const expired = grant({ expiresAt: new Date(NOW.getTime() - 1).toISOString() });
    expect(
      manager.evaluate({ action: 'fs.write', resources: ['/workspace/src/a.ts'] }, [expired], NOW)
        .decision,
    ).toBe('APPROVAL_REQUIRED');

    const wrongPolicy = grant({ policyVersion: 'sandbox-policy-v0' });
    expect(
      manager.evaluate({ action: 'fs.write', resources: ['/workspace/src/a.ts'] }, [wrongPolicy], NOW)
        .decision,
    ).toBe('APPROVAL_REQUIRED');

    const revoked = grant({ revokedAt: NOW.toISOString() });
    expect(
      manager.evaluate({ action: 'fs.write', resources: ['/workspace/src/a.ts'] }, [revoked], NOW)
        .decision,
    ).toBe('APPROVAL_REQUIRED');
  });

  it('cannot cover a resource outside its scope', () => {
    expect(
      manager.evaluate(
        { action: 'fs.write', resources: ['/workspace-other/a.ts'] },
        [grant({ resourceScope: ['/workspace/src'] })],
        NOW,
      ).decision,
    ).not.toBe('ALLOW');
  });

  it('never lifts a system denial', () => {
    const decision = manager.evaluate(
      { action: 'fs.read', resources: ['/etc/shadow'] },
      [grant({ action: 'fs.read', resourceScope: ['/etc'] })],
      NOW,
    );
    expect(decision.decision).toBe('DENY');
    expect(decision.layer).toBe('system');
  });

  it('uses the same rules for commands', () => {
    const commandManager = new PermissionManager(policy, {
      allowWorkspaceWrites: true,
      allowCommands: false,
    });
    const request = {
      action: 'process.exec' as const,
      resources: ['/workspace'],
      command: 'npm test',
      cwd: '/workspace',
    };
    expect(commandManager.evaluate(request, [], NOW).decision).toBe('APPROVAL_REQUIRED');
    expect(
      commandManager.evaluate(request, [grant({ action: 'process.exec', resourceScope: ['/workspace'] })], NOW)
        .decision,
    ).toBe('ALLOW');
  });
});

describe('network policy', () => {
  const policy = taskPolicy({
    networkMode: 'proxy_only',
    allowedDomains: ['example.com', '*.npmjs.org'],
    allowedPorts: [443],
  });

  it('allows allowlisted domains on allowlisted ports', () => {
    expect(
      evaluatePolicy(policy, { action: 'network.connect', resources: ['https://api.example.com/v1'] })
        .decision,
    ).toBe('ALLOW');
    expect(
      evaluatePolicy(policy, { action: 'network.connect', resources: ['https://registry.npmjs.org/pkg'] })
        .decision,
    ).toBe('ALLOW');
  });

  it('denies other domains and ports', () => {
    expect(
      evaluatePolicy(policy, { action: 'network.connect', resources: ['https://evil.test/'] }).decision,
    ).toBe('DENY');
    expect(
      evaluatePolicy(policy, { action: 'network.connect', resources: ['https://example.com:8443/'] })
        .decision,
    ).toBe('DENY');
  });

  it('denies everything when the mode is none', () => {
    expect(
      evaluatePolicy(taskPolicy(), { action: 'network.connect', resources: ['https://example.com'] })
        .decision,
    ).toBe('DENY');
  });
});

describe('policy layering', () => {
  it('narrowing cannot widen a denial', () => {
    const wide = tenantPolicy({ deniedTools: ['run_command'] });
    const narrow = taskPolicy({ deniedTools: [] });
    const effective = intersectPolicies(wide, narrow);
    expect(effective.tools.deniedTools).toContain('run_command');
    expect(
      evaluatePolicy(effective, { action: 'tool', toolName: 'run_command', resources: [] }).decision,
    ).toBe('DENY');
  });

  it('keeps the stricter network mode and the smaller limits', () => {
    const wide = tenantPolicy({
      networkMode: 'proxy_only',
      allowedDomains: ['example.com', 'npmjs.org'],
      resources: { memoryLimitMB: 4_096 },
    });
    const narrow = taskPolicy({
      networkMode: 'none',
      resources: { memoryLimitMB: 1_024 },
    });
    const effective = intersectPolicies(wide, narrow);
    expect(effective.network.mode).toBe('none');
    expect(effective.resources.memoryLimitMB).toBe(1_024);
  });
});

describe('runtime config compilation', () => {
  const base = {
    sandboxId: 'sbx_1',
    taskId: 'task-1',
    imageDigest: `sha256:${'b'.repeat(64)}`,
    workspaceHostPath: '/tmp/workspace',
  };

  it('requires an immutable digest', () => {
    expect(() => compileRuntimeConfig(taskPolicy(), { ...base, imageDigest: 'node:22-alpine' })).toThrow(
      /digest/,
    );
  });

  it('refuses a gVisor-required policy compiled as runc', () => {
    const policy = { ...taskPolicy(), runtime: { class: 'runc' as const, requireGvisor: true } };
    expect(() => compileRuntimeConfig(policy, base)).toThrow(SandboxRuntimeUnavailableError);
  });

  it('refuses code-injecting environment keys', () => {
    for (const key of ['LD_PRELOAD', 'NODE_OPTIONS', 'PYTHONSTARTUP']) {
      expect(() =>
        compileRuntimeConfig(taskPolicy(), { ...base, env: { [key]: '/tmp/x' } }),
      ).toThrow(/inject/);
    }
  });

  it('starts from a fixed minimal environment, not process.env', () => {
    const config = compileRuntimeConfig(taskPolicy(), {
      ...base,
      env: { EUNOIA_CRED_TOKEN: 'short-lived' },
    });
    expect(config.env.PATH).toContain('/usr/bin');
    expect(config.env.HOME).toBe('/tmp');
    expect(config.env.EUNOIA_CRED_TOKEN).toBe('short-lived');
    expect(config.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(config.env.DEEPSEEK_API_KEY).toBeUndefined();
  });

  it('marks the workspace read-only when the policy has no write path', () => {
    const readOnly = {
      ...taskPolicy(),
      filesystem: { read: ['/workspace'], write: [], deny: [...systemPolicy().filesystem.deny] },
    };
    expect(compileRuntimeConfig(readOnly, base).workspaceWritable).toBe(false);
  });
});
