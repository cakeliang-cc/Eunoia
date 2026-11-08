/**
 * The Team store contract.
 *
 * Both implementations (`store-memory.ts`, `store-sqlite.ts`) satisfy this
 * interface, and `store-contract.test.ts` runs the same cases against both. The
 * rules that must not depend on the backend live here:
 *
 *   - **CAS everywhere.** A task write carries `expectedRevision`; a stale
 *     write returns the current row instead of applying.
 *   - **One running activation per member.** Enforced by a unique index in
 *     SQLite and by the same check in memory.
 *   - **A message is idempotent by (sender, recipient, clientMessageId).** The
 *     same key with a different body is a conflict, never an update.
 *   - **Events and state change together.** Mutations take an optional event
 *     and write both in one transaction, so a crash cannot leave a state that
 *     nobody was told about.
 *   - **Budget reservations are atomic.** Two members cannot both see the same
 *     remaining tokens and reserve them.
 */

import type {
  Activation,
  ActivationStatus,
  Artifact,
  BudgetEntry,
  BudgetSnapshot,
  BudgetReservation,
  Member,
  MemberStatus,
  NewTeamEvent,
  Task,
  TaskAttempt,
  TaskReview,
  TaskStatus,
  TaskSubmission,
  Team,
  TeamConfig,
  TeamEvent,
  TeamMessage,
  TeamRun,
  TeamRunStatus,
  UsageTotals,
} from './types.ts';

export interface CasOutcome<T> {
  readonly ok: true;
  readonly value: T;
}

export interface CasConflict {
  readonly ok: false;
  readonly current: Task;
}

export type CasResult<T> = CasOutcome<T> | CasConflict;

export interface CreateTeamInput {
  readonly id: string;
  readonly ownerId: string;
  readonly rootConversationId: string;
  readonly enabled: boolean;
  readonly config: TeamConfig;
  readonly now: string;
}

export interface UpdateTeamInput {
  readonly id: string;
  readonly expectedRevision: number;
  readonly enabled: boolean;
  readonly config: TeamConfig;
  readonly now: string;
}

export interface CreateRunInput {
  readonly id: string;
  readonly teamId: string;
  readonly ownerId: string;
  readonly rootConversationId: string;
  readonly rootTurnId: string;
  readonly rootRequestId: string;
  readonly inputHash: string;
  readonly budget: TeamRun['budget'];
  readonly now: string;
}

export interface CreateRunResult {
  readonly run: TeamRun;
  /** False when the idempotency key was already used. */
  readonly created: boolean;
}

export interface RunPatch {
  readonly status?: TeamRunStatus;
  readonly rootMemberId?: string | null;
  readonly reason?: string | null;
  readonly finishedAt?: string | null;
}

export interface CreateMemberInput {
  readonly member: Member;
  readonly event?: NewTeamEvent | null;
}

export interface UpdateMemberPatch {
  readonly status?: MemberStatus;
  readonly currentActivationId?: string | null;
  readonly closedAt?: string | null;
  readonly error?: string | null;
  readonly now: string;
}

export interface CreateActivationInput {
  readonly activation: Activation;
  readonly maxActivations: number;
  readonly event?: NewTeamEvent | null;
}

export interface UpdateActivationPatch {
  readonly status?: ActivationStatus;
  readonly checkpoint?: Record<string, unknown>;
  readonly result?: Activation['result'];
  readonly error?: string | null;
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
  readonly leaseExpiresAt?: string | null;
  readonly generation?: number;
}

export interface CreateTaskInput {
  readonly task: Task;
  readonly maxTasks: number;
  readonly event?: NewTeamEvent | null;
}

export interface UpdateTaskPatch {
  readonly title?: string;
  readonly specification?: string;
  readonly acceptance?: string;
  readonly required?: boolean;
  readonly dependencies?: readonly string[];
  readonly ownerId?: string | null;
  readonly writeScopes?: readonly string[];
  readonly status?: TaskStatus;
  readonly failureReason?: string | null;
  readonly submittedAt?: string | null;
  readonly acceptedAt?: string | null;
  readonly currentAttemptId?: string | null;
}

export interface UpdateTaskInput {
  readonly taskId: string;
  readonly expectedRevision: number;
  readonly patch: UpdateTaskPatch;
  readonly event?: NewTeamEvent | null;
  readonly now: string;
}

export interface ClaimTaskInput {
  readonly taskId: string;
  readonly expectedRevision: number;
  readonly memberId: string;
  readonly activationId: string | null;
  readonly generation: number;
  readonly leaseExpiresAt: string | null;
  readonly baselineId: string | null;
  readonly event?: NewTeamEvent | null;
  readonly now: string;
}

export interface ClaimTaskValue {
  readonly task: Task;
  readonly attempt: TaskAttempt;
}

