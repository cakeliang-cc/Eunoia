/**
 * The persistence port for memory (ADR 002/003).
 *
 * Two implementations satisfy it: `src/db/postgres-store.ts` for real use and
 * `src/db/in-memory-store.ts` for tests and for running without Docker. The
 * in-memory one is not a toy — it is what lets the entire memory, retrieval and
 * write-policy suite run in CI with no service dependency, which is the
 * difference between tests that get run and tests that get skipped.
 *
 * The interface is deliberately expressed in domain types, never in rows or SQL.
 * A future store on a different engine should be able to satisfy it without
 * anything above this line changing.
 */

import type {
  Conversation,
  Memory,
  MemoryDraft,
  MemoryEvent,
  MemoryPatch,
  Message,
} from './types.ts';

export interface MemoryListOptions {
  readonly types?: readonly string[];
  readonly statuses?: readonly string[];
  readonly limit?: number;
}

export interface AgentRunRecord {
  readonly id: string;
  readonly userId: string | null;
  readonly conversationId: string | null;
  readonly model: string;
  readonly promptVersion: string;
  readonly status: 'running' | 'completed' | 'failed' | 'safety_replaced';
  readonly usedTools: boolean;
  readonly toolCalls: readonly string[];
  readonly inputFingerprint: string | null;
  readonly outputFingerprint: string | null;
  readonly riskLevel: 'none' | 'elevated' | 'crisis' | null;
  readonly durationMs: number | null;
  readonly error: string | null;
}

export interface EvaluationResultRecord {
  readonly runId: string;
  readonly caseId: string;
  readonly reply: string | null;
  readonly passed: boolean;
  readonly score: number;
  readonly promptVersion: string;
  readonly model: string;
  readonly mode: 'live' | 'recorded';
  readonly violations: readonly string[];
}

/**
 * Who exists, and how they stop existing.
 *
 * Kept apart from `MemoryStore` because the person is not a memory: deleting a
 * memory is a soft delete on purpose (the audit trail in `memory_events` keeps
 * pointing at a real row), and there is no equivalent argument for keeping a
 * person who has asked to be removed.
 *
 * This interface exists because spec §44 lists `retention` and `deletion` and
 * the project had neither — memories could be deleted one at a time by their
 * owner, and the throwaway users evaluation runs create accumulated in a shared
 * database with nothing that could ever remove them.
 */
export interface IdentityStore {
  /**
   * Idempotent: does nothing if the user is already known.
   *
   * `externalId` is a stable identifier from whatever system supplied this
   * identity — the mini-program's openid, or an evaluation run's case handle.
   * Namespacing (`eval:`, a future openid) is a convention between callers, not
   * something the column enforces, because the database has no business knowing
   * which systems exist.
   */
  ensureUser(userId: string, externalId?: string | null): Promise<void>;

  /**
   * Remove the person and everything that hangs off them.
   *
   * Hard delete, and one statement: every table that holds their content
   * references `users(id) ON DELETE CASCADE`, so the database does the work
   * rather than a sequence of deletes that can half-fail.
   *
   * What deliberately survives is the *measurement*, not the person.
   * `agent_runs` is `ON DELETE SET NULL` — the row is observability, its
   * fingerprints are sizes and hashes and never content (spec §14), and a run
   * whose user has been erased is still a data point about this prompt version.
   * `evaluation_results` never referenced a user at all.
   *
   * Returns false if there was nothing to delete, which is not an error: the
   * caller asked for a state, and that state already held.
   */
  deleteUser(userId: string): Promise<boolean>;

  /**
   * Users handed an identity by some external system, by prefix.
   *
   * The one query a retention sweep needs, and the reason `external_id` is
   * finally written. An earlier attempt made evaluation users greppable by
   * putting the case id inside `users.id`, which failed against Postgres on the
   * first insert because that column is a `uuid` — the in-memory store accepts
   * any string, so no offline test could have caught it. The intent was right;
   * it was aimed at the wrong column.
   */
  listUsersByExternalPrefix(
    prefix: string,
    options?: { olderThan?: Date; limit?: number },
  ): Promise<{ id: string; externalId: string }[]>;
}

