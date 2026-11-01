/**
 * The sandbox platform's vocabulary.
 *
 * This module has no I/O, no vendor SDK and no container library in it. The
 * domain types are the contract between the Gateway (what the agent is allowed
 * to ask for), the Controller (what a sandbox is doing), the Runtime Manager
 * (how a container is driven) and the store (what survives a crash). Keeping
 * them in one place is what makes it possible to test the policy decisions
 * without a container, and to replace containerd/gVisor without touching the
 * agent's tools.
 *
 * See docs/adr/017.sandbox.md and docs/adr/018-sandbox-implementation.md.
 */

/** The only policy document version this build understands. */
export const SANDBOX_POLICY_VERSION = 'sandbox-policy-v1';

/** Where a task's files appear inside the sandbox. Never host-specific. */
export const WORKSPACE_MOUNT_PATH = '/workspace';

/** Runtime user. Root inside a sandbox would make most of the baseline moot. */
export const SANDBOX_UID = 1000;
export const SANDBOX_GID = 1000;

/**
 * Paths that are denied by the system layer.
 *
 * This is the bottom of the policy stack and cannot be overridden by a tenant
 * policy, a task policy, an approval grant or an LLM's auto-review. The
 * container baseline (read-only rootfs, no host mounts) is the real enforcement;
 * this list is what the Gateway can check *before* an execution is submitted, so
 * a refused request never becomes a container process at all.
 */
export const SYSTEM_DENY_PATHS: readonly string[] = [
  '/etc/shadow',
  '/etc/gshadow',
  '/etc/sudoers',
  '/root',
  '/home',
  '/proc/sys',
  '/sys',
  '/dev',
  '/boot',
  '/var/run/docker.sock',
  '/run/docker.sock',
  '/run/containerd/containerd.sock',
  '/var/run/containerd/containerd.sock',
  '/run/crio/crio.sock',
  '/var/lib/docker',
  '/var/lib/containerd',
];

/** Commands whose presence in a request is a system-level denial. */
export const SYSTEM_DENY_COMMAND_PATTERNS: readonly RegExp[] = [
  /(^|[\s;&|])(docker|podman|nerdctl|ctr|crictl)\s/i,
  /(^|[\s;&|])mount\s/i,
  /(^|[\s;&|])nsenter\s/i,
  /(^|[\s;&|])unshare\s/i,
  /\/proc\/\d+\/(root|ns)/,
  /(\bchroot\b|\bpivot_root\b)/,
  /(^|[\s;&|])setcap\s/i,
  /(^|[\s;&|])insmod\s/i,
  /(^|[\s;&|])modprobe\s/i,
  /(^|[\s;&|])kexec\s/i,
  /(^|[\s;&|])bpf\s/i,
  /\/var\/run\/(docker|containerd)\.sock/,
];

// --------------------------------------------------------------- decisions ---

/**
 * The three answers the policy engine may give.
 *
 * `APPROVAL_REQUIRED` is not a soft yes: without a matching, unexpired grant the
 * Gateway refuses the request. It exists so an operator can authorise one action
 * on one scope for a limited time without widening the task policy itself.
 */
export type PolicyDecision = 'ALLOW' | 'APPROVAL_REQUIRED' | 'DENY';

export interface PolicyEvaluation {
  readonly decision: PolicyDecision;
  /** Stable, human-readable reason. Goes into the audit log, not the model. */
  readonly reason: string;
  /** Which layer decided: system, tenant, task, approval or tool. */
  readonly layer: 'system' | 'tenant' | 'task' | 'approval' | 'tool' | 'runtime';
  /** Container-absolute resources the decision applies to. */
  readonly resources: readonly string[];
}

// ------------------------------------------------------------------ policy ---

/**
 * The business policy, not an OCI config.
 *
 * The Controller compiles this into runtime flags. Nothing here can be passed
 * through to a container runtime verbatim: a caller that could write
 * `--privileged` into a policy object would have a container escape in a
 * configuration file.
 */
export interface SandboxPolicy {
  readonly policyVersion: string;
  readonly filesystem: {
    /** Container-absolute prefixes the sandbox may read. */
    readonly read: readonly string[];
    /** Container-absolute prefixes the sandbox may write. */
    readonly write: readonly string[];
    /** Explicit denials; they win over every allow above. */
    readonly deny: readonly string[];
  };
  readonly network: {
    readonly mode: 'none' | 'proxy_only';
    readonly allowedDomains: readonly string[];
    readonly allowedPorts: readonly number[];
  };
  readonly process: {
    readonly maxProcesses: number;
    readonly allowShell: boolean;
  };
  readonly resources: ResourceLimits;
  readonly tools: {
    readonly allowedTools: readonly string[];
    readonly deniedTools: readonly string[];
  };
  /**
   * The isolation class the deployment asked for. `requireGvisor` is true for
   * production: a runtime that cannot provide gVisor must refuse to start, not
   * quietly run on runc.
   */
  readonly runtime: {
    readonly class: 'gvisor' | 'runc' | 'default';
    readonly requireGvisor: boolean;
  };
}