export interface SubmitTaskInput {
  readonly taskId: string;
  readonly expectedRevision: number;
  readonly attemptId: string;
  readonly submission: TaskSubmission;
  readonly event?: NewTeamEvent | null;
  readonly now: string;
}

export interface SubmitTaskValue {
  readonly task: Task;
  readonly attempt: TaskAttempt;
}

export interface ReviewTaskInput {
  readonly taskId: string;
  readonly expectedRevision: number;
  readonly attemptId: string;
  readonly review: TaskReview;
  readonly event?: NewTeamEvent | null;
  readonly now: string;
}

export interface ReviewTaskValue {
  readonly task: Task;
  readonly attempt: TaskAttempt;
}

export interface AppendMessageInput {
  readonly message: TeamMessage;
  readonly maxMessages: number;
  readonly maxQueuedPerMember: number;
  readonly event?: NewTeamEvent | null;
}

export interface AppendMessageValue {
  readonly message: TeamMessage;
  readonly duplicate: boolean;
}

export interface CreateArtifactInput {
  readonly artifact: Artifact;
  readonly event?: NewTeamEvent | null;
}

export interface ReserveBudgetInput {
  readonly id: string;
  readonly runId: string;
  readonly memberId: string;
  readonly activationId: string | null;
  readonly requestKey: string;
  readonly generation: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number | null;
  readonly priceVersion: string | null;
  readonly event?: NewTeamEvent | null;
  readonly now: string;
}

export interface SettleBudgetInput {
  readonly entryId: string;
  readonly usage: {
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly cachedTokens: number | null;
    readonly cacheWriteTokens?: number | null;
  };
  readonly incomplete: boolean;
  readonly estimatedCostUsd?: number | null;
  readonly event?: NewTeamEvent | null;
  readonly now: string;
}

export interface TaskListOptions {
  readonly limit?: number;
  readonly offset?: number;
  readonly status?: TaskStatus;
}

export interface TaskPage {
  readonly items: readonly Task[];
  readonly total: number;
}

export interface MessagePage {
  readonly items: readonly TeamMessage[];
  readonly total: number;
}

export interface Integration {
  readonly id: string;
  readonly teamId: string;
  readonly runId: string;
  readonly taskId: string | null;
  readonly baseVersion: string;
  readonly candidateHash: string;
  readonly status:
    | 'candidate'
    | 'conflict'
    | 'resolved'
    | 'verified'
    | 'published'
    | 'failed';
  readonly conflicts: readonly string[];
  readonly baseHashes: Readonly<Record<string, string>>;
  readonly resultHashes: Readonly<Record<string, string>>;
  readonly verification: Readonly<Record<string, unknown>> | null;
  readonly journal: readonly IntegrationJournalEntry[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly publishedAt: string | null;
}

export interface IntegrationJournalEntry {
  readonly at: string;
  readonly action: 'created' | 'resolved' | 'verified' | 'publish-start' | 'published' | 'rolled-back' | 'failed';
  readonly files?: readonly string[];
  readonly applied?: readonly string[];
  readonly detail?: string;
}

export interface CreateIntegrationInput {
  readonly integration: Integration;
  readonly event?: NewTeamEvent | null;
}

export interface UpdateIntegrationInput {
  readonly integrationId: string;
  readonly patch: Partial<
    Pick<
      Integration,
      'status' | 'conflicts' | 'resultHashes' | 'verification' | 'journal' | 'publishedAt'
    >
  >;
  readonly event?: NewTeamEvent | null;
  readonly now: string;
}

export interface TeamStore {
  // ----------------------------------------------------------------- teams ---
  createTeam(input: CreateTeamInput): Promise<Team>;
  getTeam(id: string): Promise<Team | null>;
  getTeamForRoot(ownerId: string, rootConversationId: string): Promise<Team | null>;
  listTeams(ownerId: string): Promise<Team[]>;
  /** Null means the expected revision did not match; the caller re-reads. */
  updateTeam(input: UpdateTeamInput): Promise<Team | null>;

  // ------------------------------------------------------------------ runs ---
  createRun(input: CreateRunInput): Promise<CreateRunResult>;
  getRun(id: string): Promise<TeamRun | null>;
  listRuns(teamId: string, limit?: number): Promise<TeamRun[]>;
  activeRunForRoot(ownerId: string, rootConversationId: string): Promise<TeamRun | null>;
  transitionRun(
    runId: string,
    from: readonly TeamRunStatus[],
    patch: RunPatch,
    event?: NewTeamEvent | null,
    now?: string,
  ): Promise<TeamRun | null>;

  // --------------------------------------------------------------- members ---
  createMember(input: CreateMemberInput): Promise<Member>;
  getMember(id: string): Promise<Member | null>;
  listMembers(teamId: string): Promise<Member[]>;
  countMembers(teamId: string): Promise<number>;
  updateMember(id: string, patch: UpdateMemberPatch, event?: NewTeamEvent | null): Promise<Member | null>;

