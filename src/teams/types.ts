/**
 * The Agent Team / Subagent domain.
 *
 * Three different questions have three different records, and keeping them apart
 * is the whole point of this module:
 *
 *   - **Member** — a durable participant with its own internal conversation.
 *     "A member exists" says nothing about whether it is working.
 *   - **Activation** — one execution of one member. A member can be idle,
 *     active, interrupted and active again; each attempt is its own activation.
 *   - **Task** — a piece of work that is done only when a submission has been
 *     accepted. A finished activation, a successful tool call and a submitted
 *     task are three different facts, none of which is "accepted".
 *
 * A fourth record, **TeamRun**, scopes all of it to one user request. A Team is
 * durable across runs; a run is the collaboration that one message started.
 *
 * See docs/adr/034-subagent-and-agent-team.md.
 */

export const TEAM_SCHEMA_VERSION = 1;

/** A stable, prefixed id. Never derived from a name. */
export type TeamId = string;

// ------------------------------------------------------------------- config ---

export interface TeamLimits {
  /** Includes the root member. */
  readonly maxMembers: number;
  /** Model HTTP requests in flight across one team. */
  readonly maxConcurrentModelRequests: number;
  /** Root = 1, a direct child = 2. */
  readonly maxDepth: number;
  readonly maxActivations: number;
  readonly maxModelRequests: number;
  readonly maxTasks: number;
  readonly maxMessages: number;
  readonly maxMessageChars: number;
  readonly maxQueuedMessagesPerMember: number;
  /** A message may auto-start an idle member at most this many times. */
  readonly maxAutoActivationsPerMember: number;
  /** One message can address at most this many members. */
  readonly maxBroadcastFanout: number;
}

export interface TeamBudgetLimits {
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxRequests: number;
  /** Null means "no price configured", reported as unknown, never as free. */
  readonly maxEstimatedCostUsd: number | null;
}

export type TeamMode = 'delegation' | 'team';

export interface TeamConfig {
  /**
   * `delegation` keeps Subagent tools but disables the shared task board.
   * `team` enables tasks, dependencies and dispatch. The record is never
   * deleted when the switch turns off.
   */
  readonly mode: TeamMode;
  readonly defaultModelId: string;
  readonly autoDispatch: boolean;
  /** Paused dispatch keeps queued work; it does not cancel a running turn. */
  readonly dispatchPaused: boolean;
  readonly limits: TeamLimits;
  readonly budget: TeamBudgetLimits;
}

export const DEFAULT_TEAM_LIMITS: TeamLimits = {
  maxMembers: 4,
  maxConcurrentModelRequests: 3,
  maxDepth: 2,
  maxActivations: 32,
  maxModelRequests: 64,
  maxTasks: 256,
  maxMessages: 128,
  maxMessageChars: 4_000,
  maxQueuedMessagesPerMember: 16,
  maxAutoActivationsPerMember: 8,
  maxBroadcastFanout: 8,
};

/**
 * The documented default. A deployment may lower it; a client or a model may
 * not raise it, which is enforced by `clampConfig`, not by the UI.
 */
export const DEFAULT_TEAM_BUDGET: TeamBudgetLimits = {
  maxInputTokens: 400_000,
  maxOutputTokens: 32_000,
  maxRequests: 24,
  maxEstimatedCostUsd: null,
};

export function defaultTeamConfig(modelId: string): TeamConfig {
  return {
    mode: 'team',
    defaultModelId: modelId,
    autoDispatch: true,
    dispatchPaused: false,
    limits: DEFAULT_TEAM_LIMITS,
    budget: DEFAULT_TEAM_BUDGET,
  };
}

