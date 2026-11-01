/**
 * Process configuration for the sandbox platform.
 *
 * Everything here is operator input, never a request field. The ADR's central
 * configuration rule is that an agent cannot choose its image, its runtime, its
 * mount, its network or its resource ceiling; this module is where the only
 * legal values come from.
 *
 * Two defaults are deliberately strict:
 *
 *   - the image must be pinned to a `sha256:` digest;
 *   - the runtime class defaults to `gvisor`, and choosing `runc`/`default`
 *     requires `SANDBOX_ALLOW_NON_GVISOR=1` *and* says so in the logs and in
 *     `/health`. There is no silent downgrade.
 */

import { join, resolve } from 'node:path';
import { envFlag, workspaceConfig } from '../config.ts';
import { SandboxError } from './errors.ts';
import {
  RESOURCE_PROFILES,
  SANDBOX_POLICY_VERSION,
  type ResourceLimits,
  type SandboxLimits,
} from './types.ts';

export interface SandboxRuntimeSettings {
  readonly kind: 'docker' | 'nerdctl';
  readonly binary: string;
  readonly globalArgs: readonly string[];
  readonly runtimeClass: 'gvisor' | 'runc' | 'default';
  readonly requireGvisor: boolean;
  readonly seccompProfile: string | null;
  readonly apparmorProfile: string | null;
  readonly egressNetwork: string | null;
}

export interface SandboxWorkspaceSettings {
  readonly storageRoot: string;
  readonly sourceRoot: string | null;
  readonly mode: 'bind' | 'copy';
  readonly ignore: readonly string[];
  readonly allowSensitive: boolean;
  readonly maxFileBytes: number;
}

export interface SandboxNetworkSettings {
  readonly mode: 'none' | 'proxy_only';
  readonly allowedDomains: readonly string[];
  readonly allowedPorts: readonly number[];
  readonly proxyUrl: string | null;
}

export interface SandboxSettings {
  readonly enabled: boolean;
  readonly imageDigest: string;
  readonly policyVersion: string;
  readonly runtime: SandboxRuntimeSettings;
  readonly workspace: SandboxWorkspaceSettings;
  readonly network: SandboxNetworkSettings;
  readonly resources: ResourceLimits;
  readonly limits: SandboxLimits;
  readonly allowWrites: boolean;
  readonly allowCommands: boolean;
  readonly deniedTools: readonly string[];
  readonly heartbeatMs: number;
  /** True when the operator explicitly accepted a non-gVisor runtime. */
  readonly nonGvisorAcknowledged: boolean;
}

const MAX_CPU = 8;
const MAX_MEMORY_MB = 16_384;
const MAX_TIMEOUT_MS = 2 * 60 * 60_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Read a bounded integer from the environment, falling back on a bad value. */
function intEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function listEnv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Parse the sandbox configuration.
 *
 * Returns null when the platform is not enabled at all. Throws when it *is*
 * enabled but misconfigured: a half-configured sandbox that silently runs
 * commands on the host is exactly the failure mode the ADR forbids.
 */
