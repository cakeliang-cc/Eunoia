/**
 * Policy evaluation and compilation.
 *
 * Two separate jobs live here because they have different failure modes:
 *
 *   - **Evaluation** answers "may this request run?" and is pure: same policy,
 *     same request, same answer, no container and no filesystem. It is the layer
 *     a unit test can prove.
 *   - **Compilation** turns a business policy into the structured config the
 *     Runtime Manager accepts. It is the only place that decides what a sandbox
 *     *is*, and it refuses to produce a config that weakens the baseline.
 *
 * The stack, from weakest to strongest (ADR §4.3):
 *
 *     System Deny > Tenant Policy > Task Policy > Approval Grant > Runtime
 *
 * The effective permission is the intersection. An approval can lift an
 * `APPROVAL_REQUIRED`, never a `DENY`; a task policy can narrow the tenant
 * policy, never widen it.
 */

import { isAbsolute, posix } from 'node:path';
import {
  RESOURCE_PROFILES,
  SANDBOX_POLICY_VERSION,
  SYSTEM_DENY_COMMAND_PATTERNS,
  SYSTEM_DENY_PATHS,
  WORKSPACE_MOUNT_PATH,
  type ApprovalGrant,
  type PolicyDecision,
  type PolicyEvaluation,
  type ResourceLimits,
  type RuntimeSandboxConfig,
  type SandboxPolicy,
} from './types.ts';
import {
  SandboxApprovalRequiredError,
  SandboxPolicyError,
  SandboxRuntimeUnavailableError,
} from './errors.ts';

export type PolicyAction = 'fs.read' | 'fs.write' | 'fs.list' | 'process.exec' | 'network.connect' | 'tool';

export interface PolicyRequest {
  readonly action: PolicyAction;
  /** Container-absolute paths, domains or tool names, depending on the action. */
  readonly resources: readonly string[];
  readonly toolName?: string;
  /** The command text, for `process.exec`. */
  readonly command?: string;
  readonly cwd?: string;
}

export interface PermissionSettings {
  /** Process-level switch: writes are still approval-gated when false. */
  readonly allowWorkspaceWrites: boolean;
  /** Process-level switch: commands are still approval-gated when false. */
  readonly allowCommands: boolean;
}

// --------------------------------------------------------------- normalising ---

/**
 * Canonicalise a container path without touching the filesystem.
 *
 * The result is what the policy reasons about. `/workspace/../etc/passwd`
 * becomes `/etc/passwd`, which no filesystem allow-list covers, so the string
 * prefix mistake the ADR warns about cannot happen here.
 */
export function normalizeContainerPath(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new SandboxPolicyError('resource path must not be empty');
  }
  if (input.includes('\0') || /[\r\n]/.test(input)) {
    throw new SandboxPolicyError('resource path contains a forbidden control character');
  }
  if (!isAbsolute(input)) {
    throw new SandboxPolicyError(`resource path must be absolute, got ${JSON.stringify(input)}`);
  }
  return posix.normalize(input);
}

