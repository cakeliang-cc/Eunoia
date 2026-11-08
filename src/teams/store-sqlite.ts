/**
 * The SQLite implementation of `TeamStore`.
 *
 * It owns the `team_*` tables and nothing else: `TEAM_SCHEMA` is additive and
 * `IF NOT EXISTS`, so this store can be opened on a database the product store
 * already created, and vice versa.
 *
 * ## Atomicity
 *
 * `node:sqlite` is synchronous, so a transaction cannot be split by an `await`
 * even by accident. Every mutation that touches more than one row — a claim and
 * its attempt, a submit and its attempt, a message and its sequence, a budget
 * reservation and its event — runs inside `BEGIN IMMEDIATE`, which takes the
 * write lock before the first read. Two connections over the same file
 * therefore serialise on the lock, and the CAS columns (`revision`,
 * `status`, `current_attempt_id`) are repeated in the `WHERE` clause as a
 * second line of defence: `changes === 0` means "somebody else got there
 * first", never "write it anyway".
 *
 * ## Representation
 *
 * Same convention as the rest of the SQLite layer: ISO-8601 TEXT timestamps,
 * JSON TEXT, INTEGER 0/1 booleans. Row mapping stays in this file; above it
 * there are only the interfaces from `store.ts` and `types.ts`.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { StatementCache } from '../db/statements.ts';
import { TEAM_SCHEMA } from './schema.ts';
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
  UpdateTaskPatch,
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
  RunBudgetSnapshot,
  Task,
  TaskAttempt,
  Team,
  TeamEvent,
  TeamMessage,
  TeamRun,
  TeamRunStatus,
  UsageTotals,
} from './types.ts';

type SqlValue = string | number | null;

const DEFAULT_PAGE = 100;

const TEAM_COLUMNS =
  'id, owner_id, root_conversation_id, enabled, config_revision, config_json, created_at, updated_at';
const RUN_COLUMNS =
  'id, team_id, owner_id, root_conversation_id, root_turn_id, root_request_id, input_hash, status, budget_json, root_member_id, reason, created_at, updated_at, finished_at';
const MEMBER_COLUMNS =
  'id, team_id, parent_member_id, internal_conversation_id, name, role, depth, status, profile_json, permissions_json, workspace_id, workspace_mode, context_mode, fork_seq, current_activation_id, error, created_at, updated_at, closed_at';
const ACTIVATION_COLUMNS =
  'id, run_id, member_id, request_id, generation, status, checkpoint_json, input_json, result_json, error, created_at, started_at, finished_at, lease_expires_at';
const TASK_COLUMNS =
  'id, team_id, run_id, revision, title, specification, acceptance, required, dependencies_json, owner_id, status, write_scopes_json, created_by, created_at, updated_at, submitted_at, accepted_at, failure_reason, current_attempt_id';
const ATTEMPT_COLUMNS =
  'id, task_id, activation_id, generation, lease_expires_at, baseline_id, submission_json, review_json, created_at, updated_at';
const MESSAGE_COLUMNS =
  'id, team_id, run_id, sender_id, sender_kind, recipient_id, client_message_id, body, sequence, state, created_at, injected_at, processed_at, activation_id, error';
const ARTIFACT_COLUMNS =
  'id, team_id, run_id, task_id, attempt_id, member_id, kind, manifest_json, test_evidence_json, created_at';
const EVENT_COLUMNS = 'id, team_id, run_id, sequence, kind, payload_json, idempotency_key, created_at';
const BUDGET_COLUMNS =
  'id, run_id, member_id, activation_id, request_key, generation, status, reserved_input_tokens, reserved_output_tokens, input_tokens, output_tokens, cached_tokens, estimated_cost_usd, price_version, created_at, settled_at';
const INTEGRATION_COLUMNS =
  'id, team_id, run_id, task_id, base_version, candidate_hash, status, conflicts_json, base_hashes_json, result_hashes_json, verification_json, journal_json, created_at, updated_at, published_at';

// -------------------------------------------------------------------- rows ---

interface TeamRow {
  id: string;
  owner_id: string;
  root_conversation_id: string;
  enabled: number;
  config_revision: number;
  config_json: string;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  team_id: string;
  owner_id: string;
  root_conversation_id: string;
  root_turn_id: string;
  root_request_id: string;
  input_hash: string;
  status: string;
  budget_json: string;
  root_member_id: string | null;
  reason: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

interface MemberRow {
  id: string;
  team_id: string;
  parent_member_id: string | null;
  internal_conversation_id: string;
  name: string;
  role: string;
  depth: number;
  status: string;
  profile_json: string;
  permissions_json: string;
  workspace_id: string | null;
  workspace_mode: string;
  context_mode: string;
  fork_seq: number | null;
  current_activation_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

interface ActivationRow {
  id: string;
  run_id: string;
  member_id: string;
  request_id: string;
  generation: number;
  status: string;
  checkpoint_json: string;
  input_json: string;
  result_json: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  lease_expires_at: string | null;
}

interface TaskRow {
  id: string;
  team_id: string;
  run_id: string;
  revision: number;
  title: string;
  specification: string;
  acceptance: string;
  required: number;
  dependencies_json: string;
  owner_id: string | null;
  status: string;
  write_scopes_json: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  accepted_at: string | null;
  failure_reason: string | null;
  current_attempt_id: string | null;
}

interface AttemptRow {
  id: string;
  task_id: string;
  activation_id: string | null;
  generation: number;
  lease_expires_at: string | null;
  baseline_id: string | null;
  submission_json: string | null;
  review_json: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  team_id: string;
  run_id: string;
  sender_id: string;
  sender_kind: string;
  recipient_id: string;
  client_message_id: string;
  body: string;
  sequence: number;
  state: string;
  created_at: string;
  injected_at: string | null;
  processed_at: string | null;
  activation_id: string | null;
  error: string | null;
}

interface ArtifactRow {
  id: string;
  team_id: string;
  run_id: string;
  task_id: string | null;
  attempt_id: string | null;
  member_id: string;
  kind: string;
  manifest_json: string;
  test_evidence_json: string;
  created_at: string;
}

interface EventRow {
  id: string;
  team_id: string;
  run_id: string;
  sequence: number;
  kind: string;
  payload_json: string;
  idempotency_key: string | null;
  created_at: string;
}

interface BudgetRow {
  id: string;
  run_id: string;
  member_id: string;
  activation_id: string | null;
  request_key: string;
  generation: number;
  status: string;
  reserved_input_tokens: number;
  reserved_output_tokens: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  estimated_cost_usd: number | null;
  price_version: string | null;
  created_at: string;
  settled_at: string | null;
}

interface IntegrationRow {
  id: string;
  team_id: string;
  run_id: string;
  task_id: string | null;
  base_version: string;
  candidate_hash: string;
  status: string;
  conflicts_json: string;
  base_hashes_json: string;
  result_hashes_json: string;
  verification_json: string | null;
  journal_json: string;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

// ----------------------------------------------------------------- mappers ---

function readJson<T>(value: string): T {
  const parsed: unknown = JSON.parse(value);
  return parsed as T;
}

function readNullableJson<T>(value: string | null): T | null {
  return value === null ? null : readJson<T>(value);
}

function toTeam(row: TeamRow): Team {
  return {
    id: row.id,
    ownerId: row.owner_id,
    rootConversationId: row.root_conversation_id,
    enabled: Number(row.enabled) === 1,
    configRevision: Number(row.config_revision),
    config: readJson<Team['config']>(row.config_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRun(row: RunRow): TeamRun {
  return {
    id: row.id,
    teamId: row.team_id,
    ownerId: row.owner_id,
    rootConversationId: row.root_conversation_id,
    rootTurnId: row.root_turn_id,
    rootRequestId: row.root_request_id,
    inputHash: row.input_hash,
    status: row.status as TeamRunStatus,
    budget: readJson<RunBudgetSnapshot>(row.budget_json),
    rootMemberId: row.root_member_id,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

function toMember(row: MemberRow): Member {
  return {
    id: row.id,
    teamId: row.team_id,
    parentMemberId: row.parent_member_id,
    internalConversationId: row.internal_conversation_id,
    name: row.name,
    role: row.role as Member['role'],
    depth: Number(row.depth),
    status: row.status as Member['status'],
    profile: readJson<Member['profile']>(row.profile_json),
    permissions: readJson<Member['permissions']>(row.permissions_json),
    workspaceId: row.workspace_id,
    workspaceMode: row.workspace_mode as Member['workspaceMode'],
    contextMode: row.context_mode as Member['contextMode'],
    forkSeq: row.fork_seq === null ? null : Number(row.fork_seq),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    currentActivationId: row.current_activation_id,
    error: row.error,
  };
}

function toActivation(row: ActivationRow): Activation {
  return {
    id: row.id,
    runId: row.run_id,
    memberId: row.member_id,
    requestId: row.request_id,
    generation: Number(row.generation),
    status: row.status as ActivationStatus,
    checkpoint: readJson<Activation['checkpoint']>(row.checkpoint_json),
    input: readJson<Activation['input']>(row.input_json),
    result: readNullableJson<NonNullable<Activation['result']>>(row.result_json),
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    leaseExpiresAt: row.lease_expires_at,
  };
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    teamId: row.team_id,
    runId: row.run_id,
    revision: Number(row.revision),
    title: row.title,
    specification: row.specification,
    acceptance: row.acceptance,
    required: Number(row.required) === 1,
    dependencies: readJson<readonly string[]>(row.dependencies_json),
    ownerId: row.owner_id,
    status: row.status as Task['status'],
    writeScopes: readJson<readonly string[]>(row.write_scopes_json),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at,
    acceptedAt: row.accepted_at,
    failureReason: row.failure_reason,
    currentAttemptId: row.current_attempt_id,
  };
}

function toAttempt(row: AttemptRow): TaskAttempt {
  return {
    id: row.id,
    taskId: row.task_id,
    activationId: row.activation_id,
    generation: Number(row.generation),
    leaseExpiresAt: row.lease_expires_at,
    baselineId: row.baseline_id,
    submission: readNullableJson<NonNullable<TaskAttempt['submission']>>(row.submission_json),
    review: readNullableJson<NonNullable<TaskAttempt['review']>>(row.review_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row: MessageRow): TeamMessage {
  return {
    id: row.id,
    teamId: row.team_id,
    runId: row.run_id,
    senderId: row.sender_id,
    senderKind: row.sender_kind as TeamMessage['senderKind'],
    recipientId: row.recipient_id,
    clientMessageId: row.client_message_id,
    body: row.body,
    sequence: Number(row.sequence),
    state: row.state as TeamMessage['state'],
    createdAt: row.created_at,
    injectedAt: row.injected_at,
    processedAt: row.processed_at,
    activationId: row.activation_id,
    error: row.error,
  };
}

function toArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    teamId: row.team_id,
    runId: row.run_id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    memberId: row.member_id,
    kind: row.kind as Artifact['kind'],
    manifest: readJson<Artifact['manifest']>(row.manifest_json),
    testEvidence: readJson<readonly string[]>(row.test_evidence_json),
    createdAt: row.created_at,
  };
}

function toEvent(row: EventRow): TeamEvent {
  return {
    id: row.id,
    teamId: row.team_id,
    runId: row.run_id,
    sequence: Number(row.sequence),
    kind: row.kind as TeamEvent['kind'],
    payload: readJson<Record<string, unknown>>(row.payload_json),
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

function toBudgetEntry(row: BudgetRow): BudgetEntry {
  return {
    id: row.id,
    runId: row.run_id,
    memberId: row.member_id,
    activationId: row.activation_id,
    requestKey: row.request_key,
    generation: Number(row.generation),
    status: row.status as BudgetEntry['status'],
    reservedInputTokens: Number(row.reserved_input_tokens),
    reservedOutputTokens: Number(row.reserved_output_tokens),
    inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
    outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
    cachedTokens: row.cached_tokens === null ? null : Number(row.cached_tokens),
    estimatedCostUsd:
      row.estimated_cost_usd === null ? null : Number(row.estimated_cost_usd),
    priceVersion: row.price_version,
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}

function toIntegration(row: IntegrationRow): Integration {
  return {
    id: row.id,
    teamId: row.team_id,
    runId: row.run_id,
    taskId: row.task_id,
    baseVersion: row.base_version,
    candidateHash: row.candidate_hash,
    status: row.status as Integration['status'],
    conflicts: readJson<readonly string[]>(row.conflicts_json),
    baseHashes: readJson<Readonly<Record<string, string>>>(row.base_hashes_json),
    resultHashes: readJson<Readonly<Record<string, string>>>(row.result_hashes_json),
    verification: readNullableJson<Readonly<Record<string, unknown>>>(row.verification_json),
    journal: readJson<Integration['journal']>(row.journal_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
  };
}

function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes('UNIQUE constraint failed');
}

/**
 * The same aggregate as `MemoryTeamStore`, over rows instead of objects.
 *
 * Conservative by construction: `reserved` and `incomplete` hold their
 * reservation until proven otherwise, and `released` stops counting entirely.
 * The contract tests check both backends against each other.
 */