/** Clamp a requested config to the deployment ceiling. */
export function clampTeamConfig(
  requested: Partial<TeamConfig>,
  ceiling: TeamConfig,
  fallbackModelId: string,
): TeamConfig {
  const limits: Partial<TeamLimits> = requested.limits ?? {};
  const budget: Partial<TeamBudgetLimits> = requested.budget ?? {};
  const clamp = (value: number | undefined, max: number, min = 1): number =>
    Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value as number))) : max;
  return {
    mode: requested.mode === 'delegation' ? 'delegation' : 'team',
    defaultModelId:
      typeof requested.defaultModelId === 'string' && requested.defaultModelId.length > 0
        ? requested.defaultModelId
        : fallbackModelId,
    autoDispatch: requested.autoDispatch !== false,
    dispatchPaused: requested.dispatchPaused === true,
    limits: {
      maxMembers: clamp(limits.maxMembers, ceiling.limits.maxMembers, 1),
      maxConcurrentModelRequests: clamp(
        limits.maxConcurrentModelRequests,
        ceiling.limits.maxConcurrentModelRequests,
      ),
      maxDepth: clamp(limits.maxDepth, ceiling.limits.maxDepth, 1),
      maxActivations: clamp(limits.maxActivations, ceiling.limits.maxActivations),
      maxModelRequests: clamp(limits.maxModelRequests, ceiling.limits.maxModelRequests),
      maxTasks: clamp(limits.maxTasks, ceiling.limits.maxTasks),
      maxMessages: clamp(limits.maxMessages, ceiling.limits.maxMessages),
      maxMessageChars: clamp(limits.maxMessageChars, ceiling.limits.maxMessageChars, 64),
      maxQueuedMessagesPerMember: clamp(
        limits.maxQueuedMessagesPerMember,
        ceiling.limits.maxQueuedMessagesPerMember,
      ),
      maxAutoActivationsPerMember: clamp(
        limits.maxAutoActivationsPerMember,
        ceiling.limits.maxAutoActivationsPerMember,
        0,
      ),
      maxBroadcastFanout: clamp(limits.maxBroadcastFanout, ceiling.limits.maxBroadcastFanout),
    },
    budget: {
      maxInputTokens: clamp(budget.maxInputTokens, ceiling.budget.maxInputTokens),
      maxOutputTokens: clamp(budget.maxOutputTokens, ceiling.budget.maxOutputTokens),
      maxRequests: clamp(budget.maxRequests, ceiling.budget.maxRequests),
      maxEstimatedCostUsd:
        typeof budget.maxEstimatedCostUsd === 'number' &&
        budget.maxEstimatedCostUsd > 0 &&
        (ceiling.budget.maxEstimatedCostUsd === null ||
          budget.maxEstimatedCostUsd <= ceiling.budget.maxEstimatedCostUsd)
          ? budget.maxEstimatedCostUsd
          : ceiling.budget.maxEstimatedCostUsd,
    },
  };
}

// -------------------------------------------------------------------- team ---

export interface Team {
  readonly id: TeamId;
  readonly ownerId: string;
  readonly rootConversationId: string;
  readonly enabled: boolean;
  readonly configRevision: number;
  readonly config: TeamConfig;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Where a run is, as opposed to what a member is doing. */
export type TeamRunStatus =
  | 'queued'
  | 'running'
  | 'pausing'
  | 'paused'
  | 'waiting_user'
  | 'stopping'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'needs_reconciliation';

export const TERMINAL_RUN_STATUSES: readonly TeamRunStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
];

export function isTerminalRunStatus(status: TeamRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/** The legal transitions. A table, so a test can assert the whole thing. */
export const RUN_TRANSITIONS: Readonly<Record<TeamRunStatus, readonly TeamRunStatus[]>> = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['pausing', 'waiting_user', 'stopping', 'succeeded', 'failed', 'needs_reconciliation'],
  pausing: ['paused', 'needs_reconciliation', 'failed'],
  paused: ['running', 'stopping', 'cancelled', 'failed'],
  waiting_user: ['running', 'stopping', 'succeeded', 'failed', 'cancelled'],
  stopping: ['cancelled', 'failed', 'needs_reconciliation'],
  succeeded: [],
  failed: [],
  cancelled: [],
  needs_reconciliation: ['running', 'failed', 'cancelled'],
};

/** The table is the authority; a test asserts every allowed pair. */
export function canTransitionRun(from: TeamRunStatus, to: TeamRunStatus): boolean {
  return (RUN_TRANSITIONS[from] ?? []).includes(to);
}

export interface RunBudgetSnapshot {
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxRequests: number;
  readonly maxEstimatedCostUsd: number | null;
}

export interface TeamRun {
  readonly id: TeamId;
  readonly teamId: TeamId;
  readonly ownerId: string;
  readonly rootConversationId: string;
  readonly rootTurnId: string;
  readonly rootRequestId: string;
  readonly inputHash: string;
  readonly status: TeamRunStatus;
  readonly budget: RunBudgetSnapshot;
  readonly rootMemberId: string | null;
  readonly reason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
}

// ------------------------------------------------------------------ member ---

export type MemberStatus =
  | 'provisioning'
  | 'idle'
  | 'active'
  | 'closing'
  | 'closed'
  | 'failed';

export type MemberRole = 'root' | 'worker' | 'reviewer';