export interface ResourceLimits {
  readonly cpuQuota: number;
  readonly memoryLimitMB: number;
  readonly diskLimitMB: number;
  readonly executionTimeoutMs: number;
  readonly maxProcesses: number;
  readonly outputLimitBytes: number;
  readonly idleTimeoutMs: number;
}

export interface ResourceProfile {
  readonly name: string;
  readonly limits: ResourceLimits;
}

/** Initial profiles from the ADR. Values are defaults, not a hard ceiling. */
export const RESOURCE_PROFILES: Readonly<Record<string, ResourceProfile>> = {
  small: {
    name: 'small',
    limits: {
      cpuQuota: 1,
      memoryLimitMB: 1_024,
      diskLimitMB: 2_048,
      executionTimeoutMs: 5 * 60_000,
      maxProcesses: 256,
      outputLimitBytes: 256 * 1024,
      idleTimeoutMs: 15 * 60_000,
    },
  },
  default: {
    name: 'default',
    limits: {
      cpuQuota: 2,
      memoryLimitMB: 4_096,
      diskLimitMB: 10_240,
      executionTimeoutMs: 30 * 60_000,
      maxProcesses: 512,
      outputLimitBytes: 256 * 1024,
      idleTimeoutMs: 60 * 60_000,
    },
  },
  large: {
    name: 'large',
    limits: {
      cpuQuota: 4,
      memoryLimitMB: 8_192,
      diskLimitMB: 20_480,
      executionTimeoutMs: 60 * 60_000,
      maxProcesses: 1_024,
      outputLimitBytes: 512 * 1024,
      idleTimeoutMs: 2 * 60 * 60_000,
    },
  },
};

export function resourceProfile(name: string): ResourceProfile {
  return RESOURCE_PROFILES[name] ?? (RESOURCE_PROFILES.default as ResourceProfile);
}

// ---------------------------------------------------------------- approval ---

/**
 * An approval is a scoped, expiring grant — never a bare boolean.
 *
 * The ADR is explicit about this: `{ "approved": true }` cannot be audited,
 * cannot be revoked, and cannot be checked against the policy version in force
 * when it was granted.
 */
