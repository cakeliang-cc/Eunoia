/**
 * The container CLI's argv, as pure functions.
 *
 * This is the most security-sensitive module in the platform, and it is pure on
 * purpose: every flag that could weaken isolation is asserted against a fixed
 * baseline *before* a process is spawned, and a unit test can inspect the exact
 * argv a sandbox would get without Docker installed.
 *
 * The baseline (ADR §3.2):
 *
 *   - non-root user;
 *   - read-only root filesystem;
 *   - one writable bind mount, the task workspace, mounted at `/workspace`;
 *   - no host PID/IPC/network namespaces, no privileged mode, no Docker or
 *     containerd socket, no arbitrary mount;
 *   - all Linux capabilities dropped, `no-new-privileges`;
 *   - cgroups limits for CPU, memory and PIDs;
 *   - a tmpfs for `/tmp` (the rootfs is read-only);
 *   - network `none` unless an operator configured an egress network.
 *
 * The image is always a digest. `--pull=never` is part of the baseline: recovery
 * must never fetch an unverified "latest" because a tag moved.
 */

import {
  SANDBOX_GID,
  SANDBOX_UID,
  WORKSPACE_MOUNT_PATH,
  type RuntimeSandboxConfig,
} from '../types.ts';
import { SandboxPolicyError } from '../errors.ts';

export interface ContainerCliOptions {
  /** `docker` or `nerdctl`. */
  readonly binary: string;
  readonly kind: 'docker' | 'nerdctl';
  /** Global arguments before the subcommand (`nerdctl --namespace eunoia`). */
  readonly globalArgs: readonly string[];
  /** Optional daemon-level seccomp profile path (operator configuration). */
  readonly seccompProfile?: string | null;
  /** Optional AppArmor profile name (Linux only). */
  readonly apparmorProfile?: string | null;
  /** Network name used when the policy is `proxy_only`. */
  readonly egressNetwork?: string | null;
}

const FORBIDDEN_ARG = /^(--privileged|--pid=host|--ipc=host|--userns=host|--network=host|--net=host|--volume=\/|--mount=.*source=\/[,:])/;

/** Flags that must never appear in a generated argv, at any position. */
const FORBIDDEN_FLAGS = new Set([
  '--privileged',
  '--pid=host',
  '--ipc=host',
  '--userns=host',
  '--network=host',
  '--net=host',
  '--device',
  '--cap-add',
  '--runtime=host',
]);

/** Runtime names per CLI for the requested isolation class. */
export function runtimeNameFor(
  cli: 'docker' | 'nerdctl',
  runtimeClass: RuntimeSandboxConfig['runtimeClass'],
): string | null {
  if (runtimeClass === 'default') return null;
  if (runtimeClass === 'gvisor') return cli === 'docker' ? 'runsc' : 'io.containerd.runsc.v1';
  return cli === 'docker' ? 'runc' : 'io.containerd.runc.v2';
}

export function sandboxContainerName(sandboxId: string): string {
  return `eunoia-sbx-${sandboxId.toLowerCase()}`;
}

/** Validate operator-supplied names once, not at every call. */
export function assertSafeName(label: string, value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) {
    throw new SandboxPolicyError(`${label} must match [A-Za-z0-9][A-Za-z0-9_.-]*: ${JSON.stringify(value)}`);
  }
}

export function assertSafeHostPath(path: string): void {
  if (!path.startsWith('/')) throw new SandboxPolicyError('workspace path must be absolute');
  if (path.includes(',') || path.includes('\n') || path.includes('\0')) {
    throw new SandboxPolicyError('workspace path contains a character the mount syntax cannot quote');
  }
}

/**
 * Build `docker run` / `nerdctl run` for one sandbox.
 *
 * `--env-file` is passed by the caller as a path, not values: argv is readable
 * from `ps`, and a brokered credential in argv is a leaked credential.
 */