/** The effective permission ceiling for one member. */
export interface MemberPermissions {
  readonly allowWorkspaceWrites: boolean;
  readonly allowCommands: boolean;
  /** Null means "every builtin tool except spawning beyond the depth limit". */
  readonly allowedTools: readonly string[] | null;
  readonly canSpawn: boolean;
  readonly canWriteMemory: boolean;
  readonly maxOutputChars: number;
  /** Private images this member explicitly received. */
  readonly imageAssetIds: readonly string[];
  /**
   * External-tool ceiling (R02). Absent means no MCP tools for a member:
   * generic MCP parameters cannot be constrained by local path/network checks,
   * so a restricted member only receives what a parent explicitly grants.
   */
  readonly mcp?: {
    readonly servers?: readonly string[] | null;
    readonly tools?: readonly string[] | null;
    readonly externalWrite?: boolean;
    readonly externalUnknown?: boolean;
    readonly accounts?: readonly string[] | null;
  };
}

export interface MemberProfile {
  readonly modelId: string;
  readonly providerId: string;
  readonly maxSteps: number;
  /** Capabilities are resolved from the catalog, never guessed from a name. */
  readonly supportsTools: boolean;
  readonly supportsImages: boolean;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
}

export type WorkspaceMode = 'copy' | 'readonly' | 'bind';

export interface Member {
  readonly id: TeamId;
  readonly teamId: TeamId;
  readonly parentMemberId: string | null;
  readonly internalConversationId: string;
  readonly name: string;
  readonly role: MemberRole;
  readonly depth: number;
  readonly status: MemberStatus;
  readonly profile: MemberProfile;
  readonly permissions: MemberPermissions;
  readonly workspaceId: string | null;
  readonly workspaceMode: WorkspaceMode;
  readonly contextMode: 'fresh' | 'fork';
  readonly forkSeq: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  /** Last activation, for a UI that shows "正在执行". */
  readonly currentActivationId: string | null;
  readonly error: string | null;
}

// -------------------------------------------------------------- activation ---

export type ActivationStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'interrupted'
  | 'unknown';

export const ACTIVATION_TERMINAL: readonly ActivationStatus[] = [
  'succeeded',
  'failed',
  'interrupted',
  'unknown',
];

export function isTerminalActivation(status: ActivationStatus): boolean {
  return ACTIVATION_TERMINAL.includes(status);
}

export interface Activation {
  readonly id: TeamId;
  readonly runId: TeamId;
  readonly memberId: TeamId;
  readonly requestId: string;
  readonly generation: number;
  readonly status: ActivationStatus;
  /** Free-form, but durable: what the run has already done for this attempt. */
  readonly checkpoint: Record<string, unknown>;
  readonly input: ActivationInput;
  readonly result: ActivationResult | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly leaseExpiresAt: string | null;
}

export interface ActivationInput {
  /** A user/root follow-up or the task instruction. */
  readonly kind: 'spawn' | 'followup' | 'task' | 'message' | 'resume';
  readonly text: string;
  readonly taskId?: string;
  readonly messageId?: string;
  readonly images?: readonly string[];
}

export interface ActivationResult {
  readonly summary: string;
  readonly usage?: UsageTotals;
  readonly steps?: number;
  readonly finishReason?: string;
  readonly taskId?: string;
  readonly messageId?: string;
}

// -------------------------------------------------------------------- task ---

export type TaskStatus = 'pending' | 'running' | 'submitted' | 'accepted' | 'failed' | 'cancelled';

export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ['running', 'cancelled'],
  running: ['submitted', 'pending', 'failed', 'cancelled'],
  submitted: ['accepted', 'pending', 'failed', 'cancelled'],
  accepted: [],
  failed: [],
  cancelled: [],
};

export interface Task {
  readonly id: TeamId;
  readonly teamId: TeamId;
  readonly runId: TeamId;
  readonly revision: number;
  readonly title: string;
  readonly specification: string;
  readonly acceptance: string;
  readonly required: boolean;
  readonly dependencies: readonly string[];
  readonly ownerId: string | null;
  readonly status: TaskStatus;
  /** Scheduling hints, never a lock. Enforced by the file/command/MCP policy. */
  readonly writeScopes: readonly string[];
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly submittedAt: string | null;
  readonly acceptedAt: string | null;
  readonly failureReason: string | null;
  /** The attempt a submit/review acts on. */
  readonly currentAttemptId: string | null;
}

/**
 * Ready is *derived*: pending, no owner conflict, and every dependency
 * accepted. Storing a `ready` flag would let it go stale after a dependency
 * fails, which is exactly the state that silently unblocks work.
 */
export function isTaskReady(task: Task, byId: ReadonlyMap<string, Task>): boolean {
  if (task.status !== 'pending') return false;
  return task.dependencies.every((dependency) => byId.get(dependency)?.status === 'accepted');
}