export interface MemoryStore {
  createMemory(userId: string, draft: MemoryDraft): Promise<Memory>;
  getMemory(userId: string, id: string): Promise<Memory | null>;
  updateMemory(userId: string, id: string, patch: MemoryPatch): Promise<Memory | null>;
  /**
   * Soft delete: sets `status = 'deleted'` rather than removing the row, so the
   * audit trail in `memory_events` keeps referring to something real.
   */
  deleteMemory(userId: string, id: string): Promise<boolean>;
  listMemories(userId: string, options?: MemoryListOptions): Promise<Memory[]>;
  /** Increments access counts and refreshes `last_accessed_at` in one statement. */
  markAccessed(userId: string, ids: readonly string[]): Promise<void>;
  logMemoryEvent(event: MemoryEvent): Promise<void>;
}

/**
 * How much has passed between us (spec §25, §43).
 *
 * Counts and two dates, not a state machine: the companion needs to know whether
 * this is a first conversation or a two-hundredth, and that question is answered
 * by arithmetic rather than by a category someone invented.
 */
export interface HistoryStats {
  readonly conversations: number;
  readonly messages: number;
  /** When the first conversation started, or null if there has never been one. */
  readonly firstAt: Date | null;
  /** The most recent message, or null in the same case. */
  readonly lastAt: Date | null;
}

export interface ConversationStore {
  ensureConversation(userId: string, conversationId?: string | null): Promise<Conversation>;

  /**
   * The relationship, derived in one query rather than by loading rows.
   *
   * Deliberately not a stored table. A `relationship` row would need a
   * migration, would say something different from the conversations it
   * summarises the moment one was deleted, and would be a cache of an
   * aggregate — which is the definition of a thing that goes stale to save
   * nothing.
   */
  historyStats(userId: string): Promise<HistoryStats>;
  /**
   * Give a conversation a name, from its first user message.
   *
   * Set once and never replaced: `title IS NULL` is part of the update, so the
   * first turn names the conversation and every later turn leaves it alone. A
   * title that tracked the latest message would be a worse label than one that
   * says what the conversation was *about*, and re-deriving it every turn would
   * make the list flicker.
   */
  nameConversation(userId: string, conversationId: string, title: string): Promise<void>;
  appendMessage(message: {
    conversationId: string;
    userId: string;
    role: Message['role'];
    content: string;
  }): Promise<Message>;
  recentMessages(conversationId: string, limit: number): Promise<Message[]>;
  listConversations(userId: string, limit?: number): Promise<Conversation[]>;
  listMessages(userId: string, conversationId: string, limit?: number): Promise<Message[]>;
}

export interface EvaluationCaseRecord {
  readonly id: string;
  readonly category: string;
  readonly title: string;
  readonly userMessage: string;
  readonly expectedBehaviors: readonly string[];
  readonly forbiddenBehaviors: readonly string[];
  readonly checks: readonly unknown[];
}

export interface RunStore {
  recordRun(run: AgentRunRecord): Promise<void>;
  /**
   * Mirror the in-code case definitions into `evaluation_cases`.
   *
   * The cases live in `src/evaluation/cases.ts` because they are versioned with
   * the prompt. The table exists so `evaluation_results` can reference them with
   * a foreign key, which means it has to be refreshed whenever the code changes.
   * That is a small sync problem, taken deliberately: the alternative is results
   * that point at case IDs nothing can resolve.
   */
  upsertEvaluationCases(cases: readonly EvaluationCaseRecord[]): Promise<void>;
  /** Partial update; only the fields present are written. */
  finishRun(
    id: string,
    patch: Partial<Omit<AgentRunRecord, 'id' | 'userId' | 'conversationId' | 'model' | 'promptVersion'>>,
  ): Promise<void>;
  saveEvaluationResults(results: readonly EvaluationResultRecord[]): Promise<void>;
}

export interface PreferenceStore {
  getPreference(userId: string, key: string): Promise<unknown | null>;
  setPreference(userId: string, key: string, value: unknown): Promise<void>;
  listPreferences(userId: string): Promise<Record<string, unknown>>;
}

export interface FeedbackRecord {
  readonly messageId: string;
  readonly userId: string;
  readonly rating: 'good' | 'bad';
  readonly note: string | null;
  readonly createdAt: Date;
}

export interface FeedbackStore {
  /** Upsert: a person changing their mind replaces their earlier rating. */
  saveFeedback(feedback: {
    messageId: string;
    userId: string;
    rating: 'good' | 'bad';
    note?: string | null;
  }): Promise<void>;
  listFeedback(userId: string, limit?: number): Promise<FeedbackRecord[]>;
}

/** Everything the application needs from persistence, in one wiring handle. */
export interface Store
  extends IdentityStore,
    MemoryStore,
    ConversationStore,
    RunStore,
    PreferenceStore,
    FeedbackStore {
  /** Cheap liveness probe used by `GET /health`. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}