function computeSnapshot(
  limits: RunBudgetSnapshot,
  entries: Iterable<BudgetEntry>,
): BudgetSnapshot {
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

export interface SqliteTeamStoreOptions {
  readonly path: string;
  /** Override the clock for tests; ISO strings are derived from this. */
  readonly now?: () => Date;
}

export class SqliteTeamStore implements TeamStore {
  readonly #db: DatabaseSync;
  readonly #statements: StatementCache;
  readonly #now: () => Date;

  constructor(options: SqliteTeamStoreOptions) {
    const path = options.path;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    // WAL keeps a reader (the UI) from blocking the single writer; the busy
    // timeout turns a concurrent writer into a short wait instead of an
    // immediate `SQLITE_BUSY`. Foreign keys are what make the ON DELETE CASCADE
    // clauses real.
    this.#db.exec(
      'PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;',
    );
    this.#db.exec(TEAM_SCHEMA);
    this.#statements = new StatementCache(this.#db);
    this.#now = options.now ?? (() => new Date());
  }

  // ----------------------------------------------------------------- teams ---

  async createTeam(input: CreateTeamInput): Promise<Team> {
    return this.#transaction(() => {
      // A retried request with a fresh id must land on the existing team.
      const existing =
        this.#get<TeamRow>(
          `SELECT ${TEAM_COLUMNS} FROM teams WHERE owner_id = ? AND root_conversation_id = ?`,
          input.ownerId,
          input.rootConversationId,
        ) ?? this.#get<TeamRow>(`SELECT ${TEAM_COLUMNS} FROM teams WHERE id = ?`, input.id);
      if (existing) return toTeam(existing);

      try {
        this.#run(
          `INSERT INTO teams (id, owner_id, root_conversation_id, enabled, config_revision, config_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          input.id,
          input.ownerId,
          input.rootConversationId,
          input.enabled ? 1 : 0,
          1,
          JSON.stringify(input.config),
          input.now,
          input.now,
        );
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // A concurrent create with a different id for the same root: the
        // unique (owner, root) index decided the winner, and both callers get
        // the same team back.
        const winner =
          this.#get<TeamRow>(
            `SELECT ${TEAM_COLUMNS} FROM teams WHERE owner_id = ? AND root_conversation_id = ?`,
            input.ownerId,
            input.rootConversationId,
          ) ?? this.#get<TeamRow>(`SELECT ${TEAM_COLUMNS} FROM teams WHERE id = ?`, input.id);
        if (!winner) throw error;
        return toTeam(winner);
      }
      return toTeam(this.#mustGet<TeamRow>(`SELECT ${TEAM_COLUMNS} FROM teams WHERE id = ?`, input.id));
    });
  }

  async getTeam(id: string): Promise<Team | null> {
    const row = this.#get<TeamRow>(`SELECT ${TEAM_COLUMNS} FROM teams WHERE id = ?`, id);
    return row ? toTeam(row) : null;
  }

  async getTeamForRoot(ownerId: string, rootConversationId: string): Promise<Team | null> {
    const row = this.#get<TeamRow>(
      `SELECT ${TEAM_COLUMNS} FROM teams WHERE owner_id = ? AND root_conversation_id = ?`,
      ownerId,
      rootConversationId,
    );
    return row ? toTeam(row) : null;
  }

  async listTeams(ownerId: string): Promise<Team[]> {
    return this.#all<TeamRow>(
      `SELECT ${TEAM_COLUMNS} FROM teams WHERE owner_id = ? ORDER BY created_at ASC, rowid ASC`,
      ownerId,
    ).map(toTeam);
  }

  async updateTeam(input: UpdateTeamInput): Promise<Team | null> {
    return this.#transaction(() => {
      const result = this.#run(
        `UPDATE teams
            SET enabled = ?, config_json = ?, config_revision = config_revision + 1, updated_at = ?
          WHERE id = ? AND config_revision = ?`,
        input.enabled ? 1 : 0,
        JSON.stringify(input.config),
        input.now,
        input.id,
        input.expectedRevision,
      );
      if (result.changes === 0) return null;
      return toTeam(this.#mustGet<TeamRow>(`SELECT ${TEAM_COLUMNS} FROM teams WHERE id = ?`, input.id));
    });
  }

  // ------------------------------------------------------------------ runs ---

  async createRun(input: CreateRunInput): Promise<CreateRunResult> {
    return this.#transaction(() => {
      const byId = this.#get<RunRow>(`SELECT ${RUN_COLUMNS} FROM team_runs WHERE id = ?`, input.id);
      if (byId) return { run: toRun(byId), created: false };

      const sameKey = this.#get<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM team_runs
          WHERE owner_id = ? AND root_conversation_id = ? AND input_hash = ?`,
        input.ownerId,
        input.rootConversationId,
        input.inputHash,
      );
      if (sameKey) return { run: toRun(sameKey), created: false };

      const active = this.#activeRunRow(input.ownerId, input.rootConversationId);
      if (active) {
        throw new TeamError(
          'TEAM_RUN_BUSY',
          `conversation ${input.rootConversationId} already has an active run`,
          409,
          { runId: active.id, status: active.status },
        );
      }

      try {
        this.#run(
          `INSERT INTO team_runs
             (id, team_id, owner_id, root_conversation_id, root_turn_id, root_request_id,
              input_hash, status, budget_json, root_member_id, reason, created_at, updated_at, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, NULL, NULL, ?, ?, NULL)`,
          input.id,
          input.teamId,
          input.ownerId,
          input.rootConversationId,
          input.rootTurnId,
          input.rootRequestId,
          input.inputHash,
          JSON.stringify(input.budget),
          input.now,
          input.now,
        );
      } catch (error) {
        // Two connections racing the same idempotency key: the loser reads the
        // winner's row instead of reporting a constraint error.
        if (!isUniqueViolation(error)) throw error;
        const winner = this.#get<RunRow>(
          `SELECT ${RUN_COLUMNS} FROM team_runs
            WHERE owner_id = ? AND root_conversation_id = ? AND input_hash = ?`,
          input.ownerId,
          input.rootConversationId,
          input.inputHash,
        );
        if (!winner) throw error;
        return { run: toRun(winner), created: false };
      }

      return {
        run: toRun(this.#mustGet<RunRow>(`SELECT ${RUN_COLUMNS} FROM team_runs WHERE id = ?`, input.id)),
        created: true,
      };
    });
  }

  async getRun(id: string): Promise<TeamRun | null> {
    const row = this.#get<RunRow>(`SELECT ${RUN_COLUMNS} FROM team_runs WHERE id = ?`, id);
    return row ? toRun(row) : null;
  }

  async listRuns(teamId: string, limit = 50): Promise<TeamRun[]> {
    return this.#all<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM team_runs
        WHERE team_id = ? ORDER BY created_at DESC, rowid ASC LIMIT ?`,
      teamId,
      limit,
    ).map(toRun);
  }

  async activeRunForRoot(ownerId: string, rootConversationId: string): Promise<TeamRun | null> {
    const row = this.#activeRunRow(ownerId, rootConversationId);
    return row ? toRun(row) : null;
  }

  async transitionRun(
    runId: string,
    from: readonly TeamRunStatus[],
    patch: RunPatch,
    event?: NewTeamEvent | null,
    now?: string,
  ): Promise<TeamRun | null> {
    return this.#transaction(() => {
      const row = this.#get<RunRow>(`SELECT ${RUN_COLUMNS} FROM team_runs WHERE id = ?`, runId);
      if (!row) return null;
      if (!from.includes(row.status as TeamRunStatus)) return null;

      const at = now ?? this.#nowIso();
      const current = toRun(row);
      const status = patch.status ?? current.status;
      const enteringTerminal = status !== current.status && isTerminalRunStatus(status);
      const finishedAt =
        patch.finishedAt !== undefined
          ? patch.finishedAt
          : enteringTerminal && current.finishedAt === null
            ? at
            : current.finishedAt;

      const result = this.#run(
        `UPDATE team_runs
            SET status = ?, root_member_id = ?, reason = ?, updated_at = ?, finished_at = ?
          WHERE id = ? AND status = ?`,
        status,
        patch.rootMemberId !== undefined ? patch.rootMemberId : current.rootMemberId,
        patch.reason !== undefined ? patch.reason : current.reason,
        at,
        finishedAt,
        runId,
        row.status,
      );
      if (result.changes === 0) return null;
      if (event) this.#appendEventInternal(current.teamId, runId, event, at);
      return toRun(this.#mustGet<RunRow>(`SELECT ${RUN_COLUMNS} FROM team_runs WHERE id = ?`, runId));
    });
  }

  // --------------------------------------------------------------- members ---

  async createMember(input: CreateMemberInput): Promise<Member> {
    return this.#transaction(() => {
      const byId = this.#get<MemberRow>(
        `SELECT ${MEMBER_COLUMNS} FROM team_members WHERE id = ?`,
        input.member.id,
      );
      if (byId) return toMember(byId);
      const byConversation = this.#get<MemberRow>(
        `SELECT ${MEMBER_COLUMNS} FROM team_members WHERE internal_conversation_id = ?`,
        input.member.internalConversationId,
      );
      if (byConversation) return toMember(byConversation);

      const member = input.member;
      try {
        this.#run(
          `INSERT INTO team_members
             (id, team_id, parent_member_id, internal_conversation_id, name, role, depth, status,
              profile_json, permissions_json, workspace_id, workspace_mode, context_mode, fork_seq,
              current_activation_id, error, created_at, updated_at, closed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          member.id,
          member.teamId,
          member.parentMemberId,
          member.internalConversationId,
          member.name,
          member.role,
          member.depth,
          member.status,
          JSON.stringify(member.profile),
          JSON.stringify(member.permissions),
          member.workspaceId,
          member.workspaceMode,
          member.contextMode,
          member.forkSeq,
          member.currentActivationId,
          member.error,
          member.createdAt,
          member.updatedAt,
          member.closedAt,
        );
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // Either the id or the internal conversation was taken by a concurrent
        // retry; both resolve to the row that already exists.
        const winner =
          this.#get<MemberRow>(
            `SELECT ${MEMBER_COLUMNS} FROM team_members WHERE internal_conversation_id = ?`,
            member.internalConversationId,
          ) ?? this.#get<MemberRow>(`SELECT ${MEMBER_COLUMNS} FROM team_members WHERE id = ?`, member.id);
        if (!winner) throw error;
        return toMember(winner);
      }
      if (input.event) {
        this.#appendMemberEventInternal(member.teamId, input.event, member.createdAt);
      }
      return toMember(
        this.#mustGet<MemberRow>(`SELECT ${MEMBER_COLUMNS} FROM team_members WHERE id = ?`, member.id),
      );
    });
  }

  async getMember(id: string): Promise<Member | null> {
    const row = this.#get<MemberRow>(`SELECT ${MEMBER_COLUMNS} FROM team_members WHERE id = ?`, id);
    return row ? toMember(row) : null;
  }

  async listMembers(teamId: string): Promise<Member[]> {
    return this.#all<MemberRow>(
      `SELECT ${MEMBER_COLUMNS} FROM team_members
        WHERE team_id = ? ORDER BY created_at ASC, rowid ASC`,
      teamId,
    ).map(toMember);
  }

  async countMembers(teamId: string): Promise<number> {
    const row = this.#get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM team_members WHERE team_id = ?',
      teamId,
    );
    return Number(row?.count ?? 0);
  }

  async updateMember(
    id: string,
    patch: UpdateMemberPatch,
    event?: NewTeamEvent | null,
  ): Promise<Member | null> {
    return this.#transaction(() => {
      const row = this.#get<MemberRow>(`SELECT ${MEMBER_COLUMNS} FROM team_members WHERE id = ?`, id);
      if (!row) return null;

      const sets: string[] = [];
      const params: SqlValue[] = [];
      if (patch.status !== undefined) {
        sets.push('status = ?');
        params.push(patch.status);
      }
      if (patch.currentActivationId !== undefined) {
        sets.push('current_activation_id = ?');
        params.push(patch.currentActivationId);
      }
      if (patch.closedAt !== undefined) {
        sets.push('closed_at = ?');
        params.push(patch.closedAt);
      }
      if (patch.error !== undefined) {
        sets.push('error = ?');
        params.push(patch.error);
      }
      sets.push('updated_at = ?');
      params.push(patch.now, id);
      this.#run(`UPDATE team_members SET ${sets.join(', ')} WHERE id = ?`, ...params);

      if (event) this.#appendMemberEventInternal(row.team_id, event, patch.now);
      return toMember(
        this.#mustGet<MemberRow>(`SELECT ${MEMBER_COLUMNS} FROM team_members WHERE id = ?`, id),
      );
    });
  }

  // ----------------------------------------------------------- activations ---

  async createActivation(input: CreateActivationInput): Promise<Activation> {
    return this.#transaction(() => {
      const existing = this.#get<ActivationRow>(
        `SELECT ${ACTIVATION_COLUMNS} FROM team_activations WHERE id = ?`,
        input.activation.id,
      );
      if (existing) return toActivation(existing);

      const run = this.#get<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM team_runs WHERE id = ?`,
        input.activation.runId,
      );
      if (!run) {
        throw new TeamError(
          'TEAM_RUN_NOT_FOUND',
          `run ${input.activation.runId} not found`,
          404,
        );
      }

      const countRow = this.#get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM team_activations WHERE run_id = ?',
        input.activation.runId,
      );
      const count = Number(countRow?.count ?? 0);
      if (count >= input.maxActivations) {
        throw new TeamError(
          'TEAM_ACTIVATION_LIMIT',
          `run ${input.activation.runId} already has ${count} activations`,
          409,
          { runId: input.activation.runId, count, max: input.maxActivations },
        );
      }

      const activation = input.activation;
      if (activation.status === 'running') {
        const running = this.#get<{ one: number }>(
          "SELECT 1 AS one FROM team_activations WHERE member_id = ? AND status = 'running'",
          activation.memberId,
        );
        if (running) {
          throw new TeamError(
            'TEAM_ACTIVATION_CONFLICT',
            `member ${activation.memberId} already has a running activation`,
            409,
            { memberId: activation.memberId },
          );
        }
      }

      try {
        this.#insertActivation(activation);
      } catch (error) {
        // The partial unique index is the last word on "one running activation
        // per member"; translate it rather than leaking SQLite's message.
        if (isUniqueViolation(error)) {
          throw new TeamError(
            'TEAM_ACTIVATION_CONFLICT',
            `member ${activation.memberId} already has a running activation`,
            409,
            { memberId: activation.memberId },
          );
        }
        throw error;
      }

      if (input.event) {
        this.#appendEventInternal(run.team_id, activation.runId, input.event, activation.createdAt);
      }
      return toActivation(
        this.#mustGet<ActivationRow>(
          `SELECT ${ACTIVATION_COLUMNS} FROM team_activations WHERE id = ?`,
          activation.id,
        ),
      );
    });
  }

  async getActivation(id: string): Promise<Activation | null> {
    const row = this.#get<ActivationRow>(
      `SELECT ${ACTIVATION_COLUMNS} FROM team_activations WHERE id = ?`,
      id,
    );
    return row ? toActivation(row) : null;
  }

  async listActivations(runId: string, memberId?: string): Promise<Activation[]> {
    const rows =
      memberId === undefined
        ? this.#all<ActivationRow>(
            `SELECT ${ACTIVATION_COLUMNS} FROM team_activations
              WHERE run_id = ? ORDER BY created_at ASC, rowid ASC`,
            runId,
          )
        : this.#all<ActivationRow>(
            `SELECT ${ACTIVATION_COLUMNS} FROM team_activations
              WHERE run_id = ? AND member_id = ? ORDER BY created_at ASC, rowid ASC`,
            runId,
            memberId,
          );
    return rows.map(toActivation);
  }

  async countActivations(runId: string): Promise<number> {
    const row = this.#get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM team_activations WHERE run_id = ?',
      runId,
    );
    return Number(row?.count ?? 0);
  }

  async updateActivation(
    id: string,
    from: readonly ActivationStatus[],
    patch: UpdateActivationPatch,
    event?: NewTeamEvent | null,
    now?: string,
  ): Promise<Activation | null> {
    return this.#transaction(() => {
      const row = this.#get<ActivationRow>(
        `SELECT ${ACTIVATION_COLUMNS} FROM team_activations WHERE id = ?`,
        id,
      );
      if (!row) return null;
      if (!from.includes(row.status as ActivationStatus)) return null;

      const at = now ?? this.#nowIso();
      const current = toActivation(row);
      const status = patch.status ?? current.status;
      const enteringTerminal = status !== current.status && isTerminalActivation(status);
      const finishedAt =
        patch.finishedAt !== undefined
          ? patch.finishedAt
          : enteringTerminal && current.finishedAt === null
            ? at
            : current.finishedAt;

      if (status === 'running' && current.status !== 'running') {
        const running = this.#get<{ id: string }>(
          "SELECT id FROM team_activations WHERE member_id = ? AND status = 'running'",
          current.memberId,
        );
        if (running && running.id !== id) {
          throw new TeamError(
            'TEAM_ACTIVATION_CONFLICT',
            `member ${current.memberId} already has a running activation`,
            409,
            { memberId: current.memberId },
          );
        }
      }

      const sets: string[] = [];
      const params: SqlValue[] = [];
      sets.push('status = ?');
      params.push(status);
      if (patch.checkpoint !== undefined) {
        sets.push('checkpoint_json = ?');
        params.push(JSON.stringify(patch.checkpoint));
      }
      if (patch.result !== undefined) {
        sets.push('result_json = ?');
        params.push(patch.result === null ? null : JSON.stringify(patch.result));
      }
      if (patch.error !== undefined) {
        sets.push('error = ?');
        params.push(patch.error);
      }
      if (patch.startedAt !== undefined) {
        sets.push('started_at = ?');
        params.push(patch.startedAt);
      }
      if (patch.finishedAt !== undefined) {
        sets.push('finished_at = ?');
        params.push(patch.finishedAt);
      } else if (enteringTerminal && current.finishedAt === null) {
        sets.push('finished_at = ?');
        params.push(finishedAt);
      }
      if (patch.leaseExpiresAt !== undefined) {
        sets.push('lease_expires_at = ?');
        params.push(patch.leaseExpiresAt);
      }
      if (patch.generation !== undefined) {
        sets.push('generation = ?');
        params.push(patch.generation);
      }
      params.push(id, row.status);

      try {
        const result = this.#run(
          `UPDATE team_activations SET ${sets.join(', ')} WHERE id = ? AND status = ?`,
          ...params,
        );
        if (result.changes === 0) return null;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new TeamError(
            'TEAM_ACTIVATION_CONFLICT',
            `member ${current.memberId} already has a running activation`,
            409,
            { memberId: current.memberId },
          );
        }
        throw error;
      }

      if (event) {
        const run = this.#get<RunRow>(
          `SELECT ${RUN_COLUMNS} FROM team_runs WHERE id = ?`,
          current.runId,
        );
        if (!run) throw new TeamError('TEAM_RUN_NOT_FOUND', `run ${current.runId} not found`, 404);
        this.#appendEventInternal(run.team_id, current.runId, event, at);
      }
      return toActivation(
        this.#mustGet<ActivationRow>(
          `SELECT ${ACTIVATION_COLUMNS} FROM team_activations WHERE id = ?`,
          id,
        ),
      );
    });
  }

  async nextQueuedActivation(memberId: string): Promise<Activation | null> {
    const row = this.#get<ActivationRow>(
      `SELECT ${ACTIVATION_COLUMNS} FROM team_activations
        WHERE member_id = ? AND status = 'queued'
        ORDER BY created_at ASC, rowid ASC LIMIT 1`,
      memberId,
    );
    return row ? toActivation(row) : null;
  }

  async expiredActivations(now: string): Promise<Activation[]> {
    return this.#all<ActivationRow>(
      `SELECT ${ACTIVATION_COLUMNS} FROM team_activations
        WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
        ORDER BY created_at ASC, rowid ASC`,
      now,
    ).map(toActivation);
  }

  async runningActivations(): Promise<Activation[]> {
    return this.#all<ActivationRow>(
      `SELECT ${ACTIVATION_COLUMNS} FROM team_activations
        WHERE status IN ('running', 'waiting')
        ORDER BY created_at ASC, rowid ASC`,
    ).map(toActivation);
  }

  // ----------------------------------------------------------------- tasks ---

  async createTask(input: CreateTaskInput): Promise<Task> {
    return this.#transaction(() => {
      const existing = this.#get<TaskRow>(
        `SELECT ${TASK_COLUMNS} FROM team_tasks WHERE id = ?`,
        input.task.id,
      );
      if (existing) return toTask(existing);

      const run = this.#get<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM team_runs WHERE id = ?`,
        input.task.runId,
      );
      if (!run) {
        throw new TeamError('TEAM_RUN_NOT_FOUND', `run ${input.task.runId} not found`, 404);
      }

      const countRow = this.#get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM team_tasks WHERE run_id = ?',
        input.task.runId,
      );
      const count = Number(countRow?.count ?? 0);
      if (count >= input.maxTasks) {
        throw new TeamError(
          'TEAM_TASK_LIMIT',
          `run ${input.task.runId} already has ${count} tasks`,
          409,
          { runId: input.task.runId, count, max: input.maxTasks },
        );
      }

      const task = input.task;
      this.#run(
        `INSERT INTO team_tasks
           (id, team_id, run_id, revision, title, specification, acceptance, required,
            dependencies_json, owner_id, status, write_scopes_json, created_by, created_at,
            updated_at, submitted_at, accepted_at, failure_reason, current_attempt_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        task.id,
        task.teamId,
        task.runId,
        task.revision,
        task.title,
        task.specification,
        task.acceptance,
        task.required ? 1 : 0,
        JSON.stringify(task.dependencies),
        task.ownerId,
        task.status,
        JSON.stringify(task.writeScopes),
        task.createdBy,
        task.createdAt,
        task.updatedAt,
        task.submittedAt,
        task.acceptedAt,
        task.failureReason,
        task.currentAttemptId,
      );
      if (input.event) this.#appendEventInternal(task.teamId, task.runId, input.event, task.createdAt);
      return toTask(
        this.#mustGet<TaskRow>(`SELECT ${TASK_COLUMNS} FROM team_tasks WHERE id = ?`, task.id),
      );
    });
  }

  async getTask(id: string): Promise<Task | null> {
    const row = this.#get<TaskRow>(`SELECT ${TASK_COLUMNS} FROM team_tasks WHERE id = ?`, id);
    return row ? toTask(row) : null;
  }

  async listTasks(runId: string, options?: TaskListOptions): Promise<TaskPage> {
    const clauses = ['run_id = ?'];
    const params: SqlValue[] = [runId];
    if (options?.status !== undefined) {
      clauses.push('status = ?');
      params.push(options.status);
    }
    const where = clauses.join(' AND ');
    const totalRow = this.#get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM team_tasks WHERE ${where}`,
      ...params,
    );
    const limit = Math.max(0, options?.limit ?? DEFAULT_PAGE);
    const offset = Math.max(0, options?.offset ?? 0);
    const items = this.#all<TaskRow>(
      `SELECT ${TASK_COLUMNS} FROM team_tasks
        WHERE ${where} ORDER BY created_at ASC, rowid ASC LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    ).map(toTask);
    return { items, total: Number(totalRow?.count ?? 0) };
  }

  async listTasksByIds(runId: string, ids: readonly string[]): Promise<Task[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.#all<TaskRow>(
      `SELECT ${TASK_COLUMNS} FROM team_tasks WHERE run_id = ? AND id IN (${placeholders})`,
      runId,
      ...ids,
    );
    const byId = new Map(rows.map((row) => [row.id, toTask(row)]));
    return ids.flatMap((id) => {
      const task = byId.get(id);
      return task ? [task] : [];
    });
  }

  async countTasks(runId: string): Promise<number> {
    const row = this.#get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM team_tasks WHERE run_id = ?',
      runId,
    );
    return Number(row?.count ?? 0);
  }

  async updateTask(input: UpdateTaskInput): Promise<CasResult<Task>> {
    return this.#transaction(() => {
      const row = this.#get<TaskRow>(
        `SELECT ${TASK_COLUMNS} FROM team_tasks WHERE id = ?`,
        input.taskId,
      );
      if (!row) {
        throw new TeamError('TEAM_TASK_NOT_FOUND', `task ${input.taskId} not found`, 404);
      }
      if (Number(row.revision) !== input.expectedRevision) {
        return { ok: false, current: toTask(row) };
      }

      const { sets, params } = taskSetClauses(input.patch);
      sets.push('revision = revision + 1', 'updated_at = ?');
      params.push(input.now, input.taskId, input.expectedRevision);
      const result = this.#run(
        `UPDATE team_tasks SET ${sets.join(', ')} WHERE id = ? AND revision = ?`,
        ...params,
      );
      if (result.changes === 0) {
        const current = this.#get<TaskRow>(
          `SELECT ${TASK_COLUMNS} FROM team_tasks WHERE id = ?`,
          input.taskId,
        );
        if (!current) {
          throw new TeamError('TEAM_TASK_NOT_FOUND', `task ${input.taskId} not found`, 404);
        }
        return { ok: false, current: toTask(current) };
      }

      if (input.event) this.#appendEventInternal(row.team_id, row.run_id, input.event, input.now);
      return {
        ok: true,
        value: toTask(
          this.#mustGet<TaskRow>(`SELECT ${TASK_COLUMNS} FROM team_tasks WHERE id = ?`, input.taskId),
        ),
      };
    });
  }

  async claimTask(input: ClaimTaskInput): Promise<CasResult<ClaimTaskValue>> {
    return this.#transaction(() => {
      const row = this.#get<TaskRow>(
        `SELECT ${TASK_COLUMNS} FROM team_tasks WHERE id = ?`,
        input.taskId,
      );
      if (!row) {
        throw new TeamError('TEAM_TASK_NOT_FOUND', `task ${input.taskId} not found`, 404);
      }
      if (Number(row.revision) !== input.expectedRevision || row.status !== 'pending') {
        return { ok: false, current: toTask(row) };
      }

      const attempt: TaskAttempt = {
        id: `att_${randomUUID()}`,
        taskId: input.taskId,
        activationId: input.activationId,
        generation: input.generation,
        leaseExpiresAt: input.leaseExpiresAt,
        baselineId: input.baselineId,
        submission: null,
        review: null,
        createdAt: input.now,
        updatedAt: input.now,
      };
      const result = this.#run(
        `UPDATE team_tasks
            SET revision = revision + 1, status = 'running', owner_id = ?,
                current_attempt_id = ?, updated_at = ?
          WHERE id = ? AND revision = ? AND status = 'pending'`,
        input.memberId,
        attempt.id,
        input.now,
        input.taskId,
        input.expectedRevision,
      );
      if (result.changes === 0) {
        const current = this.#get<TaskRow>(
          `SELECT ${TASK_COLUMNS} FROM team_tasks WHERE id = ?`,
          input.taskId,
        );
        if (!current) {
          throw new TeamError('TEAM_TASK_NOT_FOUND', `task ${input.taskId} not found`, 404);
        }
        return { ok: false, current: toTask(current) };
      }

      this.#insertAttempt(attempt);
      if (input.event) this.#appendEventInternal(row.team_id, row.run_id, input.event, input.now);
      return {
        ok: true,
        value: {
          task: toTask(
            this.#mustGet<TaskRow>(
              `SELECT ${TASK_COLUMNS} FROM team_tasks WHERE id = ?`,
              input.taskId,
            ),
          ),
          attempt,
        },
      };
    });
  }

  async submitTask(input: SubmitTaskInput): Promise<CasResult<SubmitTaskValue>> {
    return this.#transaction(() => {
      const row = this.#get<TaskRow>(
        `SELECT ${TASK_COLUMNS} FROM team_tasks WHERE id = ?`,
        input.taskId,
      );
      if (!row) {
        throw new TeamError('TEAM_TASK_NOT_FOUND', `task ${input.taskId} not found`, 404);
      }
      const attemptRow = this.#get<AttemptRow>(
        `SELECT ${ATTEMPT_COLUMNS} FROM team_task_attempts WHERE id = ?`,
        input.attemptId,
      );
      if (
        Number(row.revision) !== input.expectedRevision ||
        row.status !== 'running' ||
        row.current_attempt_id !== input.attemptId ||
        !attemptRow ||
        attemptRow.task_id !== input.taskId
      ) {
        return { ok: false, current: toTask(row) };
      }

      this.#run(
        'UPDATE team_task_attempts SET submission_json = ?, updated_at = ? WHERE id = ?',
        JSON.stringify(input.submission),
        input.now,
        input.attemptId,
      );
      const result = this.#run(
        `UPDATE team_tasks
            SET revision = revision + 1, status = 'submitted', submitted_at = ?, updated_at = ?
          WHERE id = ? AND revision = ? AND status = 'running' AND current_attempt_id = ?`,
        input.submission.submittedAt,
        input.now,
        input.taskId,
        input.expectedRevision,
        input.attemptId,
      );
      if (result.changes === 0) {
        const current = this.#get<TaskRow>(
          `SELECT ${TASK_COLUMNS} FROM team_tasks WHERE id = ?`,
          input.taskId,
        );
        if (!current) {
          throw new TeamError('TEAM_TASK_NOT_FOUND', `task ${input.taskId} not found`, 404);
        }
        return { ok: false, current: toTask(current) };
      }

      if (input.event) this.#appendEventInternal(row.team_id, row.run_id, input.event, input.now);
      return {
        ok: true,
        value: {
          task: toTask(
            this.#mustGet<TaskRow>(
              `SELECT ${TASK_COLUMNS} FROM team_tasks WHERE id = ?`,
              input.taskId,
            ),
          ),
          attempt: toAttempt(
            this.#mustGet<AttemptRow>(
              `SELECT ${ATTEMPT_COLUMNS} FROM team_task_attempts WHERE id = ?`,
              input.attemptId,
            ),
          ),
        },
      };
    });
  }

  async reviewTask(input: ReviewTaskInput): Promise<CasResult<ReviewTaskValue>> {
    return this.#transaction(() => {
      const row = this.#get<TaskRow>(
        `SELECT ${TASK_COLUMNS} FROM team_tasks WHERE id = ?`,
        input.taskId,
      );
      if (!row) {
        throw new TeamError('TEAM_TASK_NOT_FOUND', `task ${input.taskId} not found`, 404);
      }
      const attemptRow = this.#get<AttemptRow>(
        `SELECT ${ATTEMPT_COLUMNS} FROM team_task_attempts WHERE id = ?`,
        input.attemptId,
      );
      if (
        Number(row.revision) !== input.expectedRevision ||
        row.status !== 'submitted' ||
        row.current_attempt_id !== input.attemptId ||
        !attemptRow ||
        attemptRow.task_id !== input.taskId
      ) {
        return { ok: false, current: toTask(row) };
      }

      const accepted = input.review.decision === 'accepted';
      this.#run(
        'UPDATE team_task_attempts SET review_json = ?, updated_at = ? WHERE id = ?',
        JSON.stringify(input.review),
        input.now,
        input.attemptId,
      );
      const result = this.#run(
        `UPDATE team_tasks
            SET revision = revision + 1, status = ?, accepted_at = ?, current_attempt_id = ?,
                updated_at = ?
          WHERE id = ? AND revision = ? AND status = 'submitted' AND current_attempt_id = ?`,
        accepted ? 'accepted' : 'pending',
        accepted ? input.review.reviewedAt : row.accepted_at,
        accepted ? input.attemptId : null,
        input.now,
        input.taskId,
        input.expectedRevision,
        input.attemptId,
      );
      if (result.changes === 0) {
        const current = this.#get<TaskRow>(
          `SELECT ${TASK_COLUMNS} FROM team_tasks WHERE id = ?`,
          input.taskId,
        );
        if (!current) {
          throw new TeamError('TEAM_TASK_NOT_FOUND', `task ${input.taskId} not found`, 404);
        }
        return { ok: false, current: toTask(current) };
      }

      if (input.event) this.#appendEventInternal(row.team_id, row.run_id, input.event, input.now);
      return {
        ok: true,
        value: {
          task: toTask(
            this.#mustGet<TaskRow>(
              `SELECT ${TASK_COLUMNS} FROM team_tasks WHERE id = ?`,
              input.taskId,
            ),
          ),
          attempt: toAttempt(
            this.#mustGet<AttemptRow>(
              `SELECT ${ATTEMPT_COLUMNS} FROM team_task_attempts WHERE id = ?`,
              input.attemptId,
            ),
          ),
        },
      };
    });
  }

  async getAttempt(id: string): Promise<TaskAttempt | null> {
    const row = this.#get<AttemptRow>(
      `SELECT ${ATTEMPT_COLUMNS} FROM team_task_attempts WHERE id = ?`,
      id,
    );
    return row ? toAttempt(row) : null;
  }

  async listAttempts(taskId: string): Promise<TaskAttempt[]> {
    return this.#all<AttemptRow>(
      `SELECT ${ATTEMPT_COLUMNS} FROM team_task_attempts
        WHERE task_id = ? ORDER BY created_at ASC, rowid ASC`,
      taskId,
    ).map(toAttempt);
  }

  async findAttemptByActivation(activationId: string): Promise<TaskAttempt | null> {
    const row = this.#get<AttemptRow>(
      `SELECT ${ATTEMPT_COLUMNS} FROM team_task_attempts
        WHERE activation_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 1`,
      activationId,
    );
    return row ? toAttempt(row) : null;
  }

  // -------------------------------------------------------------- messages ---

  async appendMessage(input: AppendMessageInput): Promise<AppendMessageValue> {
    return this.#transaction(() => {
      const incoming = input.message;
      const existing = this.#get<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS} FROM team_messages
          WHERE sender_id = ? AND recipient_id = ? AND client_message_id = ?`,
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
        return { message: toMessage(existing), duplicate: true };
      }

      const run = this.#get<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM team_runs WHERE id = ?`,
        incoming.runId,
      );
      if (!run) {
        throw new TeamError('TEAM_RUN_NOT_FOUND', `run ${incoming.runId} not found`, 404);
      }

      const runCountRow = this.#get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM team_messages WHERE run_id = ?',
        incoming.runId,
      );
      const runCount = Number(runCountRow?.count ?? 0);
      if (runCount >= input.maxMessages) {
        throw new TeamError(
          'TEAM_MESSAGE_LIMIT',
          `run ${incoming.runId} already has ${runCount} messages`,
          409,
          { runId: incoming.runId, count: runCount, max: input.maxMessages },
        );
      }

      const queuedRow = this.#get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM team_messages WHERE recipient_id = ? AND state = 'accepted'",
        incoming.recipientId,
      );
      const queued = Number(queuedRow?.count ?? 0);
      if (queued >= input.maxQueuedPerMember) {
        throw new TeamError(
          'TEAM_MESSAGE_LIMIT',
          `member ${incoming.recipientId} already has ${queued} queued messages`,
          409,
          { recipientId: incoming.recipientId, queued, max: input.maxQueuedPerMember },
        );
      }

      const sequenceRow = this.#get<{ seq: number | null }>(
        'SELECT MAX(sequence) AS seq FROM team_messages WHERE run_id = ?',
        incoming.runId,
      );
      const sequence = Number(sequenceRow?.seq ?? 0) + 1;

      try {
        this.#run(
          `INSERT INTO team_messages
             (id, team_id, run_id, sender_id, sender_kind, recipient_id, client_message_id,
              body, sequence, state, created_at, injected_at, processed_at, activation_id, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          incoming.id,
          incoming.teamId,
          incoming.runId,
          incoming.senderId,
          incoming.senderKind,
          incoming.recipientId,
          incoming.clientMessageId,
          incoming.body,
          sequence,
          incoming.state,
          incoming.createdAt,
          incoming.injectedAt,
          incoming.processedAt,
          incoming.activationId,
          incoming.error,
        );
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // The same key landed from another connection: report it the same way
        // the read-first path would have.
        const winner = this.#get<MessageRow>(
          `SELECT ${MESSAGE_COLUMNS} FROM team_messages
            WHERE sender_id = ? AND recipient_id = ? AND client_message_id = ?`,
          incoming.senderId,
          incoming.recipientId,
          incoming.clientMessageId,
        );
        if (!winner) throw error;
        if (winner.body !== incoming.body) {
          throw new TeamError(
            'TEAM_MESSAGE_CONFLICT',
            'the same message key was already used with a different body',
            409,
            { messageId: winner.id },
          );
        }
        return { message: toMessage(winner), duplicate: true };
      }

      if (input.event) {
        this.#appendEventInternal(
          incoming.teamId,
          incoming.runId,
          input.event,
          incoming.createdAt,
        );
      }
      return {
        message: toMessage(
          this.#mustGet<MessageRow>(
            `SELECT ${MESSAGE_COLUMNS} FROM team_messages WHERE id = ?`,
            incoming.id,
          ),
        ),
        duplicate: false,
      };
    });
  }

  async listMessages(
    runId: string,
    afterSequence = 0,
    limit = DEFAULT_PAGE,
  ): Promise<MessagePage> {
    const totalRow = this.#get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM team_messages WHERE run_id = ? AND sequence > ?',
      runId,
      afterSequence,
    );
    const items = this.#all<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM team_messages
        WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?`,
      runId,
      afterSequence,
      limit,
    ).map(toMessage);
    return { items, total: Number(totalRow?.count ?? 0) };
  }

  async pendingMessages(recipientId: string, limit = DEFAULT_PAGE): Promise<TeamMessage[]> {
    return this.#all<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM team_messages
        WHERE recipient_id = ? AND state = 'accepted'
        ORDER BY created_at ASC, sequence ASC, rowid ASC LIMIT ?`,
      recipientId,
      limit,
    ).map(toMessage);
  }

  async getMessage(id: string): Promise<TeamMessage | null> {
    const row = this.#get<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM team_messages WHERE id = ?`,
      id,
    );
    return row ? toMessage(row) : null;
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
    return this.#transaction(() => {
      const row = this.#get<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS} FROM team_messages WHERE id = ?`,
        id,
      );
      if (!row) return null;
      if (!from.includes(row.state as TeamMessage['state'])) return null;

      const at = now ?? this.#nowIso();
      const current = toMessage(row);
      const sets: string[] = ['state = ?'];
      const params: SqlValue[] = [patch.state];
      if (patch.injectedAt !== undefined) {
        sets.push('injected_at = ?');
        params.push(patch.injectedAt);
      } else if (patch.state === 'injected' && current.injectedAt === null) {
        sets.push('injected_at = ?');
        params.push(at);
      }
      if (patch.processedAt !== undefined) {
        sets.push('processed_at = ?');
        params.push(patch.processedAt);
      } else if (patch.state === 'processed' && current.processedAt === null) {
        sets.push('processed_at = ?');
        params.push(at);
      }
      if (patch.activationId !== undefined) {
        sets.push('activation_id = ?');
        params.push(patch.activationId);
      }
      if (patch.error !== undefined) {
        sets.push('error = ?');
        params.push(patch.error);
      }
      params.push(id, row.state);
      const result = this.#run(
        `UPDATE team_messages SET ${sets.join(', ')} WHERE id = ? AND state = ?`,
        ...params,
      );
      if (result.changes === 0) return null;

      if (event) this.#appendEventInternal(row.team_id, row.run_id, event, at);
      return toMessage(
        this.#mustGet<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM team_messages WHERE id = ?`, id),
      );
    });
  }

  // ------------------------------------------------------------- artifacts ---

  async createArtifact(input: CreateArtifactInput): Promise<Artifact> {
    return this.#transaction(() => {
      const existing = this.#get<ArtifactRow>(
        `SELECT ${ARTIFACT_COLUMNS} FROM team_artifacts WHERE id = ?`,
        input.artifact.id,
      );
      if (existing) return toArtifact(existing);

      const artifact = input.artifact;
      const run = this.#get<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM team_runs WHERE id = ?`,
        artifact.runId,
      );
      if (!run) {
        throw new TeamError('TEAM_RUN_NOT_FOUND', `run ${artifact.runId} not found`, 404);
      }
      this.#run(
        `INSERT INTO team_artifacts
           (id, team_id, run_id, task_id, attempt_id, member_id, kind, manifest_json,
            test_evidence_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        artifact.id,
        artifact.teamId,
        artifact.runId,
        artifact.taskId,
        artifact.attemptId,
        artifact.memberId,
        artifact.kind,
        JSON.stringify(artifact.manifest),
        JSON.stringify(artifact.testEvidence),
        artifact.createdAt,
      );
      if (input.event) {
        this.#appendEventInternal(artifact.teamId, artifact.runId, input.event, artifact.createdAt);
      }
      return toArtifact(
        this.#mustGet<ArtifactRow>(
          `SELECT ${ARTIFACT_COLUMNS} FROM team_artifacts WHERE id = ?`,
          artifact.id,
        ),
      );
    });
  }

  async getArtifact(id: string): Promise<Artifact | null> {
    const row = this.#get<ArtifactRow>(
      `SELECT ${ARTIFACT_COLUMNS} FROM team_artifacts WHERE id = ?`,
      id,
    );
    return row ? toArtifact(row) : null;
  }

  async listArtifacts(filter: {
    readonly runId?: string;
    readonly taskId?: string;
    readonly attemptId?: string;
    readonly limit?: number;
  }): Promise<Artifact[]> {
    const clauses: string[] = [];
    const params: SqlValue[] = [];
    if (filter.runId !== undefined) {
      clauses.push('run_id = ?');
      params.push(filter.runId);
    }
    if (filter.taskId !== undefined) {
      clauses.push('task_id = ?');
      params.push(filter.taskId);
    }
    if (filter.attemptId !== undefined) {
      clauses.push('attempt_id = ?');
      params.push(filter.attemptId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.#all<ArtifactRow>(
      `SELECT ${ARTIFACT_COLUMNS} FROM team_artifacts
        ${where} ORDER BY created_at ASC, rowid ASC LIMIT ?`,
      ...params,
      filter.limit ?? DEFAULT_PAGE,
    ).map(toArtifact);
  }

  // ----------------------------------------------------------- integration ---

  async createIntegration(input: CreateIntegrationInput): Promise<Integration> {
    return this.#transaction(() => {
      const existing = this.#get<IntegrationRow>(
        `SELECT ${INTEGRATION_COLUMNS} FROM team_integrations WHERE id = ?`,
        input.integration.id,
      );
      if (existing) return toIntegration(existing);

      const integration = input.integration;
      const run = this.#get<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM team_runs WHERE id = ?`,
        integration.runId,
      );
      if (!run) {
        throw new TeamError(
          'TEAM_RUN_NOT_FOUND',
          `run ${integration.runId} not found`,
          404,
        );
      }
      this.#run(
        `INSERT INTO team_integrations
           (id, team_id, run_id, task_id, base_version, candidate_hash, status, conflicts_json,
            base_hashes_json, result_hashes_json, verification_json, journal_json, created_at,
            updated_at, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        integration.id,
        integration.teamId,
        integration.runId,
        integration.taskId,
        integration.baseVersion,
        integration.candidateHash,
        integration.status,
        JSON.stringify(integration.conflicts),
        JSON.stringify(integration.baseHashes),
        JSON.stringify(integration.resultHashes),
        integration.verification === null ? null : JSON.stringify(integration.verification),
        JSON.stringify(integration.journal),
        integration.createdAt,
        integration.updatedAt,
        integration.publishedAt,
      );
      if (input.event) {
        this.#appendEventInternal(
          integration.teamId,
          integration.runId,
          input.event,
          integration.createdAt,
        );
      }
      return toIntegration(
        this.#mustGet<IntegrationRow>(
          `SELECT ${INTEGRATION_COLUMNS} FROM team_integrations WHERE id = ?`,
          integration.id,
        ),
      );
    });
  }

  async getIntegration(id: string): Promise<Integration | null> {
    const row = this.#get<IntegrationRow>(
      `SELECT ${INTEGRATION_COLUMNS} FROM team_integrations WHERE id = ?`,
      id,
    );
    return row ? toIntegration(row) : null;
  }

  async listIntegrations(runId: string): Promise<Integration[]> {
    return this.#all<IntegrationRow>(
      `SELECT ${INTEGRATION_COLUMNS} FROM team_integrations
        WHERE run_id = ? ORDER BY created_at ASC, rowid ASC`,
      runId,
    ).map(toIntegration);
  }

  async updateIntegration(input: UpdateIntegrationInput): Promise<Integration | null> {
    return this.#transaction(() => {
      const row = this.#get<IntegrationRow>(
        `SELECT ${INTEGRATION_COLUMNS} FROM team_integrations WHERE id = ?`,
        input.integrationId,
      );
      if (!row) return null;

      const patch = input.patch;
      const current = toIntegration(row);
      const status = patch.status ?? current.status;
      const sets: string[] = ['status = ?'];
      const params: SqlValue[] = [status];
      if (patch.conflicts !== undefined) {
        sets.push('conflicts_json = ?');
        params.push(JSON.stringify(patch.conflicts));
      }
      if (patch.resultHashes !== undefined) {
        sets.push('result_hashes_json = ?');
        params.push(JSON.stringify(patch.resultHashes));
      }
      if (patch.verification !== undefined) {
        sets.push('verification_json = ?');
        params.push(patch.verification === null ? null : JSON.stringify(patch.verification));
      }
      if (patch.journal !== undefined) {
        sets.push('journal_json = ?');
        params.push(JSON.stringify(patch.journal));
      }
      const publishedAt =
        patch.publishedAt !== undefined
          ? patch.publishedAt
          : status === 'published' && current.publishedAt === null
            ? input.now
            : current.publishedAt;
      sets.push('published_at = ?', 'updated_at = ?');
      params.push(publishedAt, input.now, input.integrationId);
      this.#run(
        `UPDATE team_integrations SET ${sets.join(', ')} WHERE id = ?`,
        ...params,
      );

      if (input.event) {
        this.#appendEventInternal(row.team_id, row.run_id, input.event, input.now);
      }
      return toIntegration(
        this.#mustGet<IntegrationRow>(
          `SELECT ${INTEGRATION_COLUMNS} FROM team_integrations WHERE id = ?`,
          input.integrationId,
        ),
      );
    });
  }

  // ---------------------------------------------------------------- events ---

  async appendEvent(
    teamId: string,
    runId: string,
    event: NewTeamEvent,
    now?: string,
  ): Promise<TeamEvent> {
    return this.#transaction(() =>
      this.#appendEventInternal(teamId, runId, event, now ?? this.#nowIso()),
    );
  }

  async listEvents(
    runId: string,
    afterSequence: number,
    limit = DEFAULT_PAGE,
  ): Promise<TeamEvent[]> {
    return this.#all<EventRow>(
      `SELECT ${EVENT_COLUMNS} FROM team_events
        WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?`,
      runId,
      afterSequence,
      limit,
    ).map(toEvent);
  }

  async latestEventSequence(runId: string): Promise<number> {
    const row = this.#get<{ seq: number | null }>(
      'SELECT MAX(sequence) AS seq FROM team_events WHERE run_id = ?',
      runId,
    );
    return Number(row?.seq ?? 0);
  }

  // ---------------------------------------------------------------- budget ---

  async reserveBudget(input: ReserveBudgetInput): Promise<BudgetReservation> {
    return this.#transaction(() => {
      const runRow = this.#get<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM team_runs WHERE id = ?`,
        input.runId,
      );
      if (!runRow) {
        throw new TeamError('TEAM_RUN_NOT_FOUND', `run ${input.runId} not found`, 404);
      }
      const run = toRun(runRow);

      const existingRow = this.#get<BudgetRow>(
        `SELECT ${BUDGET_COLUMNS} FROM team_budget_entries
          WHERE run_id = ? AND request_key = ?`,
        input.runId,
        input.requestKey,
      );
      if (existingRow) {
        return {
          entry: toBudgetEntry(existingRow),
          snapshot: this.#budgetSnapshotFor(run),
        };
      }

      const before = this.#budgetSnapshotFor(run);
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

      try {
        this.#run(
          `INSERT INTO team_budget_entries
             (id, run_id, member_id, activation_id, request_key, generation, status,
              reserved_input_tokens, reserved_output_tokens, input_tokens, output_tokens,
              cached_tokens, estimated_cost_usd, price_version, created_at, settled_at)
           VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?, NULL, NULL, NULL, ?, ?, ?, NULL)`,
          input.id,
          input.runId,
          input.memberId,
          input.activationId,
          input.requestKey,
          input.generation,
          input.inputTokens,
          input.outputTokens,
          input.estimatedCostUsd,
          input.priceVersion,
          input.now,
        );
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const winner = this.#get<BudgetRow>(
          `SELECT ${BUDGET_COLUMNS} FROM team_budget_entries
            WHERE run_id = ? AND request_key = ?`,
          input.runId,
          input.requestKey,
        );
        if (!winner) throw error;
        return { entry: toBudgetEntry(winner), snapshot: this.#budgetSnapshotFor(run) };
      }

      if (input.event) {
        this.#appendEventInternal(run.teamId, input.runId, input.event, input.now);
      }
      return {
        entry: toBudgetEntry(
          this.#mustGet<BudgetRow>(
            `SELECT ${BUDGET_COLUMNS} FROM team_budget_entries WHERE id = ?`,
            input.id,
          ),
        ),
        snapshot: this.#budgetSnapshotFor(run),
      };
    });
  }

  async settleBudget(input: SettleBudgetInput): Promise<BudgetEntry | null> {
    return this.#transaction(() => {
      const row = this.#get<BudgetRow>(
        `SELECT ${BUDGET_COLUMNS} FROM team_budget_entries WHERE id = ?`,
        input.entryId,
      );
      if (!row || row.status !== 'reserved') return null;

      const status = input.incomplete ? 'incomplete' : 'settled';
      const estimated =
        input.estimatedCostUsd !== undefined ? input.estimatedCostUsd : row.estimated_cost_usd;
      const result = this.#run(
        `UPDATE team_budget_entries
            SET status = ?, input_tokens = ?, output_tokens = ?, cached_tokens = ?,
                estimated_cost_usd = ?, settled_at = ?
          WHERE id = ? AND status = 'reserved'`,
        status,
        input.usage.inputTokens,
        input.usage.outputTokens,
        input.usage.cachedTokens,
        estimated,
        input.now,
        input.entryId,
      );
      if (result.changes === 0) return null;

      if (input.event) {
        const run = this.#get<RunRow>(
          `SELECT ${RUN_COLUMNS} FROM team_runs WHERE id = ?`,
          row.run_id,
        );
        if (!run) throw new TeamError('TEAM_RUN_NOT_FOUND', `run ${row.run_id} not found`, 404);
        this.#appendEventInternal(run.team_id, row.run_id, input.event, input.now);
      }
      return toBudgetEntry(
        this.#mustGet<BudgetRow>(
          `SELECT ${BUDGET_COLUMNS} FROM team_budget_entries WHERE id = ?`,
          input.entryId,
        ),
      );
    });
  }

  async budgetSnapshot(runId: string): Promise<BudgetSnapshot> {
    const runRow = this.#get<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM team_runs WHERE id = ?`,
      runId,
    );
    if (!runRow) throw new TeamError('TEAM_RUN_NOT_FOUND', `run ${runId} not found`, 404);
    return this.#budgetSnapshotFor(toRun(runRow));
  }

  async listBudgetEntries(runId: string): Promise<BudgetEntry[]> {
    return this.#all<BudgetRow>(
      `SELECT ${BUDGET_COLUMNS} FROM team_budget_entries
        WHERE run_id = ? ORDER BY created_at ASC, rowid ASC`,
      runId,
    ).map(toBudgetEntry);
  }

  async runUsage(runId: string): Promise<UsageTotals> {
    const entries = await this.listBudgetEntries(runId);
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let requests = 0;
    let measuredRequests = 0;
    let incomplete = false;

    for (const entry of entries) {
      if (entry.status === 'released') continue;
      requests += 1;
      if (entry.status === 'settled') {
        inputTokens += entry.inputTokens ?? 0;
        outputTokens += entry.outputTokens ?? 0;
        cachedTokens += entry.cachedTokens ?? 0;
        if (entry.inputTokens !== null) measuredRequests += 1;
        continue;
      }
      inputTokens += entry.reservedInputTokens;
      outputTokens += entry.reservedOutputTokens;
      if (entry.status === 'incomplete') incomplete = true;
    }

    return {
      inputTokens,
      outputTokens,
      cachedTokens,
      cacheWriteTokens: 0,
      requests,
      measuredRequests,
      incomplete,
    };
  }

  // -------------------------------------------------------------- plumbing ---

  async ping(): Promise<boolean> {
    try {
      this.#statements.get('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.#statements.clear();
    this.#db.close();
  }

  // ------------------------------------------------------------- internals ---

  #nowIso(): string {
    return this.#now().toISOString();
  }

  #all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.#statements.get(sql).all(...params) as T[];
  }

  #get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.#statements.get(sql).get(...params) as T | undefined;
  }

  #mustGet<T>(sql: string, ...params: SqlValue[]): T {
    const row = this.#get<T>(sql, ...params);
    if (row === undefined) throw new Error('row disappeared inside its own transaction');
    return row;
  }

  #run(sql: string, ...params: SqlValue[]): { changes: number } {
    const result = this.#statements.get(sql).run(...params);
    return { changes: Number(result.changes) };
  }

  #transaction<T>(work: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      this.#db.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        // A failed BEGIN or an already-rolled-back transaction is not the
        // original error; keep the original.
      }
      throw error;
    }
  }

  #activeRunRow(ownerId: string, rootConversationId: string): RunRow | undefined {
    const placeholders = ACTIVE_RUN_STATUSES.map(() => '?').join(', ');
    return this.#get<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM team_runs
        WHERE owner_id = ? AND root_conversation_id = ? AND status IN (${placeholders})
        ORDER BY created_at DESC, rowid ASC LIMIT 1`,
      ownerId,
      rootConversationId,
      ...ACTIVE_RUN_STATUSES,
    );
  }

  #insertActivation(activation: Activation): void {
    this.#run(
      `INSERT INTO team_activations
         (id, run_id, member_id, request_id, generation, status, checkpoint_json, input_json,
          result_json, error, created_at, started_at, finished_at, lease_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      activation.id,
      activation.runId,
      activation.memberId,
      activation.requestId,
      activation.generation,
      activation.status,
      JSON.stringify(activation.checkpoint),
      JSON.stringify(activation.input),
      activation.result === null ? null : JSON.stringify(activation.result),
      activation.error,
      activation.createdAt,
      activation.startedAt,
      activation.finishedAt,
      activation.leaseExpiresAt,
    );
  }

  #insertAttempt(attempt: TaskAttempt): void {
    this.#run(
      `INSERT INTO team_task_attempts
         (id, task_id, activation_id, generation, lease_expires_at, baseline_id,
          submission_json, review_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      attempt.id,
      attempt.taskId,
      attempt.activationId,
      attempt.generation,
      attempt.leaseExpiresAt,
      attempt.baselineId,
      attempt.submission === null ? null : JSON.stringify(attempt.submission),
      attempt.review === null ? null : JSON.stringify(attempt.review),
      attempt.createdAt,
      attempt.updatedAt,
    );
  }

  #appendEventInternal(
    teamId: string,
    runId: string,
    event: NewTeamEvent,
    now: string,
  ): TeamEvent {
    if (event.idempotencyKey !== undefined) {
      const existing = this.#get<EventRow>(
        `SELECT ${EVENT_COLUMNS} FROM team_events
          WHERE run_id = ? AND idempotency_key = ?`,
        runId,
        event.idempotencyKey,
      );
      if (existing) return toEvent(existing);
    }

    const maxRow = this.#get<{ seq: number | null }>(
      'SELECT MAX(sequence) AS seq FROM team_events WHERE run_id = ?',
      runId,
    );
    const sequence = Number(maxRow?.seq ?? 0) + 1;
    const id = `evt_${randomUUID()}`;
    const payloadJson = JSON.stringify(event.payload ?? {});
    this.#run(
      `INSERT INTO team_events
         (id, team_id, run_id, sequence, kind, payload_json, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      teamId,
      runId,
      sequence,
      event.kind,
      payloadJson,
      event.idempotencyKey ?? null,
      now,
    );
    return {
      id,
      teamId,
      runId,
      sequence,
      kind: event.kind,
      payload: readJson<Record<string, unknown>>(payloadJson),
      idempotencyKey: event.idempotencyKey ?? null,
      createdAt: now,
    };
  }

  /**
   * A member is not scoped to a run, so a member-scoped event is attached to
   * the newest run of its team. A team belongs to one root conversation and an
   * active run blocks a second one (`TEAM_RUN_BUSY`), so the newest run is the
   * one being executed. If the team has no run there is nowhere honest to write
   * the event, and the caller hears about it instead of the event vanishing.
   */
  #appendMemberEventInternal(teamId: string, event: NewTeamEvent, now: string): TeamEvent {
    const run = this.#get<{ id: string }>(
      'SELECT id FROM team_runs WHERE team_id = ? ORDER BY created_at DESC, rowid ASC LIMIT 1',
      teamId,
    );
    if (!run) {
      throw new TeamError(
        'TEAM_RUN_NOT_FOUND',
        `team ${teamId} has no run to attach the event to`,
        404,
      );
    }
    return this.#appendEventInternal(teamId, run.id, event, now);
  }

  #budgetSnapshotFor(run: TeamRun): BudgetSnapshot {
    const entries = this.#all<BudgetRow>(
      `SELECT ${BUDGET_COLUMNS} FROM team_budget_entries
        WHERE run_id = ? ORDER BY created_at ASC, rowid ASC`,
      run.id,
    ).map(toBudgetEntry);
    return computeSnapshot(run.budget, entries);
  }
}