export function sandboxSettings(env: NodeJS.ProcessEnv = process.env): SandboxSettings | null {
  const workspace = workspaceConfig(env);
  const explicitlyEnabled = envFlag(env.SANDBOX_ENABLED);
  const explicitlyDisabled = isFlagOff(env.SANDBOX_ENABLED);
  if (explicitlyDisabled) return null;
  const enabled = explicitlyEnabled || workspace !== null;
  if (!enabled) return null;

  if (!workspace) {
    throw new SandboxError(
      'invalid_input',
      'SANDBOX_ENABLED is set but WORKSPACE_ROOT is not; the sandbox needs a workspace to mount',
    );
  }

  const imageDigest = env.SANDBOX_IMAGE_DIGEST?.trim() ?? '';
  if (!/^sha256:[a-f0-9]{64}$/i.test(imageDigest)) {
    throw new SandboxError(
      'invalid_input',
      'SANDBOX_IMAGE_DIGEST must be an immutable digest (sha256:<64 hex>); ' +
        'run `docker image inspect --format \'{{.Id}}\' <image>` to get one',
    );
  }

  const runtimeClass = parseRuntimeClass(env.SANDBOX_RUNTIME_CLASS);
  const nonGvisorAcknowledged = envFlag(env.SANDBOX_ALLOW_NON_GVISOR);
  if (runtimeClass !== 'gvisor' && !nonGvisorAcknowledged) {
    throw new SandboxError(
      'runtime_unavailable',
      `SANDBOX_RUNTIME_CLASS=${runtimeClass} is weaker than the default gVisor baseline; ` +
        'set SANDBOX_ALLOW_NON_GVISOR=1 to acknowledge it, or install gVisor/runsc',
    );
  }

  const kind = (env.SANDBOX_RUNTIME_CLIENT?.trim().toLowerCase() ?? 'docker') as 'docker' | 'nerdctl';
  if (kind !== 'docker' && kind !== 'nerdctl') {
    throw new SandboxError('invalid_input', `unsupported SANDBOX_RUNTIME_CLIENT: ${kind}`);
  }
  const globalArgs =
    kind === 'nerdctl'
      ? [
          ...(env.SANDBOX_NERDCTL_ADDRESS?.trim()
            ? ['--address', env.SANDBOX_NERDCTL_ADDRESS.trim()]
            : []),
          '--namespace',
          env.SANDBOX_NERDCTL_NAMESPACE?.trim() || 'eunoia',
        ]
      : [];

  const profile = RESOURCE_PROFILES[env.SANDBOX_RESOURCE_PROFILE?.trim() ?? 'default'] ??
    RESOURCE_PROFILES.default!;
  const resources: ResourceLimits = {
    cpuQuota: intEnv(env, 'SANDBOX_CPU', profile.limits.cpuQuota, 1, MAX_CPU),
    memoryLimitMB: intEnv(env, 'SANDBOX_MEMORY_MB', profile.limits.memoryLimitMB, 128, MAX_MEMORY_MB),
    diskLimitMB: intEnv(env, 'SANDBOX_DISK_MB', profile.limits.diskLimitMB, 256, 102_400),
    executionTimeoutMs: intEnv(
      env,
      'SANDBOX_TIMEOUT_MS',
      profile.limits.executionTimeoutMs,
      1_000,
      MAX_TIMEOUT_MS,
    ),
    maxProcesses: intEnv(env, 'SANDBOX_PIDS', profile.limits.maxProcesses, 8, 8_192),
    outputLimitBytes: intEnv(
      env,
      'SANDBOX_OUTPUT_LIMIT_BYTES',
      profile.limits.outputLimitBytes,
      1_024,
      MAX_OUTPUT_BYTES,
    ),
    idleTimeoutMs: intEnv(env, 'SANDBOX_IDLE_TIMEOUT_MS', profile.limits.idleTimeoutMs, 60_000, 24 * 60 * 60_000),
  };

  const mode = parseNetworkMode(env.SANDBOX_NETWORK_MODE);
  const egressNetwork = env.SANDBOX_EGRESS_NETWORK?.trim() || null;
  if (mode === 'proxy_only' && !egressNetwork) {
    throw new SandboxError(
      'invalid_input',
      'SANDBOX_NETWORK_MODE=proxy_only requires SANDBOX_EGRESS_NETWORK to name the operator-created egress network',
    );
  }
  const proxyUrl = env.SANDBOX_PROXY_URL?.trim() || null;
  if (mode === 'proxy_only' && !proxyUrl) {
    throw new SandboxError(
      'invalid_input',
      'SANDBOX_NETWORK_MODE=proxy_only requires SANDBOX_PROXY_URL (run `npm run sandbox:proxy` and point it at the host address the sandbox network can reach)',
    );
  }

  const workspaceMode = (env.SANDBOX_WORKSPACE_MODE?.trim().toLowerCase() ?? 'bind') as 'bind' | 'copy';
  if (workspaceMode !== 'bind' && workspaceMode !== 'copy') {
    throw new SandboxError('invalid_input', `unsupported SANDBOX_WORKSPACE_MODE: ${workspaceMode}`);
  }
  const storageRoot = resolve(
    env.SANDBOX_WORKSPACE_ROOT?.trim() || join(process.cwd(), 'data', 'sandboxes'),
  );

  return {
    enabled: true,
    imageDigest,
    policyVersion: SANDBOX_POLICY_VERSION,
    runtime: {
      kind,
      binary: env.SANDBOX_RUNTIME_BINARY?.trim() || kind,
      globalArgs,
      runtimeClass,
      requireGvisor: runtimeClass === 'gvisor',
      seccompProfile: env.SANDBOX_SECCOMP_PROFILE?.trim() || null,
      apparmorProfile: env.SANDBOX_APPARMOR_PROFILE?.trim() || null,
      egressNetwork,
    },
    workspace: {
      storageRoot,
      sourceRoot: workspace.root,
      mode: workspaceMode,
      ignore: workspace.ignore,
      allowSensitive: workspace.allowSensitive,
      maxFileBytes: intEnv(env, 'SANDBOX_MAX_FILE_BYTES', 2 * 1024 * 1024, 1_024, 64 * 1024 * 1024),
    },
    network: {
      mode,
      allowedDomains: listEnv(env.SANDBOX_ALLOWED_DOMAINS),
      allowedPorts: listEnv(env.SANDBOX_ALLOWED_PORTS).map((entry) => Number.parseInt(entry, 10)).filter(
        (port) => Number.isFinite(port) && port > 0 && port <= 65_535,
      ),
      proxyUrl,
    },
    resources,
    limits: {
      maxConcurrentGlobal: intEnv(env, 'SANDBOX_MAX_CONCURRENT_GLOBAL', 4, 1, 32),
      maxConcurrentPerUser: intEnv(env, 'SANDBOX_MAX_CONCURRENT_USER', 2, 1, 16),
      maxConcurrentPerTask: intEnv(env, 'SANDBOX_MAX_CONCURRENT_TASK', 1, 1, 4),
      maxExecutionTimeoutMs: resources.executionTimeoutMs,
      maxOutputBytes: resources.outputLimitBytes,
    },
    allowWrites: workspace.writes,
    allowCommands: workspace.commands,
    deniedTools: listEnv(env.SANDBOX_DENIED_TOOLS),
    heartbeatMs: intEnv(env, 'SANDBOX_HEARTBEAT_MS', 30_000, 1_000, 10 * 60_000),
    nonGvisorAcknowledged,
  };
}