function underAny(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function narrowPrefixes(wide: readonly string[], narrow: readonly string[]): string[] {
  return wide.filter((entry) => underAny(entry, narrow) || narrow.some((other) => underAny(other, [entry])));
}

function intersectStrings(a: readonly string[], b: readonly string[]): string[] {
  if (a.length === 0) return [...b];
  if (b.length === 0) return [...a];
  return a.filter((entry) => b.includes(entry));
}

// --------------------------------------------------------------- policies ----

/** The floor. No caller can widen it. */
export function systemPolicy(): SandboxPolicy {
  return {
    policyVersion: SANDBOX_POLICY_VERSION,
    filesystem: {
      read: [WORKSPACE_MOUNT_PATH],
      write: [WORKSPACE_MOUNT_PATH],
      deny: [...SYSTEM_DENY_PATHS],
    },
    network: { mode: 'none', allowedDomains: [], allowedPorts: [] },
    process: { maxProcesses: 512, allowShell: false },
    resources: { ...RESOURCE_PROFILES.default!.limits },
    tools: { allowedTools: [], deniedTools: [] },
    runtime: { class: 'gvisor', requireGvisor: false },
  };
}

/**
 * The tenant layer.
 *
 * This product is single-tenant, so the tenant policy is the deployment's
 * configured floor: it can only narrow the system policy (for example, disable
 * the shell entirely for an instance that should never run commands).
 */
export interface TenantPolicyOptions {
  readonly networkMode?: 'none' | 'proxy_only';
  readonly allowedDomains?: readonly string[];
  readonly allowedPorts?: readonly number[];
  readonly maxProcesses?: number;
  readonly resources?: Partial<ResourceLimits>;
  readonly runtimeClass?: 'gvisor' | 'runc' | 'default';
  readonly requireGvisor?: boolean;
  readonly deniedTools?: readonly string[];
}

export function tenantPolicy(options: TenantPolicyOptions = {}): SandboxPolicy {
  const base = systemPolicy();
  return {
    policyVersion: SANDBOX_POLICY_VERSION,
    filesystem: {
      read: ['/workspace'],
      write: ['/workspace'],
      deny: [...SYSTEM_DENY_PATHS],
    },
    network: {
      mode: options.networkMode ?? 'none',
      allowedDomains: [...(options.allowedDomains ?? [])],
      allowedPorts: [...(options.allowedPorts ?? [])],
    },
    process: {
      maxProcesses: Math.min(options.maxProcesses ?? base.process.maxProcesses, base.process.maxProcesses),
      allowShell: true,
    },
    resources: { ...base.resources, ...options.resources },
    tools: { allowedTools: [], deniedTools: [...(options.deniedTools ?? [])] },
    runtime: {
      class: options.runtimeClass ?? 'gvisor',
      requireGvisor: options.requireGvisor ?? false,
    },
  };
}

export interface TaskPolicyOptions {
  readonly resourcesProfile?: string;
  readonly resources?: Partial<ResourceLimits>;
  readonly networkMode?: 'none' | 'proxy_only';
  readonly allowedDomains?: readonly string[];
  readonly allowedPorts?: readonly number[];
  readonly deniedTools?: readonly string[];
  readonly runtimeClass?: 'gvisor' | 'runc' | 'default';
  readonly requireGvisor?: boolean;
}

/**
 * The task layer: a workspace-shaped policy.
 *
 * Writes are part of the structural allow-list even when the process flag is
 * off. The flag is applied by `PermissionManager` as `APPROVAL_REQUIRED`, which
 * is what makes "enable writes for this one task, for ten minutes" expressible
 * without editing the task policy.
 */
export function taskPolicy(options: TaskPolicyOptions = {}): SandboxPolicy {
  const profile = RESOURCE_PROFILES[options.resourcesProfile ?? 'default'] ?? RESOURCE_PROFILES.default!;
  const base = tenantPolicy({
    ...(options.networkMode ? { networkMode: options.networkMode } : {}),
    ...(options.allowedDomains ? { allowedDomains: options.allowedDomains } : {}),
    ...(options.allowedPorts ? { allowedPorts: options.allowedPorts } : {}),
    ...(options.deniedTools ? { deniedTools: options.deniedTools } : {}),
    ...(options.runtimeClass ? { runtimeClass: options.runtimeClass } : {}),
    ...(options.requireGvisor === undefined ? {} : { requireGvisor: options.requireGvisor }),
  });
  return {
    ...base,
    resources: { ...profile.limits, ...options.resources },
    process: { ...base.process, maxProcesses: options.resources?.maxProcesses ?? profile.limits.maxProcesses },
  };
}

/**
 * The intersection of two policies.
 *
 * Used when a tenant policy and a task policy both apply. The result cannot allow
 * anything either input denies: read/write prefixes narrow, deny lists union,
 * network domains and ports intersect, limits take the minimum.
 */
export function intersectPolicies(wide: SandboxPolicy, narrow: SandboxPolicy): SandboxPolicy {
  return {
    policyVersion: SANDBOX_POLICY_VERSION,
    filesystem: {
      read: narrowPrefixes(wide.filesystem.read, narrow.filesystem.read),
      write: narrowPrefixes(wide.filesystem.write, narrow.filesystem.write),
      deny: [...new Set([...wide.filesystem.deny, ...narrow.filesystem.deny])],
    },
    network: {
      mode: wide.network.mode === 'none' || narrow.network.mode === 'none' ? 'none' : 'proxy_only',
      allowedDomains: intersectStrings(wide.network.allowedDomains, narrow.network.allowedDomains),
      allowedPorts: intersectNumbers(wide.network.allowedPorts, narrow.network.allowedPorts),
    },
    process: {
      maxProcesses: Math.min(wide.process.maxProcesses, narrow.process.maxProcesses),
      allowShell: wide.process.allowShell && narrow.process.allowShell,
    },
    resources: minResourceLimits(wide.resources, narrow.resources),
    tools: {
      allowedTools: intersectStrings(wide.tools.allowedTools, narrow.tools.allowedTools),
      deniedTools: [...new Set([...wide.tools.deniedTools, ...narrow.tools.deniedTools])],
    },
    runtime: {
      class: wide.runtime.class === 'gvisor' || narrow.runtime.class === 'gvisor' ? 'gvisor' : wide.runtime.class,
      requireGvisor: wide.runtime.requireGvisor || narrow.runtime.requireGvisor,
    },
  };
}

function intersectNumbers(a: readonly number[], b: readonly number[]): number[] {
  if (a.length === 0) return [...b];
  if (b.length === 0) return [...a];
  return a.filter((entry) => b.includes(entry));
}

export function minResourceLimits(a: ResourceLimits, b: ResourceLimits): ResourceLimits {
  return {
    cpuQuota: Math.min(a.cpuQuota, b.cpuQuota),
    memoryLimitMB: Math.min(a.memoryLimitMB, b.memoryLimitMB),
    diskLimitMB: Math.min(a.diskLimitMB, b.diskLimitMB),
    executionTimeoutMs: Math.min(a.executionTimeoutMs, b.executionTimeoutMs),
    maxProcesses: Math.min(a.maxProcesses, b.maxProcesses),
    outputLimitBytes: Math.min(a.outputLimitBytes, b.outputLimitBytes),
    idleTimeoutMs: Math.min(a.idleTimeoutMs, b.idleTimeoutMs),
  };
}

// -------------------------------------------------------------- evaluation ---

export interface EvaluateOptions {
  readonly now?: Date;
  /** Grants for the task, loaded by the Gateway. */
  readonly approvals?: readonly ApprovalGrant[];
  readonly approvalId?: string;
}

/**
 * Evaluate one request against one policy.
 *
 * The policy is the *effective* policy (already intersected by the caller), so
 * this function has a single job: apply the system denials, then the allow
 * lists, then the approval layer.
 */
export function evaluatePolicy(
  policy: SandboxPolicy,
  request: PolicyRequest,
  options: EvaluateOptions = {},
): PolicyEvaluation {
  void options;

  // ---- system layer: never overridable -------------------------------------
  if (request.action === 'tool') {
    const tool = request.toolName ?? request.resources[0] ?? '';
    if (policy.tools.deniedTools.includes(tool)) {
      return deny('system', `tool ${tool} is denied by policy`);
    }
    return allow('tool', `tool ${tool} is not denied`, [tool]);
  }

  if (request.action === 'network.connect') {
    return evaluateNetwork(policy, request);
  }

  const normalized: string[] = [];
  for (const resource of request.resources) {
    const path = request.action === 'process.exec' ? normalizeContainerPath(resource) : normalizeContainerPath(resource);
    if (underAny(path, policy.filesystem.deny)) {
      return deny('system', `${path} is on the system deny list`, [path]);
    }
    if (isSensitiveContainerPath(path)) {
      return deny('system', `${path} looks like a credential file`, [path]);
    }
    normalized.push(path);
  }

  if (request.action === 'process.exec') {
    if (!policy.process.allowShell) {
      return deny('task', 'shell execution is disabled by policy', normalized);
    }
    const command = request.command ?? '';
    for (const pattern of SYSTEM_DENY_COMMAND_PATTERNS) {
      if (pattern.test(command)) {
        return deny('system', 'command matches a system-level denial', normalized);
      }
    }
    if (request.cwd !== undefined) {
      const cwd = normalizeContainerPath(request.cwd);
      if (!underAny(cwd, policy.filesystem.write) && !underAny(cwd, policy.filesystem.read)) {
        return deny('task', `cwd ${cwd} is outside the workspace`, normalized);
      }
      if (underAny(cwd, policy.filesystem.deny)) {
        return deny('system', `cwd ${cwd} is on the system deny list`, normalized);
      }
    }
    return allow('task', 'command is inside the workspace boundary', normalized);
  }

  const allowList =
    request.action === 'fs.write' ? policy.filesystem.write : policy.filesystem.read;
  for (const path of normalized) {
    if (!underAny(path, allowList)) {
      return deny(
        'task',
        `${path} is outside the ${request.action === 'fs.write' ? 'writable' : 'readable'} workspace`,
        normalized,
      );
    }
  }

  return allow('task', `${request.action} is inside the workspace boundary`, normalized);
}

function evaluateNetwork(policy: SandboxPolicy, request: PolicyRequest): PolicyEvaluation {
  if (policy.network.mode === 'none') {
    return deny('task', 'network access is disabled for this sandbox', request.resources);
  }
  for (const resource of request.resources) {
    // Accepted forms: `example.com:443`, `https://example.com`.
    const parsed = parseNetworkResource(resource);
    if (!parsed) return deny('task', `unparseable network target ${resource}`, request.resources);
    if (!domainAllowed(parsed.host, policy.network.allowedDomains)) {
      return deny('task', `${parsed.host} is not on the domain allowlist`, request.resources);
    }
    if (policy.network.allowedPorts.length > 0 && !policy.network.allowedPorts.includes(parsed.port)) {
      return deny('task', `port ${parsed.port} is not on the port allowlist`, request.resources);
    }
  }
  return allow('approval', 'network target is allowlisted', request.resources);
}

function parseNetworkResource(resource: string): { host: string; port: number } | null {
  const value = resource.trim();
  if (value.length === 0) return null;
  try {
    const withScheme = value.includes('://') ? value : `https://${value}`;
    const url = new URL(withScheme);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return { host: url.hostname.toLowerCase(), port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) };
  } catch {
    return null;
  }
}

