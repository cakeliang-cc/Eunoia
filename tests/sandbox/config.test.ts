/**
 * Configuration is a security boundary: a half-configured sandbox must refuse to
 * start, not quietly fall back to the host.
 */

import { describe, expect, it } from 'vitest';
import { sandboxSettings } from '../../src/sandbox/config.ts';
import { SandboxError } from '../../src/sandbox/errors.ts';

const DIGEST = `sha256:${'e'.repeat(64)}`;

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    WORKSPACE_ROOT: '/tmp/project',
    SANDBOX_IMAGE_DIGEST: DIGEST,
    SANDBOX_RUNTIME_CLASS: 'runc',
    SANDBOX_ALLOW_NON_GVISOR: '1',
    ...overrides,
  };
}

describe('sandbox settings', () => {
  it('is disabled when no workspace is configured', () => {
    expect(sandboxSettings({})).toBeNull();
    expect(sandboxSettings({ WORKSPACE_ROOT: '/tmp/x', SANDBOX_ENABLED: '0' })).toBeNull();
  });

  it('refuses to enable the sandbox without a workspace', () => {
    expect(() => sandboxSettings({ SANDBOX_ENABLED: '1', SANDBOX_IMAGE_DIGEST: DIGEST })).toThrow(
      /WORKSPACE_ROOT/,
    );
  });

  it('requires an immutable image digest', () => {
    expect(() => sandboxSettings(env({ SANDBOX_IMAGE_DIGEST: 'node:22-alpine' }))).toThrow(/digest/);
    expect(() => sandboxSettings(env({ SANDBOX_IMAGE_DIGEST: '' }))).toThrow(/digest/);
  });

  it('requires an explicit acknowledgement for a non-gVisor runtime', () => {
    expect(() =>
      sandboxSettings(env({ SANDBOX_RUNTIME_CLASS: 'runc', SANDBOX_ALLOW_NON_GVISOR: undefined })),
    ).toThrow(SandboxError);
    const settings = sandboxSettings(env());
    expect(settings?.runtime.runtimeClass).toBe('runc');
    expect(settings?.runtime.requireGvisor).toBe(false);
    expect(settings?.nonGvisorAcknowledged).toBe(true);
  });

  it('defaults to gVisor and requires it', () => {
    const settings = sandboxSettings(env({ SANDBOX_RUNTIME_CLASS: undefined }));
    expect(settings?.runtime.runtimeClass).toBe('gvisor');
    expect(settings?.runtime.requireGvisor).toBe(true);
  });

  it('maps workspace flags into writes and commands', () => {
    const settings = sandboxSettings(env({ WORKSPACE_WRITES: '1', WORKSPACE_COMMANDS: '1' }));
    expect(settings?.allowWrites).toBe(true);
    expect(settings?.allowCommands).toBe(true);
    const readOnly = sandboxSettings(env());
    expect(readOnly?.allowWrites).toBe(false);
    expect(readOnly?.allowCommands).toBe(false);
  });

  it('refuses proxy_only without an egress network', () => {
    expect(() => sandboxSettings(env({ SANDBOX_NETWORK_MODE: 'proxy_only' }))).toThrow(/EGRESS_NETWORK/);
    expect(() =>
      sandboxSettings(env({ SANDBOX_NETWORK_MODE: 'proxy_only', SANDBOX_EGRESS_NETWORK: 'eunoia-egress' })),
    ).toThrow(/PROXY_URL/);
    const settings = sandboxSettings(
      env({
        SANDBOX_NETWORK_MODE: 'proxy_only',
        SANDBOX_EGRESS_NETWORK: 'eunoia-egress',
        SANDBOX_PROXY_URL: 'http://host.docker.internal:8788',
      }),
    );
    expect(settings?.network.mode).toBe('proxy_only');
    expect(settings?.network.proxyUrl).toBe('http://host.docker.internal:8788');
  });

  it('clamps resource values to the hard ceiling', () => {
    const settings = sandboxSettings(
      env({ SANDBOX_CPU: '999', SANDBOX_MEMORY_MB: '999999', SANDBOX_PIDS: '999999', SANDBOX_TIMEOUT_MS: '999999999' }),
    );
    expect(settings?.resources.cpuQuota).toBe(8);
    expect(settings?.resources.memoryLimitMB).toBe(16_384);
    expect(settings?.resources.maxProcesses).toBe(8_192);
    expect(settings?.resources.executionTimeoutMs).toBe(2 * 60 * 60_000);
  });

  it('derives a permission mode from the deployment switches', () => {
    const readOnly = sandboxSettings(env());
    expect(readOnly?.permission.mode).toBe('read-only');
    expect(readOnly?.permission.autoReview.enabled).toBe(false);

    const onRequest = sandboxSettings(env({ WORKSPACE_COMMANDS: '1' }));
    expect(onRequest?.permission.mode).toBe('on-request');

    const auto = sandboxSettings(env({ WORKSPACE_WRITES: '1', WORKSPACE_COMMANDS: '1' }));
    expect(auto?.permission.mode).toBe('auto');
    expect(auto?.permission.autoReview.enabled).toBe(true);
  });

  it('honours explicit permission settings and rejects an unknown mode', () => {
    const settings = sandboxSettings(
      env({
        WORKSPACE_WRITES: '1',
        WORKSPACE_COMMANDS: '1',
        SANDBOX_PERMISSION_MODE: 'restricted',
        SANDBOX_AUTO_REVIEW: 'off',
        SANDBOX_AUTO_APPROVE_RISK: 'low',
        SANDBOX_RESTRICTED_WRITE: '/workspace/tests',
        SANDBOX_RESTRICTED_TOOLS: 'read,write',
      }),
    );
    expect(settings?.permission.mode).toBe('restricted');
    expect(settings?.permission.autoReview.enabled).toBe(false);
    expect(settings?.permission.autoReview.allowedRiskLevels).toEqual(['low']);
    expect(settings?.permission.restricted.filesystem.write).toEqual(['/workspace/tests']);
    expect(settings?.permission.restricted.allowedTools).toEqual(['read', 'write']);

    expect(() => sandboxSettings(env({ SANDBOX_PERMISSION_MODE: 'yolo' }))).toThrow(/PERMISSION_MODE/);
    expect(() =>
      sandboxSettings(env({ SANDBOX_PERMISSION_ALLOWED_MODES: 'auto,everything' })),
    ).toThrow(/allowed/i);
  });

  it('builds nerdctl global arguments from operator configuration', () => {
    const settings = sandboxSettings(
      env({
        SANDBOX_RUNTIME_CLIENT: 'nerdctl',
        SANDBOX_NERDCTL_NAMESPACE: 'sandbox',
        SANDBOX_NERDCTL_ADDRESS: '/run/containerd/containerd.sock',
      }),
    );
    expect(settings?.runtime.kind).toBe('nerdctl');
    expect(settings?.runtime.globalArgs).toEqual([
      '--address',
      '/run/containerd/containerd.sock',
      '--namespace',
      'sandbox',
    ]);
  });
});
