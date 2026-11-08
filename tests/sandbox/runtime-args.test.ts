/**
 * The container argv, inspected without a container.
 *
 * These are the assertions that must never regress: no privileged mode, no host
 * namespaces, no host mount, no Docker socket, a non-root user, a read-only
 * rootfs, dropped capabilities and hard resource limits. A single line deleted
 * from the argv builder would otherwise be invisible until an incident.
 */

import { describe, expect, it } from 'vitest';
import {
  assertBaseline,
  buildCreateArgs,
  buildExecArgs,
  runtimeNameFor,
  WRAPPER,
  sandboxContainerName,
} from '../../src/sandbox/runtime/oci-args.ts';
import type { RuntimeSandboxConfig } from '../../src/sandbox/types.ts';
import { SandboxPolicyError } from '../../src/sandbox/errors.ts';

const config: RuntimeSandboxConfig = {
  sandboxId: 'sbx_abc',
  taskId: 'task-1',
  imageDigest: `sha256:${'c'.repeat(64)}`,
  workspaceHostPath: '/tmp/eunoia/workspace',
  workspaceWritable: true,
  configDigest: `sha256:${'d'.repeat(64)}`,
  runtimeClass: 'gvisor',
  resources: {
    cpuQuota: 2,
    memoryLimitMB: 2_048,
    diskLimitMB: 4_096,
    executionTimeoutMs: 60_000,
    maxProcesses: 128,
    outputLimitBytes: 32_768,
    idleTimeoutMs: 60_000,
  },
  network: { mode: 'none', allowedDomains: [], allowedPorts: [] },
  env: { PATH: '/usr/bin', HOME: '/tmp' },
  labels: {},
};

function pairs(args: readonly string[], flag: string): string[] {
  return args.flatMap((arg, index) => (arg === flag ? [String(args[index + 1])] : []));
}

describe('create argv', () => {
  it('uses gVisor when the policy asks for it', () => {
    expect(buildCreateArgs(config, { binary: 'docker', kind: 'docker', globalArgs: [] }, null)).toContain(
      'runsc',
    );
    const nerdctl = buildCreateArgs(
      { ...config, runtimeClass: 'gvisor' },
      { binary: 'nerdctl', kind: 'nerdctl', globalArgs: ['--namespace', 'eunoia'] },
      null,
    );
    expect(nerdctl).toContain('io.containerd.runsc.v1');
  });

  it('has the security baseline', () => {
    const args = buildCreateArgs(config, { binary: 'docker', kind: 'docker', globalArgs: [] }, null);
    expect(args).toContain('--read-only');
    expect(pairs(args, '--cap-drop')).toEqual(['ALL']);
    expect(pairs(args, '--security-opt')).toContain('no-new-privileges:true');
    expect(pairs(args, '--user')).toEqual(['1000:1000']);
    expect(pairs(args, '--network')).toEqual(['none']);
    expect(args).toContain('--init');
    expect(pairs(args, '--pull')).toEqual(['never']);
    expect(pairs(args, '--pids-limit')).toEqual(['128']);
    // A tmpfs without mode=1777 is root-owned; a uid-1000 command cannot write
    // its marker or cache there.
    expect(pairs(args, '--tmpfs')[0]).toContain('mode=1777');
    expect(pairs(args, '--memory')).toEqual(['2048m']);
    expect(pairs(args, '--cpus')).toEqual(['2']);
    expect(pairs(args, '--mount')).toHaveLength(1);
    expect(pairs(args, '--mount')[0]).toContain('dst=/workspace');
    expect(pairs(args, '--mount')[0]).not.toContain('readonly');
  });

  it('never adds a forbidden escape hatch', () => {
    const args = buildCreateArgs(config, { binary: 'docker', kind: 'docker', globalArgs: [] }, null);
    for (const forbidden of [
      '--privileged',
      '--pid=host',
      '--ipc=host',
      '--network=host',
      '--userns=host',
      '--cap-add',
      '--device',
      '/var/run/docker.sock',
      '/run/containerd/containerd.sock',
    ]) {
      expect(args.join(' ')).not.toContain(forbidden);
    }
    // Only one bind mount, and its source is the operator's workspace — never
    // the host root or a parent directory.
    const mounts = pairs(args, '--mount');
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toContain(`src=${config.workspaceHostPath},`);
  });

  it('mounts the workspace read-only when writes are off', () => {
    const args = buildCreateArgs(
      { ...config, workspaceWritable: false },
      { binary: 'docker', kind: 'docker', globalArgs: [] },
      null,
    );
    expect(pairs(args, '--mount')[0]).toContain('readonly');
  });

  it('keeps proxy_only on network:none; the control pipe is its only exit', () => {
    const args = buildCreateArgs({ ...config, network: { mode: 'proxy_only', allowedDomains: ['example.com'], allowedPorts: [443] } }, { binary: 'docker', kind: 'docker', globalArgs: [] }, null);
    expect(pairs(args, '--network')).toEqual(['none']);
  });

  it('adds a read-only mask mount for credential files', () => {
    const args = buildCreateArgs(
      {
        ...config,
        maskedPaths: [
          { source: '/var/eunoia/masks/abc', target: '/workspace/.env' },
          { source: '/var/eunoia/masks/def', target: '/workspace/key.pem' },
        ],
      },
      { binary: 'docker', kind: 'docker', globalArgs: [] },
      null,
    );
    const mounts = pairs(args, '--mount');
    expect(mounts).toHaveLength(3);
    expect(mounts[1]).toContain('dst=/workspace/.env');
    expect(mounts[1]).toContain('readonly');
    expect(mounts[2]).toContain('dst=/workspace/key.pem');
    expect(mounts[2]).toContain('readonly');
  });

  it('refuses a mask target outside the workspace', () => {
    expect(() =>
      buildCreateArgs(
        { ...config, maskedPaths: [{ source: '/var/eunoia/masks/abc', target: '/etc/shadow' }] },
        { binary: 'docker', kind: 'docker', globalArgs: [] },
        null,
      ),
    ).toThrow(SandboxPolicyError);
  });

  it('cannot attach proxy_only to an old shared bridge', () => {
    const args = buildCreateArgs(
      { ...config, network: { mode: 'proxy_only', allowedDomains: ['example.com'], allowedPorts: [443] } },
      { binary: 'docker', kind: 'docker', globalArgs: [], egressNetwork: 'eunoia-egress' },
      null,
    );
    expect(pairs(args, '--network')).toEqual(['none']);
  });

  it('rejects a workspace path the mount syntax cannot quote', () => {
    expect(() =>
      buildCreateArgs(
        { ...config, workspaceHostPath: '/tmp/a,b' },
        { binary: 'docker', kind: 'docker', globalArgs: [] },
        null,
      ),
    ).toThrow(SandboxPolicyError);
  });

  it('maps runtime classes to client-specific handler names', () => {
    expect(runtimeNameFor('docker', 'gvisor')).toBe('runsc');
    expect(runtimeNameFor('docker', 'runc')).toBe('runc');
    expect(runtimeNameFor('docker', 'default')).toBeNull();
    expect(runtimeNameFor('nerdctl', 'gvisor')).toBe('io.containerd.runsc.v1');
    expect(runtimeNameFor('nerdctl', 'runc')).toBe('io.containerd.runc.v2');
  });

  it('refuses an argv that was weakened after generation', () => {
    expect(() => assertBaseline(['run', '--read-only', '--cap-drop', 'ALL', '--privileged'])).toThrow();
    expect(() => assertBaseline(['run', '--read-only', '--cap-add', 'SYS_ADMIN'])).toThrow();
    expect(() => assertBaseline(['run'])).toThrow();
  });
});