export interface TaskSubmission {
  readonly summary: string;
  readonly artifactIds: readonly string[];
  readonly testEvidence: readonly string[];
  /** The candidate snapshot the artifacts were produced against. */
  readonly candidateHash: string | null;
  readonly submittedAt: string;
  readonly submittedBy: string;
}

export interface TaskReview {
  readonly decision: 'accepted' | 'rejected';
  readonly reviewerId: string;
  readonly reason: string;
  readonly evidence: readonly string[];
  readonly candidateHash: string | null;
  readonly reviewedAt: string;
}

export interface TaskAttempt {
  readonly id: TeamId;
  readonly taskId: TeamId;
  readonly activationId: string | null;
  readonly generation: number;
  readonly leaseExpiresAt: string | null;
  readonly baselineId: string | null;
  readonly submission: TaskSubmission | null;
  readonly review: TaskReview | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ------------------------------------------------------------------ message ---

export type MessageState = 'accepted' | 'injected' | 'processed' | 'failed';

export type MessageSender = 'member' | 'user' | 'root';

export interface TeamMessage {
  readonly id: TeamId;
  readonly teamId: TeamId;
  readonly runId: TeamId;
  /** Resolved by the server from the caller; a client cannot choose it. */
  readonly senderId: string;
  readonly senderKind: MessageSender;
  readonly recipientId: string;
  /** Sender-supplied idempotency key, scoped to sender+recipient. */
  readonly clientMessageId: string;
  readonly body: string;
  readonly sequence: number;
  readonly state: MessageState;
  readonly createdAt: string;
  readonly injectedAt: string | null;
  readonly processedAt: string | null;
  /** The activation that consumed it, once injected. */
  readonly activationId: string | null;
  readonly error: string | null;
}

// ----------------------------------------------------------------- artifact ---

export type ArtifactKind = 'patch' | 'file' | 'test' | 'note';

export interface ArtifactFile {
  readonly path: string;
  /** A rename is delete+add with both paths stated, never guessed. */
  readonly change: 'added' | 'modified' | 'deleted' | 'renamed';
  readonly baseHash: string | null;
  readonly contentHash: string | null;
  readonly bytes: number;
  readonly executable: boolean;
  readonly binary: boolean;
  readonly fromPath?: string;
  /** Content for text files, bounded. Absent for binary and oversized files. */
  readonly content?: string;
}

export interface ArtifactManifest {
  readonly files: readonly ArtifactFile[];
  readonly sourceVersion: string;
  readonly candidateHash: string;
}

export interface Artifact {
  readonly id: TeamId;
  readonly teamId: TeamId;
  readonly runId: TeamId;
  readonly taskId: TeamId | null;
  readonly attemptId: TeamId | null;
  readonly memberId: TeamId;
  readonly kind: ArtifactKind;
  readonly manifest: ArtifactManifest;
  readonly testEvidence: readonly string[];
  readonly createdAt: string;
}

// -------------------------------------------------------------------- event ---

export type TeamEventKind =
  | 'team.created'
  | 'team.config'
  | 'run.created'
  | 'run.status'
  | 'run.summary'
  | 'member.created'
  | 'member.status'
  | 'activation.queued'
  | 'activation.started'
  | 'activation.finished'
  | 'task.created'
  | 'task.updated'
  | 'task.claimed'
  | 'task.submitted'
  | 'task.reviewed'
  | 'task.cancelled'
  | 'message.accepted'
  | 'message.injected'
  | 'message.processed'
  | 'artifact.created'
  | 'integration.created'
  | 'resource.granted'
  | 'resource.revoked'
  | 'integration.conflict'
  | 'integration.published'
  | 'budget.reserved'
  | 'budget.settled'
  | 'budget.exhausted'
  | 'run.paused'
  | 'run.resumed'
  | 'run.stopped';

export interface TeamEvent {
  readonly id: TeamId;
  readonly teamId: TeamId;
  readonly runId: TeamId;
  readonly sequence: number;
  readonly kind: TeamEventKind;
  readonly payload: Record<string, unknown>;
  readonly idempotencyKey: string | null;
  readonly createdAt: string;
}

export interface NewTeamEvent {
  readonly kind: TeamEventKind;
  readonly payload?: Record<string, unknown>;
  readonly idempotencyKey?: string;
}

// ------------------------------------------------------------------- budget ---

export type BudgetEntryStatus = 'reserved' | 'settled' | 'incomplete' | 'released';

export interface UsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly cacheWriteTokens: number;
  readonly requests: number;
  readonly measuredRequests: number;
  readonly incomplete: boolean;
}

