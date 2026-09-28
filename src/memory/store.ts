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

export interface MemoryStore {
  /** Idempotent: returns the existing row if the user is already known. */
  ensureUser(userId: string): Promise<void>;

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

export interface ConversationStore {
  ensureConversation(userId: string, conversationId?: string | null): Promise<Conversation>;
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
  extends MemoryStore,
    ConversationStore,
    RunStore,
    PreferenceStore,
    FeedbackStore {
  /** Cheap liveness probe used by `GET /health`. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}