export interface ApprovalGrant {
  readonly approvalId: string;
  readonly taskId: string;
  readonly action: string;
  readonly resourceScope: readonly string[];
  readonly expiresAt: string;
  readonly approvedBy: string;
  readonly policyVersion: string;
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

// ------------------------------------------------------------------ entities ---

export type TaskStatus = 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'FAILED' | 'ARCHIVED';

export interface Task {
  readonly taskId: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly status: TaskStatus;
  readonly workspaceId: string;
  readonly sandboxId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type WorkspaceMode = 'bind' | 'copy';

export interface Workspace {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly storageLocation: string;
  readonly mode: WorkspaceMode;
  readonly currentVersion: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkspaceCheckpoint {
  readonly checkpointId: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly createdAt: string;
  readonly sourceExecutionId: string | null;
  readonly contentDigest: string;
  readonly storageLocation: string;
}

export type SandboxStatus =
  | 'CREATING'
  | 'READY'
  | 'RUNNING'
  | 'INTERRUPTED'
  | 'RECOVERING'
  | 'EXPIRED'
  | 'TERMINATING'
  | 'DESTROYED'
  | 'FAILED';

export interface Sandbox {
  readonly sandboxId: string;
  readonly taskId: string;
  readonly runtimeType: string;
  readonly runtimeId: string;
  readonly imageDigest: string;
  readonly workspaceId: string;
  readonly policyVersion: string;
  /** Effective profile at creation; resource limits are derived from it. */
  readonly resourceProfile: string;
  readonly status: SandboxStatus;
  readonly createdAt: string;
  readonly lastHeartbeatAt: string | null;
  readonly updatedAt: string;
}

/**
 * The persisted execution state machine (ADR §8.1).
 *
 * `INTERRUPTED` and `UNKNOWN` are deliberate terminal-until-reconciled states.
 * Mapping either to `FAILED` would tell the model a command did not happen when
 * nobody knows whether it did.
 */
export type ExecutionState =
  | 'CREATED'
  | 'AUTHORIZED'
  | 'SUBMITTED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'INTERRUPTED'
  | 'UNKNOWN'
  | 'RECONCILING'
  | 'RETRYABLE';

/** The model-facing outcome. `UNKNOWN` is a first-class outcome. */
export type ExecutionOutcome = 'SUCCEEDED' | 'FAILED' | 'TIMEOUT' | 'CANCELLED' | 'UNKNOWN';

export interface Execution {
  readonly executionId: string;
  readonly taskId: string;
  readonly sandboxId: string;
  readonly idempotencyKey: string;
  readonly commandDigest: string;
  readonly command: readonly string[];
  readonly cwd: string;
  readonly status: ExecutionState;
  readonly exitCode: number | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly policyVersion: string;
  readonly toolCallId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ExecutionEvent {
  readonly eventId: string;
  readonly taskId: string;
  readonly sandboxId: string;
  readonly executionId: string;
  readonly idempotencyKey: string;
  readonly eventType: string;
  readonly timestamp: string;
  readonly policyVersion: string;
  readonly payload: unknown;
}

/** The Gateway API's result shape (ADR §7.3). */
export interface ExecutionResult {
  readonly executionId: string;
  readonly status: ExecutionOutcome;
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
}

export interface AuditEvent {
  readonly id: string;
  readonly timestamp: string;
  readonly sessionId: string | null;
  readonly taskId: string | null;
  readonly sandboxId: string | null;
  readonly executionId: string | null;
  readonly toolCallId: string | null;
  readonly policyVersion: string | null;
  readonly approvalId: string | null;
  readonly action: string;
  readonly outcome: 'allowed' | 'denied' | 'approval_required' | 'failed' | 'succeeded';
  readonly detail: unknown;
}

// ------------------------------------------------------------------ service ---

/**
 * The fixed input to `create`.
 *
 * There is no field for a host path, a mount, an OCI config or a runtime binary,
 * and there must never be one. `imageDigest` names an image the operator pinned;
 * the Controller resolves it from the configured image catalog, so a request
 * cannot introduce a new image.
 */
export interface CreateSandboxInput {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly imageDigest: string;
  readonly policyVersion: string;
  readonly resourceProfile: string;
}

export interface ExecuteInput {
  readonly sandboxId: string;
  readonly executionId: string;
  readonly idempotencyKey: string;
  readonly command: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  /** `true` runs the single `command[0]` through `/bin/sh -c`. */
  readonly shell?: boolean;
  readonly toolCallId?: string;
}

export interface SandboxStatusSnapshot {
  readonly sandboxId: string;
  readonly taskId: string;
  readonly status: SandboxStatus;
  readonly runtimeType: string;
  readonly runtimeId: string;
  readonly imageDigest: string;
  readonly workspaceId: string;
  readonly lastHeartbeatAt: string | null;
  readonly runtimeAlive: boolean;
  readonly detail?: string;
}

// -------------------------------------------------------------- runtime I/O ---

/** What the Runtime Manager is allowed to do. Structured, never opaque. */
export interface RuntimeSandboxConfig {
  readonly sandboxId: string;
  readonly taskId: string;
  readonly imageDigest: string;
  readonly workspaceHostPath: string;
  readonly workspaceWritable: boolean;
  readonly runtimeClass: 'gvisor' | 'runc' | 'default';
  readonly resources: ResourceLimits;
  readonly network: SandboxPolicy['network'];
  /** Only brokered, short-lived values; never `process.env`. */
  readonly env: Readonly<Record<string, string>>;
  readonly labels: Readonly<Record<string, string>>;
  /**
   * Host credential files hidden behind empty read-only mounts.
   *
   * The file tools refuse these names, but a command could still `cat .env`
   * inside the bind-mounted project. A mask mount makes the file empty for every
   * process in the sandbox without touching the host copy.
   */
  readonly maskedPaths?: readonly { readonly source: string; readonly target: string }[];
}

export interface SandboxHandle {
  readonly sandboxId: string;
  readonly runtimeId: string;
  readonly runtimeType: string;
}

export interface RuntimeStatus {
  readonly exists: boolean;
  readonly running: boolean;
  readonly exitCode: number | null;
  readonly detail?: string;
}

export interface RuntimeExecutionRequest {
  readonly executionId: string;
  readonly command: readonly string[];
  readonly shell: boolean;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly env: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface RuntimeExecutionResult {
  readonly status: ExecutionOutcome;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly timedOut: boolean;
  readonly detail?: string;
}

/**
 * The one interface the Controller uses.
 *
 * `gVisor` is a provider detail. A provider must not expose `containerd`,
 * `runsc` or `docker` types to anything above this line.
 */
export interface SandboxRuntime {
  readonly type: string;
  /** Refuse to start at all when the requested isolation is unavailable. */
  probe(): Promise<{ readonly ok: boolean; readonly detail: string }>;
  create(config: RuntimeSandboxConfig): Promise<SandboxHandle>;
  start(handle: SandboxHandle): Promise<void>;
  execute(handle: SandboxHandle, request: RuntimeExecutionRequest): Promise<RuntimeExecutionResult>;
  inspect(handle: SandboxHandle): Promise<RuntimeStatus>;
  interrupt(handle: SandboxHandle, executionId: string): Promise<void>;
  /** Reads the marker an execution wrapper wrote, for reconciliation. */
  readExitMarker(handle: SandboxHandle, executionId: string): Promise<number | null>;
  destroy(handle: SandboxHandle): Promise<void>;
}

// ------------------------------------------------------------------- limits ---

export interface SandboxLimits {
  readonly maxConcurrentGlobal: number;
  readonly maxConcurrentPerUser: number;
  readonly maxConcurrentPerTask: number;
  readonly maxExecutionTimeoutMs: number;
  readonly maxOutputBytes: number;
}
