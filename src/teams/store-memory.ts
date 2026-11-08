/**
 * The in-memory `TeamStore`.
 *
 * This is the reference implementation of the contract in `store.ts`: the
 * behavioural cases run against it first, and `store-sqlite.ts` has to agree
 * with it. Two properties matter and are enforced everywhere below:
 *
 *   - **No shared mutable state.** Every value goes in and comes out through
 *     `structuredClone`, so a caller that mutates a returned `Task` cannot
 *     rewrite the store, and two reads never share an object.
 *   - **No await between read and write.** Every mutation is a single
 *     synchronous block. JavaScript runs it to completion before another
 *     task can interleave, which is what makes `reserveBudget`,
 *     `appendMessage` and `appendEvent` atomic here without locks.
 *
 * Times are ISO-8601 strings supplied by the caller wherever the store's own
 * clock is not the authority. The store never invents a timestamp that a caller
 * already decided on.
 */

import { randomUUID } from 'node:crypto';
import { ACTIVE_RUN_STATUSES } from './store.ts';
import type {
  AppendMessageInput,
  AppendMessageValue,
  CasResult,
  ClaimTaskInput,
  ClaimTaskValue,
  CreateActivationInput,
  CreateArtifactInput,
  CreateIntegrationInput,
  CreateMemberInput,
  CreateRunInput,
  CreateRunResult,
  CreateTaskInput,
  CreateTeamInput,
  Integration,
  MessagePage,
  ReserveBudgetInput,
  ReviewTaskInput,
  ReviewTaskValue,
  RunPatch,
  SettleBudgetInput,
  SubmitTaskInput,
  SubmitTaskValue,
  TaskListOptions,
  TaskPage,
  TeamStore,
  UpdateActivationPatch,
  UpdateIntegrationInput,
  UpdateMemberPatch,
  UpdateTaskInput,
  UpdateTeamInput,
} from './store.ts';
import { isTerminalActivation, isTerminalRunStatus, TeamError } from './types.ts';
import type {
  Activation,
  ActivationStatus,
  Artifact,
  BudgetEntry,
  BudgetReservation,
  BudgetSnapshot,
  Member,
  NewTeamEvent,
  Task,
  TaskAttempt,
  Team,
  TeamEvent,
  TeamMessage,
  TeamRun,
  TeamRunStatus,
  UsageTotals,
} from './types.ts';

const DEFAULT_PAGE = 100;

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * The aggregate budget view over a set of entries.
 *
 * Conservative by construction: an entry counts as *reserved* until it is
 * settled, and an entry settled as `incomplete` keeps its reservation because
 * the provider never told us what it actually used. Only a `released` entry
 * stops counting.
 *
 * The same arithmetic is implemented in `store-sqlite.ts`; the contract tests
 * assert that the two agree, including the incomplete case.
 */
function snapshotFor(limits: TeamRun['budget'], entries: Iterable<BudgetEntry>): BudgetSnapshot {
  let reservedInputTokens = 0;
  let reservedOutputTokens = 0;
  let settledInputTokens = 0;
  let settledOutputTokens = 0;
  let reservedRequests = 0;
  let settledRequests = 0;
  let estimatedCostUsd = 0;
  let incompleteEntries = 0;

  for (const entry of entries) {
    if (entry.status === 'released') continue;
    estimatedCostUsd += entry.estimatedCostUsd ?? 0;
    if (entry.status === 'settled') {
      settledInputTokens += entry.inputTokens ?? 0;
      settledOutputTokens += entry.outputTokens ?? 0;
      settledRequests += 1;
      continue;
    }
    // `reserved` and `incomplete` both hold their reservation: the first has
    // not answered yet, the second will never answer.
    reservedInputTokens += entry.reservedInputTokens;
    reservedOutputTokens += entry.reservedOutputTokens;
    reservedRequests += 1;
    if (entry.status === 'incomplete') incompleteEntries += 1;
  }

  const remainingInputTokens = limits.maxInputTokens - settledInputTokens - reservedInputTokens;
  const remainingOutputTokens = limits.maxOutputTokens - settledOutputTokens - reservedOutputTokens;
  const remainingRequests = limits.maxRequests - settledRequests - reservedRequests;
  const costExceeded =
    limits.maxEstimatedCostUsd !== null && estimatedCostUsd > limits.maxEstimatedCostUsd;

  return {
    limits: { ...limits },
    reservedInputTokens,
    reservedOutputTokens,
    settledInputTokens,
    settledOutputTokens,
    reservedRequests,
    settledRequests,
    estimatedCostUsd,
    incompleteEntries,
    remainingInputTokens,
    remainingOutputTokens,
    remainingRequests,
    exhausted:
      remainingInputTokens <= 0 ||
      remainingOutputTokens <= 0 ||
      remainingRequests <= 0 ||
      costExceeded,
  };
}

export class MemoryTeamStore implements TeamStore {
  readonly #teams = new Map<string, Team>();
  readonly #runs = new Map<string, TeamRun>();
  readonly #members = new Map<string, Member>();
  readonly #activations = new Map<string, Activation>();
  readonly #tasks = new Map<string, Task>();
  readonly #attempts = new Map<string, TaskAttempt>();
  readonly #messages = new Map<string, TeamMessage>();
  readonly #artifacts = new Map<string, Artifact>();
  readonly #events = new Map<string, TeamEvent[]>();
  readonly #budget = new Map<string, BudgetEntry>();
  readonly #integrations = new Map<string, Integration>();