  // ----------------------------------------------------------- activations ---
  createActivation(input: CreateActivationInput): Promise<Activation>;
  getActivation(id: string): Promise<Activation | null>;
  listActivations(runId: string, memberId?: string): Promise<Activation[]>;
  countActivations(runId: string): Promise<number>;
  updateActivation(
    id: string,
    from: readonly ActivationStatus[],
    patch: UpdateActivationPatch,
    event?: NewTeamEvent | null,
    now?: string,
  ): Promise<Activation | null>;
  /** The oldest queued activation for a member, if any. */
  nextQueuedActivation(memberId: string): Promise<Activation | null>;
  /** Running activations whose lease has passed, for recovery. */
  expiredActivations(now: string): Promise<Activation[]>;
  /** All activations a restart must reconcile, regardless of lease clock. */
  runningActivations(): Promise<Activation[]>;

  // ----------------------------------------------------------------- tasks ---
  createTask(input: CreateTaskInput): Promise<Task>;
  getTask(id: string): Promise<Task | null>;
  listTasks(runId: string, options?: TaskListOptions): Promise<TaskPage>;
  listTasksByIds(runId: string, ids: readonly string[]): Promise<Task[]>;
  countTasks(runId: string): Promise<number>;
  updateTask(input: UpdateTaskInput): Promise<CasResult<Task>>;
  claimTask(input: ClaimTaskInput): Promise<CasResult<ClaimTaskValue>>;
  submitTask(input: SubmitTaskInput): Promise<CasResult<SubmitTaskValue>>;
  reviewTask(input: ReviewTaskInput): Promise<CasResult<ReviewTaskValue>>;
  getAttempt(id: string): Promise<TaskAttempt | null>;
  listAttempts(taskId: string): Promise<TaskAttempt[]>;
  findAttemptByActivation(activationId: string): Promise<TaskAttempt | null>;

  // -------------------------------------------------------------- messages ---
  appendMessage(input: AppendMessageInput): Promise<AppendMessageValue>;
  listMessages(runId: string, afterSequence?: number, limit?: number): Promise<MessagePage>;
  /** Messages accepted but not yet injected, oldest first. */
  pendingMessages(recipientId: string, limit?: number): Promise<TeamMessage[]>;
  getMessage(id: string): Promise<TeamMessage | null>;
  markMessage(
    id: string,
    from: readonly TeamMessage['state'][],
    patch: {
      readonly state: TeamMessage['state'];
      readonly injectedAt?: string | null;
      readonly processedAt?: string | null;
      readonly activationId?: string | null;
      readonly error?: string | null;
    },
    event?: NewTeamEvent | null,
    now?: string,
  ): Promise<TeamMessage | null>;

  // ------------------------------------------------------------- artifacts ---
  createArtifact(input: CreateArtifactInput): Promise<Artifact>;
  getArtifact(id: string): Promise<Artifact | null>;
  listArtifacts(filter: {
    readonly runId?: string;
    readonly taskId?: string;
    readonly attemptId?: string;
    readonly limit?: number;
  }): Promise<Artifact[]>;

  // ----------------------------------------------------------- integration ---
  createIntegration(input: CreateIntegrationInput): Promise<Integration>;
  getIntegration(id: string): Promise<Integration | null>;
  listIntegrations(runId: string): Promise<Integration[]>;
  updateIntegration(input: UpdateIntegrationInput): Promise<Integration | null>;

  // ---------------------------------------------------------------- events ---
  appendEvent(teamId: string, runId: string, event: NewTeamEvent, now?: string): Promise<TeamEvent>;
  listEvents(runId: string, afterSequence: number, limit?: number): Promise<TeamEvent[]>;
  latestEventSequence(runId: string): Promise<number>;

  // ---------------------------------------------------------------- budget ---
  reserveBudget(input: ReserveBudgetInput): Promise<BudgetReservation>;
  settleBudget(input: SettleBudgetInput): Promise<BudgetEntry | null>;
  budgetSnapshot(runId: string): Promise<BudgetSnapshot>;
  listBudgetEntries(runId: string): Promise<BudgetEntry[]>;
  /** Usage summed for a whole run, including requests that reported nothing. */
  runUsage(runId: string): Promise<UsageTotals>;

  ping(): Promise<boolean>;
  close(): Promise<void>;
}

/** The statuses that mean "this run is still the active one for its root". */
export const ACTIVE_RUN_STATUSES: readonly TeamRunStatus[] = [
  'queued',
  'running',
  'pausing',
  'paused',
  'waiting_user',
  'stopping',
  'needs_reconciliation',
];

export type { TaskSubmission, TaskReview };