/** A settings-shaped summary safe to log and to show in `/health`. */
export function describeSandboxSettings(settings: SandboxSettings): Record<string, unknown> {
  return {
    enabled: settings.enabled,
    image: settings.imageDigest,
    runtime_client: settings.runtime.kind,
    runtime_class: settings.runtime.runtimeClass,
    gvisor_required: settings.runtime.requireGvisor,
    non_gvisor_acknowledged: settings.nonGvisorAcknowledged,
    workspace_mode: settings.workspace.mode,
    workspace_root: settings.workspace.sourceRoot,
    workspace_storage: settings.workspace.storageRoot,
    network_mode: settings.network.mode,
    network_domains: settings.network.allowedDomains,
    writes: settings.allowWrites,
    commands: settings.allowCommands,
    cpu: settings.resources.cpuQuota,
    memory_mb: settings.resources.memoryLimitMB,
    timeout_ms: settings.resources.executionTimeoutMs,
    output_limit_bytes: settings.resources.outputLimitBytes,
  };
}

function parseRuntimeClass(value: string | undefined): 'gvisor' | 'runc' | 'default' {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'runc' || normalized === 'default') return normalized;
  return 'gvisor';
}

function parseNetworkMode(value: string | undefined): 'none' | 'proxy_only' {
  return value?.trim().toLowerCase() === 'proxy_only' ? 'proxy_only' : 'none';
}

function isFlagOff(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off';
}