  // ----------------------------------------------------------------- teams ---

  async createTeam(input: CreateTeamInput): Promise<Team> {
    // A team is keyed by its root conversation. A retried request that carries
    // a fresh id must still land on the existing team, or a client retry would
    // fork a second team with its own config.
    const existing =
      this.#teamForRoot(input.ownerId, input.rootConversationId) ?? this.#teams.get(input.id);
    if (existing) return clone(existing);

    const team: Team = {
      id: input.id,
      ownerId: input.ownerId,
      rootConversationId: input.rootConversationId,
      enabled: input.enabled,
      configRevision: 1,
      config: clone(input.config),
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.#teams.set(team.id, team);
    return clone(team);
  }

  async getTeam(id: string): Promise<Team | null> {
    const team = this.#teams.get(id);
    return team ? clone(team) : null;
  }

  async getTeamForRoot(ownerId: string, rootConversationId: string): Promise<Team | null> {
    const team = this.#teamForRoot(ownerId, rootConversationId);
    return team ? clone(team) : null;
  }

  async listTeams(ownerId: string): Promise<Team[]> {
    return [...this.#teams.values()]
      .filter((team) => team.ownerId === ownerId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(clone);
  }

  async updateTeam(input: UpdateTeamInput): Promise<Team | null> {
    const current = this.#teams.get(input.id);
    if (!current) return null;
    if (current.configRevision !== input.expectedRevision) return null;
    const next: Team = {
      ...current,
      enabled: input.enabled,
      config: clone(input.config),
      configRevision: current.configRevision + 1,
      updatedAt: input.now,
    };
    this.#teams.set(next.id, next);
    return clone(next);
  }

  // ------------------------------------------------------------------ runs ---

  async createRun(input: CreateRunInput): Promise<CreateRunResult> {
    const byId = this.#runs.get(input.id);
    if (byId) return { run: clone(byId), created: false };

    for (const run of this.#runs.values()) {
      if (
        run.ownerId === input.ownerId &&
        run.rootConversationId === input.rootConversationId &&
        run.inputHash === input.inputHash
      ) {
        return { run: clone(run), created: false };
      }
    }

    for (const run of this.#runs.values()) {
      if (
        run.ownerId === input.ownerId &&
        run.rootConversationId === input.rootConversationId &&
        run.inputHash !== input.inputHash &&
        ACTIVE_RUN_STATUSES.includes(run.status)
      ) {
        throw new TeamError(
          'TEAM_RUN_BUSY',
          `conversation ${input.rootConversationId} already has an active run`,
          409,
          { runId: run.id, status: run.status },
        );
      }
    }

    const run: TeamRun = {
      id: input.id,
      teamId: input.teamId,
      ownerId: input.ownerId,
      rootConversationId: input.rootConversationId,
      rootTurnId: input.rootTurnId,
      rootRequestId: input.rootRequestId,
      inputHash: input.inputHash,
      status: 'queued',
      budget: clone(input.budget),
      rootMemberId: null,
      reason: null,
      createdAt: input.now,
      updatedAt: input.now,
      finishedAt: null,
    };
    this.#runs.set(run.id, run);
    return { run: clone(run), created: true };
  }

  async getRun(id: string): Promise<TeamRun | null> {
    const run = this.#runs.get(id);
    return run ? clone(run) : null;
  }

  async listRuns(teamId: string, limit = 50): Promise<TeamRun[]> {
    return [...this.#runs.values()]
      .filter((run) => run.teamId === teamId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map(clone);
  }

  async activeRunForRoot(ownerId: string, rootConversationId: string): Promise<TeamRun | null> {
    const run = [...this.#runs.values()]
      .filter(
        (candidate) =>
          candidate.ownerId === ownerId &&
          candidate.rootConversationId === rootConversationId &&
          ACTIVE_RUN_STATUSES.includes(candidate.status),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    return run ? clone(run) : null;
  }

  async transitionRun(
    runId: string,
    from: readonly TeamRunStatus[],
    patch: RunPatch,
    event?: NewTeamEvent | null,
    now?: string,
  ): Promise<TeamRun | null> {
    const current = this.#runs.get(runId);
    if (!current) return null;
    // The caller states which statuses it is willing to move from; anything
    // else is a stale view and gets the current row, not an exception.
    if (!from.includes(current.status)) return null;

    const at = now ?? new Date().toISOString();
    const status = patch.status ?? current.status;
    const enteringTerminal = status !== current.status && isTerminalRunStatus(status);
    const finishedAt =
      patch.finishedAt !== undefined
        ? patch.finishedAt
        : enteringTerminal && current.finishedAt === null
          ? at
          : current.finishedAt;

    const next: TeamRun = {
      ...current,
      status,
      rootMemberId: patch.rootMemberId !== undefined ? patch.rootMemberId : current.rootMemberId,
      reason: patch.reason !== undefined ? patch.reason : current.reason,
      updatedAt: at,
      finishedAt,
    };
    this.#runs.set(next.id, next);
    if (event) this.#appendEventSync(next.teamId, next.id, event, at);
    return clone(next);
  }

  // --------------------------------------------------------------- members ---

  async createMember(input: CreateMemberInput): Promise<Member> {
    const byId = this.#members.get(input.member.id);
    if (byId) return clone(byId);
    // `internal_conversation_id` is UNIQUE in SQLite; keep memory identical so a
    // retry that lost the id but kept the conversation is still idempotent.
    for (const member of this.#members.values()) {
      if (member.internalConversationId === input.member.internalConversationId) {
        return clone(member);
      }
    }
    const member = clone(input.member);
    const runId = input.event ? this.#runIdForMember(member) : null;
    this.#members.set(member.id, member);
    if (input.event && runId) {
      this.#appendEventSync(member.teamId, runId, input.event, member.createdAt);
    }
    return clone(member);
  }

  async getMember(id: string): Promise<Member | null> {
    const member = this.#members.get(id);
    return member ? clone(member) : null;
  }

  async listMembers(teamId: string): Promise<Member[]> {
    return [...this.#members.values()]
      .filter((member) => member.teamId === teamId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(clone);
  }

  async countMembers(teamId: string): Promise<number> {
    let count = 0;
    for (const member of this.#members.values()) if (member.teamId === teamId) count += 1;
    return count;
  }

  async updateMember(
    id: string,
    patch: UpdateMemberPatch,
    event?: NewTeamEvent | null,
  ): Promise<Member | null> {
    const current = this.#members.get(id);
    if (!current) return null;
    const next: Member = {
      ...current,
      status: patch.status ?? current.status,
      currentActivationId:
        patch.currentActivationId !== undefined
          ? patch.currentActivationId
          : current.currentActivationId,
      closedAt: patch.closedAt !== undefined ? patch.closedAt : current.closedAt,
      error: patch.error !== undefined ? patch.error : current.error,
      updatedAt: patch.now,
    };
    // Resolve the event's run before the write so a failure leaves no state
    // change behind, matching the SQLite transaction.
    const runId = event ? this.#runIdForMember(next) : null;
    this.#members.set(next.id, next);
    if (event && runId) {
      this.#appendEventSync(next.teamId, runId, event, patch.now);
    }
    return clone(next);
  }

  // ----------------------------------------------------------- activations ---

  async createActivation(input: CreateActivationInput): Promise<Activation> {
    const activation = clone(input.activation);
    const existing = this.#activations.get(activation.id);
    if (existing) return clone(existing);

    const run = this.#runs.get(activation.runId);
    if (!run) {
      throw new TeamError(
        'TEAM_RUN_NOT_FOUND',
        `run ${activation.runId} not found`,
        404,
      );
    }

    const count = this.#countActivationsUnsafe(activation.runId);
    if (count >= input.maxActivations) {
      throw new TeamError(
        'TEAM_ACTIVATION_LIMIT',
        `run ${activation.runId} already has ${count} activations`,
        409,
        { runId: activation.runId, count, max: input.maxActivations },
      );
    }
    if (
      activation.status === 'running' &&
      this.#runningActivationFor(activation.memberId) !== undefined
    ) {
      throw new TeamError(
        'TEAM_ACTIVATION_CONFLICT',
        `member ${activation.memberId} already has a running activation`,
        409,
        { memberId: activation.memberId },
      );
    }

    this.#activations.set(activation.id, activation);
    if (input.event) {
      this.#appendEventSync(run.teamId, activation.runId, input.event, activation.createdAt);
    }
    return clone(activation);
  }

  async getActivation(id: string): Promise<Activation | null> {
    const activation = this.#activations.get(id);
    return activation ? clone(activation) : null;
  }

  async listActivations(runId: string, memberId?: string): Promise<Activation[]> {
    return [...this.#activations.values()]
      .filter(
        (activation) =>
          activation.runId === runId &&
          (memberId === undefined || activation.memberId === memberId),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(clone);
  }

  async countActivations(runId: string): Promise<number> {
    return this.#countActivationsUnsafe(runId);
  }

  async updateActivation(
    id: string,
    from: readonly ActivationStatus[],
    patch: UpdateActivationPatch,
    event?: NewTeamEvent | null,
    now?: string,
  ): Promise<Activation | null> {
    const current = this.#activations.get(id);
    if (!current) return null;
    if (!from.includes(current.status)) return null;

    const at = now ?? new Date().toISOString();
    const status = patch.status ?? current.status;
    const enteringTerminal = status !== current.status && isTerminalActivation(status);
    const finishedAt =
      patch.finishedAt !== undefined
        ? patch.finishedAt
        : enteringTerminal && current.finishedAt === null
          ? at
          : current.finishedAt;

    if (status === 'running' && current.status !== 'running') {
      const running = this.#runningActivationFor(current.memberId);
      // The unique index is the real guard in SQLite; memory must reject the
      // same call instead of silently creating two running activations.
      if (running !== undefined && running.id !== current.id) {
        throw new TeamError(
          'TEAM_ACTIVATION_CONFLICT',
          `member ${current.memberId} already has a running activation`,
          409,
          { memberId: current.memberId },
        );
      }
    }

    const next: Activation = {
      ...current,
      status,
      checkpoint: patch.checkpoint !== undefined ? clone(patch.checkpoint) : current.checkpoint,
      result: patch.result !== undefined ? clone(patch.result) : current.result,
      error: patch.error !== undefined ? patch.error : current.error,
      startedAt: patch.startedAt !== undefined ? patch.startedAt : current.startedAt,
      finishedAt,
      leaseExpiresAt:
        patch.leaseExpiresAt !== undefined ? patch.leaseExpiresAt : current.leaseExpiresAt,
      generation: patch.generation !== undefined ? patch.generation : current.generation,
    };
    this.#activations.set(next.id, next);
    if (event) {
      const run = this.#runs.get(next.runId);
      if (!run) throw new TeamError('TEAM_RUN_NOT_FOUND', `run ${next.runId} not found`, 404);
      this.#appendEventSync(run.teamId, next.runId, event, at);
    }
    return clone(next);
  }

  async nextQueuedActivation(memberId: string): Promise<Activation | null> {
    const queued = [...this.#activations.values()]
      .filter((activation) => activation.memberId === memberId && activation.status === 'queued')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
    return queued ? clone(queued) : null;
  }

  async expiredActivations(now: string): Promise<Activation[]> {
    return [...this.#activations.values()]
      .filter(
        (activation) =>
          activation.status === 'running' &&
          activation.leaseExpiresAt !== null &&
          activation.leaseExpiresAt <= now,
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(clone);
  }

  async runningActivations(): Promise<Activation[]> {
    return [...this.#activations.values()]
      .filter((activation) => activation.status === 'running' || activation.status === 'waiting')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(clone);
  }

  // ----------------------------------------------------------------- tasks ---

  async createTask(input: CreateTaskInput): Promise<Task> {
    const task = clone(input.task);
    const existing = this.#tasks.get(task.id);
    if (existing) return clone(existing);

    const run = this.#runs.get(task.runId);
    if (!run) throw new TeamError('TEAM_RUN_NOT_FOUND', `run ${task.runId} not found`, 404);

    const count = this.#countTasksUnsafe(task.runId);
    if (count >= input.maxTasks) {
      throw new TeamError(
        'TEAM_TASK_LIMIT',
        `run ${task.runId} already has ${count} tasks`,
        409,
        { runId: task.runId, count, max: input.maxTasks },
      );
    }

    this.#tasks.set(task.id, task);
    if (input.event) this.#appendEventSync(task.teamId, task.runId, input.event, task.createdAt);
    return clone(task);
  }

  async getTask(id: string): Promise<Task | null> {
    const task = this.#tasks.get(id);
    return task ? clone(task) : null;
  }

  async listTasks(runId: string, options?: TaskListOptions): Promise<TaskPage> {
    const status = options?.status;
    const matching = [...this.#tasks.values()]
      .filter((task) => task.runId === runId && (status === undefined || task.status === status))
      // Stable, so equal timestamps keep insertion order — the same order the
      // SQLite query gets from `rowid`.
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const offset = Math.max(0, options?.offset ?? 0);
    const limit = Math.max(0, options?.limit ?? DEFAULT_PAGE);
    return {
      items: matching.slice(offset, offset + limit).map(clone),
      total: matching.length,
    };
  }

  async listTasksByIds(runId: string, ids: readonly string[]): Promise<Task[]> {
    const found: Task[] = [];
    for (const id of ids) {
      const task = this.#tasks.get(id);
      if (task && task.runId === runId) found.push(clone(task));
    }
    return found;
  }

  async countTasks(runId: string): Promise<number> {
    return this.#countTasksUnsafe(runId);
  }

  async updateTask(input: UpdateTaskInput): Promise<CasResult<Task>> {
    const current = this.#tasks.get(input.taskId);
    if (!current) throw new TeamError('TEAM_TASK_NOT_FOUND', `task ${input.taskId} not found`, 404);
    if (current.revision !== input.expectedRevision) {
      return { ok: false, current: clone(current) };
    }

    const patch = input.patch;
    const next: Task = {
      ...current,
      title: patch.title ?? current.title,
      specification: patch.specification ?? current.specification,
      acceptance: patch.acceptance ?? current.acceptance,
      required: patch.required !== undefined ? patch.required : current.required,
      dependencies:
        patch.dependencies !== undefined ? [...patch.dependencies] : current.dependencies,
      ownerId: patch.ownerId !== undefined ? patch.ownerId : current.ownerId,
      status: patch.status ?? current.status,
      writeScopes: patch.writeScopes !== undefined ? [...patch.writeScopes] : current.writeScopes,
      failureReason:
        patch.failureReason !== undefined ? patch.failureReason : current.failureReason,
      submittedAt: patch.submittedAt !== undefined ? patch.submittedAt : current.submittedAt,
      acceptedAt: patch.acceptedAt !== undefined ? patch.acceptedAt : current.acceptedAt,
      currentAttemptId:
        patch.currentAttemptId !== undefined ? patch.currentAttemptId : current.currentAttemptId,
      revision: current.revision + 1,
      updatedAt: input.now,
    };
    this.#tasks.set(next.id, next);
    if (input.event) this.#appendEventSync(next.teamId, next.runId, input.event, input.now);
    return { ok: true, value: clone(next) };
  }

  async claimTask(input: ClaimTaskInput): Promise<CasResult<ClaimTaskValue>> {
    const current = this.#tasks.get(input.taskId);
    if (!current) throw new TeamError('TEAM_TASK_NOT_FOUND', `task ${input.taskId} not found`, 404);
    if (current.revision !== input.expectedRevision || current.status !== 'pending') {
      return { ok: false, current: clone(current) };
    }

    const attempt: TaskAttempt = {
      id: `att_${randomUUID()}`,
      taskId: current.id,
      activationId: input.activationId,
      generation: input.generation,
      leaseExpiresAt: input.leaseExpiresAt,
      baselineId: input.baselineId,
      submission: null,
      review: null,
      createdAt: input.now,
      updatedAt: input.now,
    };
    const task: Task = {
      ...current,
      revision: current.revision + 1,
      status: 'running',
      ownerId: input.memberId,
      currentAttemptId: attempt.id,
      updatedAt: input.now,
    };
    this.#attempts.set(attempt.id, attempt);
    this.#tasks.set(task.id, task);
    if (input.event) this.#appendEventSync(task.teamId, task.runId, input.event, input.now);
    return { ok: true, value: { task: clone(task), attempt: clone(attempt) } };
  }

  async submitTask(input: SubmitTaskInput): Promise<CasResult<SubmitTaskValue>> {
    const current = this.#tasks.get(input.taskId);
    if (!current) throw new TeamError('TEAM_TASK_NOT_FOUND', `task ${input.taskId} not found`, 404);
    if (
      current.revision !== input.expectedRevision ||
      current.status !== 'running' ||
      current.currentAttemptId !== input.attemptId
    ) {
      return { ok: false, current: clone(current) };
    }
    const attempt = this.#attempts.get(input.attemptId);
    // A running task whose attempt row vanished is a corrupt state, not a
    // success: the caller gets the task back and re-reads the attempt.
    if (!attempt || attempt.taskId !== current.id) {
      return { ok: false, current: clone(current) };
    }

    const nextAttempt: TaskAttempt = {
      ...attempt,
      submission: clone(input.submission),
      updatedAt: input.now,
    };
    const task: Task = {
      ...current,
      status: 'submitted',
      revision: current.revision + 1,
      submittedAt: input.submission.submittedAt,
      updatedAt: input.now,
    };
    this.#attempts.set(nextAttempt.id, nextAttempt);
    this.#tasks.set(task.id, task);
    if (input.event) this.#appendEventSync(task.teamId, task.runId, input.event, input.now);
    return { ok: true, value: { task: clone(task), attempt: clone(nextAttempt) } };
  }

  async reviewTask(input: ReviewTaskInput): Promise<CasResult<ReviewTaskValue>> {
    const current = this.#tasks.get(input.taskId);
    if (!current) throw new TeamError('TEAM_TASK_NOT_FOUND', `task ${input.taskId} not found`, 404);
    if (
      current.revision !== input.expectedRevision ||
      current.status !== 'submitted' ||
      current.currentAttemptId !== input.attemptId
    ) {
      return { ok: false, current: clone(current) };
    }
    const attempt = this.#attempts.get(input.attemptId);
    if (!attempt || attempt.taskId !== current.id) {
      return { ok: false, current: clone(current) };
    }

    const accepted = input.review.decision === 'accepted';
    const nextAttempt: TaskAttempt = {
      ...attempt,
      review: clone(input.review),
      updatedAt: input.now,
    };
    // A rejection sends the task back to `pending` and clears the pointer, but
    // keeps the attempt: the next worker needs to see why the last one failed.
    const task: Task = {
      ...current,
      status: accepted ? 'accepted' : 'pending',
      revision: current.revision + 1,
      acceptedAt: accepted ? input.review.reviewedAt : current.acceptedAt,
      currentAttemptId: accepted ? current.currentAttemptId : null,
      updatedAt: input.now,
    };
    this.#attempts.set(nextAttempt.id, nextAttempt);
    this.#tasks.set(task.id, task);
    if (input.event) this.#appendEventSync(task.teamId, task.runId, input.event, input.now);
    return { ok: true, value: { task: clone(task), attempt: clone(nextAttempt) } };
  }

  async getAttempt(id: string): Promise<TaskAttempt | null> {
    const attempt = this.#attempts.get(id);
    return attempt ? clone(attempt) : null;
  }

  async listAttempts(taskId: string): Promise<TaskAttempt[]> {
    return [...this.#attempts.values()]
      .filter((attempt) => attempt.taskId === taskId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(clone);
  }

  async findAttemptByActivation(activationId: string): Promise<TaskAttempt | null> {
    for (const attempt of this.#attempts.values()) {
      if (attempt.activationId === activationId) return clone(attempt);
    }
    return null;
  }

  // -------------------------------------------------------------- messages ---

  async appendMessage(input: AppendMessageInput): Promise<AppendMessageValue> {
    const incoming = input.message;
    const existing = this.#messageByKey(
      incoming.senderId,
      incoming.recipientId,
      incoming.clientMessageId,
    );
    if (existing) {
      if (existing.body !== incoming.body) {
        throw new TeamError(
          'TEAM_MESSAGE_CONFLICT',
          'the same message key was already used with a different body',
          409,
          { messageId: existing.id },
        );
      }
      return { message: clone(existing), duplicate: true };
    }

    if (!this.#runs.has(incoming.runId)) {
      throw new TeamError('TEAM_RUN_NOT_FOUND', `run ${incoming.runId} not found`, 404);
    }

    let runCount = 0;
    let queuedForRecipient = 0;
    for (const message of this.#messages.values()) {
      if (message.runId === incoming.runId) runCount += 1;
      if (message.recipientId === incoming.recipientId && message.state === 'accepted') {
        queuedForRecipient += 1;
      }
    }
    if (runCount >= input.maxMessages) {
      throw new TeamError(
        'TEAM_MESSAGE_LIMIT',
        `run ${incoming.runId} already has ${runCount} messages`,
        409,
        { runId: incoming.runId, count: runCount, max: input.maxMessages },
      );
    }
    if (queuedForRecipient >= input.maxQueuedPerMember) {
      throw new TeamError(
        'TEAM_MESSAGE_LIMIT',
        `member ${incoming.recipientId} already has ${queuedForRecipient} queued messages`,
        409,
        {
          recipientId: incoming.recipientId,
          queued: queuedForRecipient,
          max: input.maxQueuedPerMember,
        },
      );
    }

    const message: TeamMessage = {
      ...clone(incoming),
      sequence: this.#nextMessageSequence(incoming.runId),
    };
    this.#messages.set(message.id, message);
    if (input.event) {
      this.#appendEventSync(message.teamId, message.runId, input.event, message.createdAt);
    }
    return { message: clone(message), duplicate: false };
  }

  async listMessages(runId: string, afterSequence = 0, limit = DEFAULT_PAGE): Promise<MessagePage> {
    const matching = [...this.#messages.values()]
      .filter((message) => message.runId === runId && message.sequence > afterSequence)
      .sort((left, right) => left.sequence - right.sequence);
    return { items: matching.slice(0, limit).map(clone), total: matching.length };
  }

  async pendingMessages(recipientId: string, limit = DEFAULT_PAGE): Promise<TeamMessage[]> {
    return [...this.#messages.values()]
      .filter((message) => message.recipientId === recipientId && message.state === 'accepted')
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.sequence - right.sequence,
      )
      .slice(0, limit)
      .map(clone);
  }

  async getMessage(id: string): Promise<TeamMessage | null> {
    const message = this.#messages.get(id);
    return message ? clone(message) : null;
  }

  async markMessage(
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
  ): Promise<TeamMessage | null> {
    const current = this.#messages.get(id);
    if (!current) return null;
    if (!from.includes(current.state)) return null;

    const at = now ?? new Date().toISOString();
    const next: TeamMessage = {
      ...current,
      state: patch.state,
      injectedAt:
        patch.injectedAt !== undefined
          ? patch.injectedAt
          : patch.state === 'injected' && current.injectedAt === null
            ? at
            : current.injectedAt,
      processedAt:
        patch.processedAt !== undefined
          ? patch.processedAt
          : patch.state === 'processed' && current.processedAt === null
            ? at
            : current.processedAt,
      activationId: patch.activationId !== undefined ? patch.activationId : current.activationId,
      error: patch.error !== undefined ? patch.error : current.error,
    };
    this.#messages.set(next.id, next);
    if (event) this.#appendEventSync(next.teamId, next.runId, event, at);
    return clone(next);
  }

  // ------------------------------------------------------------- artifacts ---

  async createArtifact(input: CreateArtifactInput): Promise<Artifact> {
    const artifact = clone(input.artifact);
    const existing = this.#artifacts.get(artifact.id);
    if (existing) return clone(existing);
    if (!this.#runs.has(artifact.runId)) {
      throw new TeamError('TEAM_RUN_NOT_FOUND', `run ${artifact.runId} not found`, 404);
    }
    this.#artifacts.set(artifact.id, artifact);
    if (input.event) {
      this.#appendEventSync(artifact.teamId, artifact.runId, input.event, artifact.createdAt);
    }
    return clone(artifact);
  }

  async getArtifact(id: string): Promise<Artifact | null> {
    const artifact = this.#artifacts.get(id);
    return artifact ? clone(artifact) : null;
  }

  async listArtifacts(filter: {
    readonly runId?: string;
    readonly taskId?: string;
    readonly attemptId?: string;
    readonly limit?: number;
  }): Promise<Artifact[]> {
    const limit = filter.limit ?? DEFAULT_PAGE;
    return [...this.#artifacts.values()]
      .filter(
        (artifact) =>
          (filter.runId === undefined || artifact.runId === filter.runId) &&
          (filter.taskId === undefined || artifact.taskId === filter.taskId) &&
          (filter.attemptId === undefined || artifact.attemptId === filter.attemptId),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, limit)
      .map(clone);
  }

  // ----------------------------------------------------------- integration ---

  async createIntegration(input: CreateIntegrationInput): Promise<Integration> {
    const integration = clone(input.integration);
    const existing = this.#integrations.get(integration.id);
    if (existing) return clone(existing);
    if (!this.#runs.has(integration.runId)) {
      throw new TeamError('TEAM_RUN_NOT_FOUND', `run ${integration.runId} not found`, 404);
    }
    this.#integrations.set(integration.id, integration);
    if (input.event) {
      this.#appendEventSync(
        integration.teamId,
        integration.runId,
        input.event,
        integration.createdAt,
      );
    }
    return clone(integration);
  }

  async getIntegration(id: string): Promise<Integration | null> {
    const integration = this.#integrations.get(id);
    return integration ? clone(integration) : null;
  }

  async listIntegrations(runId: string): Promise<Integration[]> {
    return [...this.#integrations.values()]
      .filter((integration) => integration.runId === runId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(clone);
  }

  async updateIntegration(input: UpdateIntegrationInput): Promise<Integration | null> {
    const current = this.#integrations.get(input.integrationId);
    if (!current) return null;
    const patch = input.patch;
    const status = patch.status ?? current.status;
    const next: Integration = {
      ...current,
      status,
      conflicts: patch.conflicts !== undefined ? [...patch.conflicts] : current.conflicts,
      resultHashes:
        patch.resultHashes !== undefined ? clone(patch.resultHashes) : current.resultHashes,
      verification:
        patch.verification !== undefined ? clone(patch.verification) : current.verification,
      journal: patch.journal !== undefined ? clone(patch.journal) : current.journal,
      publishedAt:
        patch.publishedAt !== undefined
          ? patch.publishedAt
          : status === 'published' && current.publishedAt === null
            ? input.now
            : current.publishedAt,
      updatedAt: input.now,
    };
    this.#integrations.set(next.id, next);
    if (input.event) this.#appendEventSync(next.teamId, next.runId, input.event, input.now);
    return clone(next);
  }

  // ---------------------------------------------------------------- events ---

  async appendEvent(
    teamId: string,
    runId: string,
    event: NewTeamEvent,
    now?: string,
  ): Promise<TeamEvent> {
    return clone(this.#appendEventSync(teamId, runId, event, now));
  }

  async listEvents(
    runId: string,
    afterSequence: number,
    limit = DEFAULT_PAGE,
  ): Promise<TeamEvent[]> {
    return (this.#events.get(runId) ?? [])
      .filter((event) => event.sequence > afterSequence)
      .slice(0, limit)
      .map(clone);
  }

  async latestEventSequence(runId: string): Promise<number> {
    const events = this.#events.get(runId);
    const last = events?.at(-1);
    return last ? last.sequence : 0;
  }

  // ---------------------------------------------------------------- budget ---

  async reserveBudget(input: ReserveBudgetInput): Promise<BudgetReservation> {
    // Deliberately synchronous from the first read to the last write: a second
    // caller cannot observe the same remaining balance.
    const run = this.#runs.get(input.runId);
    if (!run) {
      throw new TeamError('TEAM_RUN_NOT_FOUND', `run ${input.runId} not found`, 404);
    }

    const entries = this.#entriesForRun(input.runId);
    const existing = entries.find((entry) => entry.requestKey === input.requestKey);
    if (existing) {
      return { entry: clone(existing), snapshot: clone(snapshotFor(run.budget, entries)) };
    }

    const before = snapshotFor(run.budget, entries);
    if (input.inputTokens > before.remainingInputTokens) {
      throw new TeamError(
        'TEAM_BUDGET_EXHAUSTED',
        `run ${input.runId} has ${before.remainingInputTokens} input tokens left`,
        409,
        { dimension: 'input', runId: input.runId, requested: input.inputTokens },
      );
    }
    if (input.outputTokens > before.remainingOutputTokens) {
      throw new TeamError(
        'TEAM_BUDGET_EXHAUSTED',
        `run ${input.runId} has ${before.remainingOutputTokens} output tokens left`,
        409,
        { dimension: 'output', runId: input.runId, requested: input.outputTokens },
      );
    }
    if (before.remainingRequests <= 0) {
      throw new TeamError(
        'TEAM_BUDGET_EXHAUSTED',
        `run ${input.runId} has used all ${run.budget.maxRequests} requests`,
        409,
        { dimension: 'requests', runId: input.runId },
      );
    }

    const entry: BudgetEntry = {
      id: input.id,
      runId: input.runId,
      memberId: input.memberId,
      activationId: input.activationId,
      requestKey: input.requestKey,
      generation: input.generation,
      status: 'reserved',
      reservedInputTokens: input.inputTokens,
      reservedOutputTokens: input.outputTokens,
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      estimatedCostUsd: input.estimatedCostUsd,
      priceVersion: input.priceVersion,
      createdAt: input.now,
      settledAt: null,
    };
    this.#budget.set(entry.id, entry);
    if (input.event) {
      this.#appendEventSync(run.teamId, input.runId, input.event, input.now);
    }
    return {
      entry: clone(entry),
      snapshot: clone(snapshotFor(run.budget, this.#entriesForRun(input.runId))),
    };
  }

  async settleBudget(input: SettleBudgetInput): Promise<BudgetEntry | null> {
    const current = this.#budget.get(input.entryId);
    // Only a live reservation can be settled. A second settle is a no-op that
    // returns null rather than rewriting the first answer.
    if (!current || current.status !== 'reserved') return null;
    const run = input.event ? this.#runs.get(current.runId) : undefined;
    if (input.event && !run) {
      throw new TeamError('TEAM_RUN_NOT_FOUND', `run ${current.runId} not found`, 404);
    }
    const entry: BudgetEntry = {
      ...current,
      status: input.incomplete ? 'incomplete' : 'settled',
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      cachedTokens: input.usage.cachedTokens,
      estimatedCostUsd:
        input.estimatedCostUsd !== undefined ? input.estimatedCostUsd : current.estimatedCostUsd,
      settledAt: input.now,
    };
    this.#budget.set(entry.id, entry);
    if (input.event && run) {
      this.#appendEventSync(run.teamId, entry.runId, input.event, input.now);
    }
    return clone(entry);
  }

  async budgetSnapshot(runId: string): Promise<BudgetSnapshot> {
    const run = this.#runs.get(runId);
    if (!run) throw new TeamError('TEAM_RUN_NOT_FOUND', `run ${runId} not found`, 404);
    return clone(snapshotFor(run.budget, this.#entriesForRun(runId)));
  }

  async listBudgetEntries(runId: string): Promise<BudgetEntry[]> {
    return this.#entriesForRun(runId).map(clone);
  }

  async runUsage(runId: string): Promise<UsageTotals> {
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let requests = 0;
    let measuredRequests = 0;
    let incomplete = false;

    for (const entry of this.#entriesForRun(runId)) {
      if (entry.status === 'released') continue;
      requests += 1;
      if (entry.status === 'settled') {
        inputTokens += entry.inputTokens ?? 0;
        outputTokens += entry.outputTokens ?? 0;
        cachedTokens += entry.cachedTokens ?? 0;
        if (entry.inputTokens !== null) measuredRequests += 1;
        continue;
      }
      // Unsettled and incomplete entries are charged at their reservation: a
      // run that never received usage numbers is not a free run.
      inputTokens += entry.reservedInputTokens;
      outputTokens += entry.reservedOutputTokens;
      if (entry.status === 'incomplete') incomplete = true;
    }

    return {
      inputTokens,
      outputTokens,
      cachedTokens,
      // Cache-write tokens have no column of their own yet; reporting zero is
      // honest, and `incomplete` already flags the unknowns we do track.
      cacheWriteTokens: 0,
      requests,
      measuredRequests,
      incomplete,
    };
  }

  // -------------------------------------------------------------- plumbing ---

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    // Nothing to release: the maps go with the instance.
  }

  // ------------------------------------------------------------- internals ---

  #teamForRoot(ownerId: string, rootConversationId: string): Team | undefined {
    for (const team of this.#teams.values()) {
      if (team.ownerId === ownerId && team.rootConversationId === rootConversationId) return team;
    }
    return undefined;
  }

  #runningActivationFor(memberId: string): Activation | undefined {
    for (const activation of this.#activations.values()) {
      if (activation.memberId === memberId && activation.status === 'running') return activation;
    }
    return undefined;
  }

  #countActivationsUnsafe(runId: string): number {
    let count = 0;
    for (const activation of this.#activations.values()) {
      if (activation.runId === runId) count += 1;
    }
    return count;
  }

  #countTasksUnsafe(runId: string): number {
    let count = 0;
    for (const task of this.#tasks.values()) if (task.runId === runId) count += 1;
    return count;
  }

  /**
   * Members are not scoped to a run, so a member-scoped event needs one. The
   * newest run of the member's team is the answer: a team belongs to one root
   * conversation and an active run blocks a second one (`TEAM_RUN_BUSY`), so
   * the newest run is the one being executed. If the team has no run yet there
   * is nowhere to write the event, and saying so is better than guessing.
   */
  #runIdForMember(member: Member): string {
    const run = [...this.#runs.values()]
      .filter((candidate) => candidate.teamId === member.teamId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    if (!run) {
      throw new TeamError(
        'TEAM_RUN_NOT_FOUND',
        `team ${member.teamId} has no run to attach the event to`,
        404,
      );
    }
    return run.id;
  }

  #messageByKey(
    senderId: string,
    recipientId: string,
    clientMessageId: string,
  ): TeamMessage | undefined {
    for (const message of this.#messages.values()) {
      if (
        message.senderId === senderId &&
        message.recipientId === recipientId &&
        message.clientMessageId === clientMessageId
      ) {
        return message;
      }
    }
    return undefined;
  }

  #nextMessageSequence(runId: string): number {
    let max = 0;
    for (const message of this.#messages.values()) {
      if (message.runId === runId && message.sequence > max) max = message.sequence;
    }
    return max + 1;
  }

  #entriesForRun(runId: string): BudgetEntry[] {
    return [...this.#budget.values()]
      .filter((entry) => entry.runId === runId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  /**
   * The single writer for events, shared by `appendEvent` and by every state
   * change that carries an event. Sequence assignment, idempotency and the row
   * itself happen in one synchronous step, so a state and its event cannot
   * disagree about ordering.
   */
  #appendEventSync(teamId: string, runId: string, event: NewTeamEvent, now?: string): TeamEvent {
    const list = this.#events.get(runId) ?? [];
    if (event.idempotencyKey !== undefined) {
      const existing = list.find((candidate) => candidate.idempotencyKey === event.idempotencyKey);
      if (existing) return existing;
    }
    const last = list.at(-1);
    const created: TeamEvent = {
      id: `evt_${randomUUID()}`,
      teamId,
      runId,
      sequence: last ? last.sequence + 1 : 1,
      kind: event.kind,
      payload: clone(event.payload ?? {}),
      idempotencyKey: event.idempotencyKey ?? null,
      createdAt: now ?? new Date().toISOString(),
    };
    list.push(created);
    this.#events.set(runId, list);
    return created;
  }
}