export function buildCreateArgs(
  config: RuntimeSandboxConfig,
  cli: ContainerCliOptions,
  envFile: string | null,
): string[] {
  assertSafeHostPath(config.workspaceHostPath);
  const args = ['run', '-d', '--name', sandboxContainerName(config.sandboxId)];

  args.push('--label', `eunoia.sandbox=${config.sandboxId}`);
  args.push('--label', `eunoia.task=${config.taskId}`);
  args.push('--label', 'eunoia.managed=true');

  // Isolation baseline -------------------------------------------------------
  args.push('--read-only');
  args.push('--cap-drop', 'ALL');
  args.push('--security-opt', 'no-new-privileges:true');
  args.push('--user', `${SANDBOX_UID}:${SANDBOX_GID}`);
  args.push('--workdir', WORKSPACE_MOUNT_PATH);
  // PID and IPC namespaces are private by default; passing `--pid=host` or
  // `--ipc=host` is forbidden by `assertBaseline`, so the absence of a flag is
  // the baseline rather than a weaker choice.
  // nerdctl's --init expects an init binary in the image; Docker supplies its
  // own. Dropping it for nerdctl is safer than making every base image carry
  // tini, and the process bound is still enforced by --pids-limit.
  if (cli.kind === 'docker') args.push('--init');
  args.push('--pull', 'never');
  if (cli.seccompProfile) {
    args.push('--security-opt', `seccomp=${cli.seccompProfile}`);
  }
  if (cli.apparmorProfile) {
    args.push('--security-opt', `apparmor=${cli.apparmorProfile}`);
  }

  // Resources ---------------------------------------------------------------
  args.push('--pids-limit', String(config.resources.maxProcesses));
  args.push('--memory', `${config.resources.memoryLimitMB}m`);
  args.push('--memory-swap', `${config.resources.memoryLimitMB}m`);
  args.push('--cpus', String(config.resources.cpuQuota));
  // `--pids-limit` above is the process bound. `--ulimit nproc` is deliberately
  // not set: on Docker Desktop it is applied to the container init process and
  // makes `/sbin/docker-init` fail with EAGAIN before the command starts.
  args.push('--ulimit', 'nofile=1024:1024');
  args.push('--tmpfs', `/tmp:rw,nosuid,nodev,size=${tmpfsSize(config.resources.memoryLimitMB)}`);

  // Network -----------------------------------------------------------------
  if (config.network.mode === 'none') {
    args.push('--network', 'none');
  } else {
    const network = cli.egressNetwork;
    if (!network) {
      throw new SandboxPolicyError(
        'network mode proxy_only requires an operator-configured egress network (SANDBOX_EGRESS_NETWORK)',
      );
    }
    assertSafeName('egress network', network);
    args.push('--network', network);
  }

  // The only mount. One bind, one target, and no mount supplied by a caller.
  args.push(
    '--mount',
    `type=bind,src=${config.workspaceHostPath},dst=${WORKSPACE_MOUNT_PATH}${config.workspaceWritable ? '' : ',readonly'}`,
  );

  for (const mask of config.maskedPaths ?? []) {
    assertSafeHostPath(mask.source);
    if (!mask.target.startsWith(`${WORKSPACE_MOUNT_PATH}/`)) {
      throw new SandboxPolicyError(`mask target must be inside ${WORKSPACE_MOUNT_PATH}`);
    }
    args.push('--mount', `type=bind,src=${mask.source},dst=${mask.target},readonly`);
  }

  const runtimeName = runtimeNameFor(cli.kind, config.runtimeClass);
  if (runtimeName) args.push('--runtime', runtimeName);

  if (envFile) args.push('--env-file', envFile);

  args.push(config.imageDigest);
  // A shell is not required to start, but `sleep` must exist in every base image
  // the platform accepts. `2147483647` is the portable "forever".
  args.push('sleep', '2147483647');

  assertBaseline(args);
  return args;
}

/**
 * `docker exec` argv for one execution.
 *
 * The wrapper writes the exit status to a tmpfs marker before exiting. That is
 * how recovery answers "did this finish?" after the Gateway crashed: the
 * container may still exist, and the marker is the only durable witness inside
 * it.
 */
export function buildExecArgs(input: {
  readonly containerName: string;
  readonly command: readonly string[];
  readonly shell: boolean;
  readonly cwd: string;
  readonly executionId: string;
  readonly envFile: string | null;
  readonly user?: string;
}): string[] {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(input.executionId)) {
    throw new SandboxPolicyError('execution id contains a character unsafe for a marker path');
  }
  const args = ['exec', '--user', input.user ?? `${SANDBOX_UID}:${SANDBOX_GID}`];
  args.push('--workdir', input.cwd);
  if (input.envFile) args.push('--env-file', input.envFile);
  args.push(input.containerName, '/bin/sh', '-c', WRAPPER, 'eunoia', ...wrapperArgv(input));

  assertNoForbiddenExec(args);
  return args;
}