describe('exec argv', () => {
  it('passes the command as argv, not as shell source', () => {
    const args = buildExecArgs({
      containerName: sandboxContainerName('sbx_abc'),
      command: ['echo', 'hello; rm -rf /'],
      shell: false,
      cwd: '/workspace',
      workspaceRoot: '/workspace',
      executionId: 'exec_1',
      envFile: null,
    });
    const commandIndex = args.indexOf('eunoia');
    expect(commandIndex).toBeGreaterThan(0);
    expect(args.slice(commandIndex + 1)).toEqual([
      'exec_1',
      '/workspace',
      '/workspace',
      'echo',
      'hello; rm -rf /',
    ]);
  });

  it('runs a shell command through a single sh -c argument', () => {
    const args = buildExecArgs({
      containerName: 'eunoia-sbx-abc',
      command: ['npm test'],
      shell: true,
      cwd: '/workspace',
      workspaceRoot: '/workspace',
      executionId: 'exec_1',
      envFile: '/tmp/env',
    });
    const commandIndex = args.indexOf('eunoia');
    expect(args.slice(commandIndex + 1)).toEqual([
      'exec_1',
      '/workspace',
      '/workspace',
      '/bin/sh',
      '-c',
      'npm test',
    ]);
    expect(args).toContain('--env-file');
    expect(args).not.toContain('--env');
  });

  it('refuses an execution id that could escape the marker directory', () => {
    expect(() =>
      buildExecArgs({
        containerName: 'c',
        command: ['echo'],
        shell: false,
        cwd: '/workspace',
        workspaceRoot: '/workspace',
        executionId: '../../etc/passwd',
        envFile: null,
      }),
    ).toThrow(SandboxPolicyError);
  });

  it('starts the container in the task cwd and describes it to the launcher', () => {
    const args = buildExecArgs({
      containerName: 'eunoia-sbx-abc',
      command: ['pwd'],
      shell: false,
      cwd: '/workspace/project/src',
      workspaceRoot: '/workspace',
      executionId: 'exec_2',
      envFile: null,
    });
    const workdir = args.indexOf('--workdir');
    expect(args[workdir + 1]).toBe('/workspace/project/src');
    expect(args).toContain(WRAPPER);
    // The boundary is enforced inside the launcher, in the same process that
    // then runs the command (ADR 021 §4.4).
    expect(WRAPPER).toContain('cd -P "$dir"');
    expect(WRAPPER).toContain('eunoia:cwd_rejected:escape');
  });

  it('refuses a cwd outside the workspace or one containing a control character', () => {
    expect(() =>
      buildExecArgs({
        containerName: 'c',
        command: ['pwd'],
        shell: false,
        cwd: '/etc',
        workspaceRoot: '/workspace',
        executionId: 'exec_3',
        envFile: null,
      }),
    ).toThrow(SandboxPolicyError);
    expect(() =>
      buildExecArgs({
        containerName: 'c',
        command: ['pwd'],
        shell: false,
        cwd: 'relative/dir',
        workspaceRoot: '/workspace',
        executionId: 'exec_3',
        envFile: null,
      }),
    ).toThrow(SandboxPolicyError);
    expect(() =>
      buildExecArgs({
        containerName: 'c',
        command: ['pwd'],
        shell: false,
        cwd: '/workspace/a\nb',
        workspaceRoot: '/workspace',
        executionId: 'exec_3',
        envFile: null,
      }),
    ).toThrow(SandboxPolicyError);
  });
});