function domainAllowed(host: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return false;
  return allowed.some((entry) => {
    const domain = entry.trim().toLowerCase().replace(/^\*\./, '');
    if (domain.length === 0) return false;
    return host === domain || host.endsWith(`.${domain}`);
  });
}

const SENSITIVE_NAMES = new Set([
  '.env',
  '.npmrc',
  '.pypirc',
  'credentials',
  'credentials.json',
  'id_ed25519',
  'id_rsa',
  'secrets.json',
]);
const SENSITIVE_SUFFIXES = ['.cer', '.key', '.p12', '.pem', '.pfx'];

/** Workspace credential rule, applied to container paths. */
export function isSensitiveContainerPath(path: string): boolean {
  const name = path.split('/').pop() ?? '';
  if (name === '.env.example' || name === '.env.sample' || name === '.env.template') return false;
  if (name === '.env' || name.startsWith('.env.')) return true;
  if (SENSITIVE_NAMES.has(name)) return true;
  return SENSITIVE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function allow(layer: PolicyEvaluation['layer'], reason: string, resources: readonly string[]): PolicyEvaluation {
  return { decision: 'ALLOW', reason, layer, resources };
}

function deny(layer: PolicyEvaluation['layer'], reason: string, resources: readonly string[] = []): PolicyEvaluation {
  return { decision: 'DENY', reason, layer, resources };
}

// -------------------------------------------------------------- permission ---

/**
 * The Permission Manager: policy + process switches + approval grants.
 *
 * Kept separate from `evaluatePolicy` because approvals are stateful (they
 * expire, they are revoked, they name a policy version) and the policy itself
 * must stay a value.
 */
export class PermissionManager {
  private readonly policy: SandboxPolicy;
  private readonly settings: PermissionSettings;

  constructor(policy: SandboxPolicy, settings: PermissionSettings) {
    this.policy = policy;
    this.settings = settings;
  }

  get currentPolicy(): SandboxPolicy {
    return this.policy;
  }

  evaluate(
    request: PolicyRequest,
    approvals: readonly ApprovalGrant[] = [],
    now: Date = new Date(),
  ): PolicyEvaluation {
    const base = evaluatePolicy(this.policy, request, { now, approvals });
    if (base.decision !== 'ALLOW') return base;

    const needsApproval =
      (request.action === 'fs.write' && !this.settings.allowWorkspaceWrites) ||
      (request.action === 'process.exec' && !this.settings.allowCommands);
    if (!needsApproval) return base;

    const grant = findGrant(approvals, request, this.policy.policyVersion, now);
    if (grant) {
      return {
        decision: 'ALLOW',
        reason: `approval ${grant.approvalId} covers this request`,
        layer: 'approval',
        resources: base.resources,
      };
    }
    return {
      decision: 'APPROVAL_REQUIRED',
      reason:
        request.action === 'fs.write'
          ? 'file writes are not enabled for this task (WORKSPACE_WRITES), and no approval grant matches'
          : 'commands are not enabled for this task (WORKSPACE_COMMANDS), and no approval grant matches',
      layer: 'task',
      resources: base.resources,
    };
  }

  /** Throw the right error for a non-ALLOW decision. */
  authorize(
    request: PolicyRequest,
    approvals: readonly ApprovalGrant[] = [],
    now: Date = new Date(),
  ): PolicyEvaluation {
    const decision = this.evaluate(request, approvals, now);
    if (decision.decision === 'DENY') {
      throw new SandboxPolicyError(`sandbox policy denied ${request.action}: ${decision.reason}`);
    }
    if (decision.decision === 'APPROVAL_REQUIRED') {
      throw new SandboxApprovalRequiredError(
        `sandbox policy requires approval for ${request.action}: ${decision.reason}`,
      );
    }
    return decision;
  }
}

function findGrant(
  grants: readonly ApprovalGrant[],
  request: PolicyRequest,
  policyVersion: string,
  now: Date,
): ApprovalGrant | null {
  for (const grant of grants) {
    if (grant.revokedAt !== null) continue;
    if (grant.policyVersion !== policyVersion) continue;
    if (Date.parse(grant.expiresAt) <= now.getTime()) continue;
    if (grant.action !== request.action) continue;
    const resources = request.resources.map((resource) =>
      request.action === 'network.connect' ? resource : normalizeContainerPath(resource),
    );
    const covered = resources.every((resource) =>
      grant.resourceScope.some(
        (scope) =>
          resource === scope ||
          resource.startsWith(`${scope.replace(/\/+$/, '')}/`) ||
          (request.action === 'network.connect' && domainCovered(resource, scope)),
      ),
    );
    if (covered) return grant;
  }
  return null;
}

function domainCovered(resource: string, scope: string): boolean {
  const parsed = parseNetworkResource(resource);
  if (!parsed) return false;
  return domainAllowed(parsed.host, [scope]);
}

// -------------------------------------------------------------- compilation ---

/** Environment keys that can inject code into a process; never brokerable. */
const FORBIDDEN_ENV = /^(LD_|DYLD_)|^(BASH_ENV|ENV|NODE_OPTIONS|PYTHONSTARTUP|PERL5OPT|RUBYOPT)$/i;

/**
 * Compile a business policy into structured runtime configuration.
 *
 * This function is the last line between "the agent asked for something" and
 * "a container was created". It rejects anything that is not a structured,
 * reviewed value: no image tag (only a digest), no host path outside the
 * workspace, no preload environment, and no gVisor-less runtime when the policy
 * requires gVisor.
 */
export function compileRuntimeConfig(
  policy: SandboxPolicy,
  input: {
    readonly sandboxId: string;
    readonly taskId: string;
    readonly imageDigest: string;
    readonly workspaceHostPath: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly labels?: Readonly<Record<string, string>>;
    readonly maskedPaths?: readonly { readonly source: string; readonly target: string }[];
    /** Per-sandbox profile, already intersected with the deployment ceiling. */
    readonly resources?: ResourceLimits;
  },
): RuntimeSandboxConfig {
  if (!/^sha256:[a-f0-9]{64}$/i.test(input.imageDigest)) {
    throw new SandboxPolicyError(
      `image must be pinned to an immutable digest (sha256:…), got ${JSON.stringify(input.imageDigest)}`,
    );
  }
  if (!isAbsolute(input.workspaceHostPath)) {
    throw new SandboxPolicyError('workspace host path must be absolute');
  }
  if (policy.runtime.requireGvisor && policy.runtime.class !== 'gvisor') {
    throw new SandboxRuntimeUnavailableError(
      'this deployment requires gVisor; refusing to compile a weaker runtime configuration',
    );
  }

  const env: Record<string, string> = {
    // A fixed, minimal environment. The host environment is never copied in.
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: '/tmp',
    LANG: 'C.UTF-8',
    TERM: 'dumb',
    CI: '1',
    EUNOIA_SANDBOX: '1',
    EUNOIA_WORKSPACE: WORKSPACE_MOUNT_PATH,
  };
  for (const [key, value] of Object.entries(input.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new SandboxPolicyError(`invalid environment key ${JSON.stringify(key)}`);
    }
    if (FORBIDDEN_ENV.test(key)) {
      throw new SandboxPolicyError(`environment key ${key} can inject code and is refused`);
    }
    env[key] = value;
  }
  if (policy.network.mode === 'proxy_only') {
    const proxy = input.env?.HTTPS_PROXY ?? input.env?.https_proxy ?? input.env?.HTTP_PROXY;
    if (proxy) {
      env.HTTP_PROXY = proxy;
      env.HTTPS_PROXY = proxy;
      env.NO_PROXY = '127.0.0.1,localhost';
    }
  }

  const maskedPaths = (input.maskedPaths ?? []).map((mask) => {
    const target = normalizeContainerPath(mask.target);
    if (!target.startsWith(`${WORKSPACE_MOUNT_PATH}/`)) {
      throw new SandboxPolicyError('mask target must be a file inside the workspace');
    }
    if (!isAbsolute(mask.source) || mask.source === '/') {
      throw new SandboxPolicyError('mask source must be a regular host file path');
    }
    return { source: mask.source, target };
  });
  if (maskedPaths.length > 256) throw new SandboxPolicyError('too many masked credential files');

  return {
    sandboxId: input.sandboxId,
    taskId: input.taskId,
    imageDigest: input.imageDigest,
    workspaceHostPath: input.workspaceHostPath,
    workspaceWritable: underAny(WORKSPACE_MOUNT_PATH, policy.filesystem.write),
    runtimeClass: policy.runtime.class,
    resources: input.resources ?? policy.resources,
    network: policy.network,
    env,
    labels: { ...input.labels },
    maskedPaths,
  };
}

/** Convenience for the Gateway: a decision that is not `ALLOW` is an error. */
export function assertAllowed(decision: PolicyEvaluation): void {
  if (decision.decision === 'DENY') {
    throw new SandboxPolicyError(decision.reason);
  }
  if (decision.decision === 'APPROVAL_REQUIRED') {
    throw new SandboxApprovalRequiredError(decision.reason);
  }
}

/** The names of the tools the platform owns, for policy checks and docs. */
export const SANDBOX_TOOL_NAMES = [
  'read_file',
  'list_dir',
  'glob',
  'grep',
  'write_file',
  'edit_file',
  'run_command',
] as const;

export type SandboxToolName = (typeof SANDBOX_TOOL_NAMES)[number];

/** A decision value for tests and docs; `DENY` is never widened. */
export const DECISIONS: readonly PolicyDecision[] = ['ALLOW', 'APPROVAL_REQUIRED', 'DENY'];