/** The fixed wrapper. `$1` is the execution id; the command follows. */
export const WRAPPER = [
  'id="$1"',
  'shift',
  'mkdir -p /tmp/.eunoia 2>/dev/null || true',
  'printf %s "$$" > /tmp/.eunoia/"$id".pid 2>/dev/null || true',
  '"$@"',
  'code=$?',
  'printf %s "$code" > /tmp/.eunoia/"$id".status.tmp 2>/dev/null || true',
  'mv /tmp/.eunoia/"$id".status.tmp /tmp/.eunoia/"$id".status 2>/dev/null || true',
  'exit $code',
].join('\n');

/**
 * The execution id arrives as the shell's `$1`; the command follows it and is
 * run as separate argv elements so a model-authored argument is never merged
 * into the wrapper's own shell source.
 */
function wrapperArgv(input: {
  readonly executionId: string;
  readonly command: readonly string[];
  readonly shell: boolean;
}): string[] {
  const argv = input.shell ? ['/bin/sh', '-c', input.command[0] ?? ''] : [...input.command];
  return [input.executionId, ...argv];
}

/** Read one marker through the same wrapper-less path. */
export function buildReadMarkerArgs(containerName: string, executionId: string): string[] {
  return [
    'exec',
    '--user',
    `${SANDBOX_UID}:${SANDBOX_GID}`,
    containerName,
    '/bin/sh',
    '-c',
    `cat /tmp/.eunoia/${executionId}.status 2>/dev/null || true`,
  ];
}

export function buildInspectArgs(containerName: string): string[] {
  return ['inspect', '--format', '{{json .State}}', containerName];
}

export function buildInterruptArgs(containerName: string): string[] {
  return ['kill', containerName];
}

export function buildDestroyArgs(containerName: string): string[] {
  return ['rm', '-f', containerName];
}

export function buildStartArgs(containerName: string): string[] {
  return ['start', containerName];
}

export function buildProbeArgs(kind: 'docker' | 'nerdctl'): string[] {
  return kind === 'docker'
    ? ['info', '--format', '{{json .Runtimes}}']
    : ['info', '--format', '{{json .}}'];
}

export function tmpfsSize(memoryLimitMB: number): string {
  const size = Math.min(Math.max(Math.floor(memoryLimitMB / 4), 16), 1_024);
  return `${size}m`;
}

/**
 * A last check before spawning. If any of these fire, the caller has a bug and
 * the sandbox must not exist.
 */
export function assertBaseline(args: readonly string[]): void {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (FORBIDDEN_ARG.test(arg) || FORBIDDEN_FLAGS.has(arg)) {
      throw new SandboxPolicyError(`runtime configuration weakens the sandbox baseline: ${arg}`);
    }
    if (arg === '--cap-add' || arg === '--privileged' || arg === '--device') {
      throw new SandboxPolicyError(`runtime configuration weakens the sandbox baseline: ${arg}`);
    }
  }
  if (!args.includes('--read-only')) throw new SandboxPolicyError('missing --read-only');
  // Every mount must be the workspace or a masked credential file inside it.
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--mount') continue;
    const value = args[index + 1] ?? '';
    const target = /dst=([^,]+)/.exec(value)?.[1] ?? '';
    if (target !== WORKSPACE_MOUNT_PATH && !target.startsWith(`${WORKSPACE_MOUNT_PATH}/`)) {
      throw new SandboxPolicyError(`mount target is outside the workspace: ${target}`);
    }
    if (target === WORKSPACE_MOUNT_PATH && !value.includes('type=bind')) {
      throw new SandboxPolicyError('workspace mount must be a bind mount');
    }
  }
  if (!args.includes('--cap-drop')) throw new SandboxPolicyError('missing --cap-drop ALL');
  if (!hasPair(args, '--cap-drop', 'ALL')) throw new SandboxPolicyError('capabilities are not dropped');
  if (!hasPair(args, '--security-opt', 'no-new-privileges:true')) {
    throw new SandboxPolicyError('missing no-new-privileges');
  }
}

function assertNoForbiddenExec(args: readonly string[]): void {
  for (const arg of args) {
    if (arg === '--privileged' || arg === '--detach-keys' || arg === '--env') {
      throw new SandboxPolicyError(`exec argument weakens the sandbox baseline: ${arg}`);
    }
  }
}

function hasPair(args: readonly string[], key: string, value: string): boolean {
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === key && args[index + 1] === value) return true;
  }
  return false;
}