export interface BudgetEntry {
  readonly id: TeamId;
  readonly runId: TeamId;
  readonly memberId: string;
  readonly activationId: string | null;
  readonly requestKey: string;
  readonly generation: number;
  readonly status: BudgetEntryStatus;
  /** Reserved before the request; settled from provider usage afterwards. */
  readonly reservedInputTokens: number;
  readonly reservedOutputTokens: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedTokens: number | null;
  readonly estimatedCostUsd: number | null;
  readonly priceVersion: string | null;
  readonly createdAt: string;
  readonly settledAt: string | null;
}

export interface BudgetSnapshot {
  readonly limits: RunBudgetSnapshot;
  readonly reservedInputTokens: number;
  readonly reservedOutputTokens: number;
  readonly settledInputTokens: number;
  readonly settledOutputTokens: number;
  readonly reservedRequests: number;
  readonly settledRequests: number;
  readonly estimatedCostUsd: number;
  readonly incompleteEntries: number;
  /** Conservative: reservations count until settled. */
  readonly remainingInputTokens: number;
  readonly remainingOutputTokens: number;
  readonly remainingRequests: number;
  readonly exhausted: boolean;
}

/** A per-request reservation, taken before the provider is called. */
export interface BudgetReservation {
  readonly entry: BudgetEntry;
  readonly snapshot: BudgetSnapshot;
}

// ------------------------------------------------------------------ errors ---

export type TeamErrorCode =
  | 'TEAM_NOT_FOUND'
  | 'TEAM_FORBIDDEN'
  | 'TEAM_CONFIG_CONFLICT'
  | 'TEAM_RUN_NOT_FOUND'
  | 'TEAM_RUN_CONFLICT'
  | 'TEAM_RUN_BUSY'
  | 'TEAM_RUN_TERMINAL'
  | 'TEAM_MEMBER_NOT_FOUND'
  | 'TEAM_MEMBER_CLOSED'
  | 'TEAM_MEMBER_LIMIT'
  | 'TEAM_DEPTH_LIMIT'
  | 'TEAM_ACTIVATION_CONFLICT'
  | 'TEAM_ACTIVATION_LIMIT'
  | 'TEAM_TASK_NOT_FOUND'
  | 'TEAM_TASK_CONFLICT'
  | 'TEAM_TASK_INVALID'
  | 'TEAM_TASK_NOT_READY'
  | 'TEAM_TASK_NOT_ELIGIBLE'
  | 'TEAM_TASK_LIMIT'
  | 'TEAM_MESSAGE_INVALID'
  | 'TEAM_MESSAGE_CONFLICT'
  | 'TEAM_MESSAGE_LIMIT'
  | 'TEAM_BUDGET_EXHAUSTED'
  | 'TEAM_BUDGET_CONFLICT'
  | 'TEAM_CAPABILITY'
  | 'TEAM_FORK_INCOMPATIBLE'
  | 'TEAM_WORKSPACE'
  | 'TEAM_INTEGRATION_CONFLICT'
  | 'TEAM_INTEGRATION_STALE'
  | 'TEAM_UNKNOWN_SIDE_EFFECT'
  | 'TEAM_QUESTION_NOT_FOUND'
  | 'TEAM_QUESTION_CONFLICT'
  | 'TEAM_UNAVAILABLE'
  | 'TEAM_MODE_DISABLED';

export class TeamError extends Error {
  readonly code: TeamErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly detail: Record<string, unknown> | null;

  constructor(
    code: TeamErrorCode,
    message: string,
    status = 400,
    detail: Record<string, unknown> | null = null,
    retryable = false,
  ) {
    super(message);
    this.name = 'TeamError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.detail = detail;
  }
}

export function isTeamError(error: unknown): error is TeamError {
  return error instanceof TeamError;
}

// ------------------------------------------------------------- capabilities ---

export interface TeamCapabilitySnapshot {
  readonly modelId: string;
  readonly providerId: string;
  readonly supportsTools: boolean;
  readonly supportsImages: boolean;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
}

/** Stable ids for the member tools; the UI and the model share them. */
export const AGENT_TOOLS = [
  'agent_spawn',
  'agent_followup',
  'agent_list',
  'agent_send_message',
  'agent_wait',
  'agent_interrupt',
  'agent_close',
] as const;

export const TEAM_TASK_TOOLS = [
  'team_task_create',
  'team_task_list',
  'team_task_get',
  'team_task_update',
  'team_task_claim',
  'team_task_submit',
  'team_task_review',
] as const;

export const TEAM_TOOLS = [...AGENT_TOOLS, ...TEAM_TASK_TOOLS] as const;