/** The column set an `UpdateTaskPatch` writes, in a fixed order. */
function taskSetClauses(patch: UpdateTaskPatch): { sets: string[]; params: SqlValue[] } {
  const sets: string[] = [];
  const params: SqlValue[] = [];
  if (patch.title !== undefined) {
    sets.push('title = ?');
    params.push(patch.title);
  }
  if (patch.specification !== undefined) {
    sets.push('specification = ?');
    params.push(patch.specification);
  }
  if (patch.acceptance !== undefined) {
    sets.push('acceptance = ?');
    params.push(patch.acceptance);
  }
  if (patch.required !== undefined) {
    sets.push('required = ?');
    params.push(patch.required ? 1 : 0);
  }
  if (patch.dependencies !== undefined) {
    sets.push('dependencies_json = ?');
    params.push(JSON.stringify(patch.dependencies));
  }
  if (patch.ownerId !== undefined) {
    sets.push('owner_id = ?');
    params.push(patch.ownerId);
  }
  if (patch.status !== undefined) {
    sets.push('status = ?');
    params.push(patch.status);
  }
  if (patch.writeScopes !== undefined) {
    sets.push('write_scopes_json = ?');
    params.push(JSON.stringify(patch.writeScopes));
  }
  if (patch.failureReason !== undefined) {
    sets.push('failure_reason = ?');
    params.push(patch.failureReason);
  }
  if (patch.submittedAt !== undefined) {
    sets.push('submitted_at = ?');
    params.push(patch.submittedAt);
  }
  if (patch.acceptedAt !== undefined) {
    sets.push('accepted_at = ?');
    params.push(patch.acceptedAt);
  }
  if (patch.currentAttemptId !== undefined) {
    sets.push('current_attempt_id = ?');
    params.push(patch.currentAttemptId);
  }
  return { sets, params };
}

/** Open (and, on first use, initialise) a SQLite-backed team store. */
export function openSqliteTeamStore(path: string): SqliteTeamStore {
  return new SqliteTeamStore({ path });
}
