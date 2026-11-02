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
import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODES,
  RISK_LEVELS,
  type PermissionMode,
  type RestrictedAllowlist,
  type RiskLevel,
} from './permissions/types.ts';

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

/**
 * Deployment-level permission settings (ADR 020 §3, §11).
 *
 * This is the top of the permission stack: the organization layer in the ADR's
 * vocabulary. Session, task and sandbox policies are persisted in
 * `permission_policies` and can only narrow this layer or request an extension
 * through auto-review / a human.
 */
export interface SandboxPermissionSettings {
  readonly organizationId: string;
  readonly projectId: string;
  /** The mode for scopes that have no override. */
  readonly mode: PermissionMode;
  /** Modes a trusted control-plane command may switch to. */
  readonly allowedModes: readonly PermissionMode[];
  readonly autoReview: {
    readonly enabled: boolean;
    readonly allowedRiskLevels: readonly RiskLevel[];
    readonly maxTtlMs: number;
  };
  readonly approval: {
    readonly allowed: boolean;
    readonly requireHumanForRiskLevels: readonly RiskLevel[];
    readonly maxTtlMs: number;
  };
  /** How long a pending permission request lives before it expires. */
  readonly requestTtlMs: number;
  /** How long a human approval decision is expected to take. */
  readonly approvalTtlMs: number;
  /** Identity recorded as the approver when a human decision lands. */
  readonly operatorId: string;
  readonly restricted: RestrictedAllowlist;
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
  readonly permission: SandboxPermissionSettings;
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

  const permission = permissionSettings(env, workspace.writes, workspace.commands);

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
    permission,
    heartbeatMs: intEnv(env, 'SANDBOX_HEARTBEAT_MS', 30_000, 1_000, 10 * 60_000),
    nonGvisorAcknowledged,
  };
}

function permissionSettings(
  env: NodeJS.ProcessEnv,
  writes: boolean,
  commands: boolean,
): SandboxPermissionSettings {
  const explicitMode = parsePermissionMode(env.SANDBOX_PERMISSION_MODE);
  // The deployment switch is the baseline: no writes and no commands *is*
  // read-only, and saying so is more honest than deriving it per request.
  const mode = explicitMode ?? defaultPermissionMode(writes, commands);

  const configuredAllowed = parseModeList(env.SANDBOX_PERMISSION_ALLOWED_MODES);
  const allowedModes = configuredAllowed.length > 0 ? configuredAllowed : [...PERMISSION_MODES];

  const autoReviewFlag = env.SANDBOX_AUTO_REVIEW?.trim().toLowerCase();
  const autoReviewEnabled =
    autoReviewFlag === undefined || autoReviewFlag === ''
      ? mode === 'auto'
      : !isFlagOff(autoReviewFlag);
  const autoApproveRisk = parseRiskList(env.SANDBOX_AUTO_APPROVE_RISK);
  const humanRisk = parseRiskList(env.SANDBOX_REQUIRE_HUMAN_RISK);

  const restricted: RestrictedAllowlist = {
    allowedTools: listEnv(env.SANDBOX_RESTRICTED_TOOLS).length > 0
      ? listEnv(env.SANDBOX_RESTRICTED_TOOLS)
      : ['read', 'list_dir', 'glob', 'grep', 'bash'],
    filesystem: {
      read: listEnv(env.SANDBOX_RESTRICTED_READ).length > 0
        ? listEnv(env.SANDBOX_RESTRICTED_READ)
        : ['/workspace'],
      write: listEnv(env.SANDBOX_RESTRICTED_WRITE),
    },
    network: {
      mode: parseNetworkMode(env.SANDBOX_RESTRICTED_NETWORK_MODE),
      allowedDomains: listEnv(env.SANDBOX_RESTRICTED_DOMAINS),
      allowedPorts: listEnv(env.SANDBOX_RESTRICTED_PORTS)
        .map((entry) => Number.parseInt(entry, 10))
        .filter((port) => Number.isFinite(port) && port > 0 && port <= 65_535),
    },
  };

  return {
    organizationId: env.SANDBOX_ORGANIZATION_ID?.trim() || 'default',
    projectId: env.SANDBOX_PROJECT_ID?.trim() || 'default',
    mode,
    allowedModes,
    autoReview: {
      enabled: autoReviewEnabled,
      allowedRiskLevels: autoApproveRisk.length > 0 ? autoApproveRisk : ['low', 'medium'],
      maxTtlMs: intEnv(env, 'SANDBOX_AUTO_REVIEW_TTL_MS', 10 * 60_000, 1_000, 24 * 60 * 60_000),
    },
    approval: {
      allowed: true,
      requireHumanForRiskLevels: humanRisk.length > 0 ? humanRisk : ['high', 'critical'],
      maxTtlMs: intEnv(env, 'SANDBOX_APPROVAL_TTL_MS', 15 * 60_000, 1_000, 24 * 60 * 60_000),
    },
    requestTtlMs: intEnv(env, 'SANDBOX_PERMISSION_REQUEST_TTL_MS', 30 * 60_000, 1_000, 24 * 60 * 60_000),
    approvalTtlMs: intEnv(env, 'SANDBOX_APPROVAL_TTL_MS', 15 * 60_000, 1_000, 24 * 60 * 60_000),
    operatorId: env.SANDBOX_OPERATOR_ID?.trim() || 'operator',
    restricted,
  };
}

/**
 * Without an explicit mode, the deployment's write/command switches describe
 * the baseline:
 *
 *   writes + commands → auto (ordinary work runs; extensions go to auto-review)
 *   one of them       → on-request (the missing capability needs a decision)
 *   neither           → read-only
 */
function defaultPermissionMode(writes: boolean, commands: boolean): PermissionMode {
  if (writes && commands) return DEFAULT_PERMISSION_MODE;
  if (!writes && !commands) return 'read-only';
  return 'on-request';
}

function parsePermissionMode(value: string | undefined): PermissionMode | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if ((PERMISSION_MODES as readonly string[]).includes(normalized)) {
    return normalized as PermissionMode;
  }
  throw new SandboxError(
    'invalid_input',
    `unsupported SANDBOX_PERMISSION_MODE: ${normalized} (expected ${PERMISSION_MODES.join(', ')})`,
  );
}

function parseModeList(value: string | undefined): PermissionMode[] {
  const modes: PermissionMode[] = [];
  for (const entry of listEnv(value)) {
    const normalized = entry.toLowerCase();
    if (!(PERMISSION_MODES as readonly string[]).includes(normalized)) {
      throw new SandboxError(
        'invalid_input',
        `unsupported permission mode in SANDBOX_PERMISSION_ALLOWED_MODES: ${entry}`,
      );
    }
    modes.push(normalized as PermissionMode);
  }
  return modes;
}

function parseRiskList(value: string | undefined): RiskLevel[] {
  const levels: RiskLevel[] = [];
  for (const entry of listEnv(value)) {
    const normalized = entry.toLowerCase();
    if (!RISK_LEVELS.includes(normalized as RiskLevel)) {
      throw new SandboxError(
        'invalid_input',
        `unsupported risk level in permission settings: ${entry} (expected ${RISK_LEVELS.join(', ')})`,
      );
    }
    levels.push(normalized as RiskLevel);
  }
  return levels;
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
    permission_mode: settings.permission.mode,
    permission_allowed_modes: settings.permission.allowedModes,
    auto_review: settings.permission.autoReview.enabled,
    auto_approve_risk: settings.permission.autoReview.allowedRiskLevels,
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
