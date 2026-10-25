/**
 * An in-process implementation of `Store`.
 *
 * Not a stub for the Postgres one — it is the store the test suite runs against,
 * which is what allows the memory, retrieval, writer and tool behaviour to be
 * exercised in CI with no service to start, no container to wait for, and no
 * flakiness. It implements the same interface with the same semantics, including
 * soft deletion and access accounting, so that a test that passes here is a
 * statement about the application's logic rather than about this file.
 *
 * It is also what the server falls back to when `DATABASE_URL` is unset, which
 * is convenient in development and unacceptable in production. `selectStore`
 * reports which one is in use so the difference is visible at startup instead of
 * discovered at the first restart.
 */

import { randomUUID } from 'node:crypto';
import type {
  ConversationListOptions,
  ConversationPatch,
  ConversationStore,
  MemoryListOptions,
  MemoryStore,
  PreferenceStore,
  RunStore,
  Store,
  AgentRunRecord,
  EvaluationCaseRecord,
  EvaluationResultRecord,
  FeedbackRecord,
  HistoryStats,
} from '../memory/store.ts';
import type {
  Conversation,
  Memory,
  MemoryDraft,
  MemoryEvent,
  MemoryPatch,
  Message,
} from '../memory/types.ts';

/**
 * Conversation rows are mutable here while `Conversation` is readonly — the
 * domain type is what callers see, this is what the store writes to.
 */
interface StoredConversation {
  id: string;
  userId: string;
  title: string | null;
  startedAt: Date;
  lastTurnAt: Date | null;
  turnCount: number;
  archivedAt: Date | null;
  messages: Message[];
}

export class InMemoryStore implements Store {
  readonly #memories = new Map<string, Memory>();
  readonly #conversations = new Map<string, StoredConversation>();
  readonly #users = new Map<string, { externalId: string | null; createdAt: Date }>();
  readonly #preferences = new Map<string, Map<string, unknown>>();
  readonly #runs = new Map<string, AgentRunRecord>();
  readonly #evaluationResults: EvaluationResultRecord[] = [];
  readonly #feedback: FeedbackRecord[] = [];
  #evaluationCases: readonly EvaluationCaseRecord[] = [];

  /**
   * The audit trail. Readable so tests can assert not just *what* was stored but
   * that a rejection was recorded — an unrecorded rejection is the failure mode
   * that makes "why doesn't it remember?" unanswerable.
   */
  readonly events: MemoryEvent[] = [];

  // ------------------------------------------------------------- users -----

  async ensureUser(userId: string, externalId?: string | null): Promise<void> {
    const existing = this.#users.get(userId);
    if (existing) {
      // Matching the Postgres `COALESCE`: a later call without an external id
      // does not erase one an earlier call supplied.
      if (externalId != null) existing.externalId = externalId;
      return;
    }
    this.#users.set(userId, { externalId: externalId ?? null, createdAt: new Date() });
  }

  /**
   * Unlike the foreign keys this store deliberately does not enforce, the
   * cascade here *is* the behaviour under test — a `deleteUser` against a store
   * that leaves the rows behind would assert nothing. So this one operation
   * mirrors the schema: everything that references the person goes, and
   * `agent_runs` survives with a null owner.
   */
  async deleteUser(userId: string): Promise<boolean> {
    if (!this.#users.delete(userId)) return false;

    const conversations = new Set(
      [...this.#conversations.values()]
        .filter((conversation) => conversation.userId === userId)
        .map((conversation) => conversation.id),
    );

    for (const [id, memory] of this.#memories) {
      if (memory.userId === userId) this.#memories.delete(id);
    }
    // Messages live inside their conversation, so this takes them with it.
    for (const id of conversations) this.#conversations.delete(id);
    this.#preferences.delete(userId);

    for (const [id, run] of this.#runs) {
      if (run.userId === userId) this.#runs.set(id, { ...run, userId: null, conversationId: null });
    }
    for (let index = this.#feedback.length - 1; index >= 0; index -= 1) {
      if (this.#feedback[index]?.userId === userId) this.#feedback.splice(index, 1);
    }
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      if (this.events[index]?.userId === userId) this.events.splice(index, 1);
    }
    return true;
  }

  async listUsersByExternalPrefix(
    prefix: string,
    options: { olderThan?: Date; limit?: number } = {},
  ): Promise<{ id: string; externalId: string }[]> {
    const cutoff = options.olderThan;
    return [...this.#users.entries()]
      .filter(([, user]) => user.externalId !== null && user.externalId.startsWith(prefix))
      .filter(([, user]) => cutoff === undefined || user.createdAt < cutoff)
      .sort((a, b) => a[1].createdAt.getTime() - b[1].createdAt.getTime())
      .slice(0, options.limit ?? 1000)
      .map(([id, user]) => ({ id, externalId: user.externalId as string }));
  }

  // ---------------------------------------------------------- memories -----

  async createMemory(userId: string, draft: MemoryDraft): Promise<Memory> {
    const now = new Date();
    const memory: Memory = {
      id: randomUUID(),
      userId,
      type: draft.type,
      content: draft.content,
      importance: draft.importance ?? 0.5,
      confidence: draft.confidence ?? 0.5,
      source: draft.source,
      status: draft.status ?? 'active',
      tags: [...(draft.tags ?? [])],
      supersededBy: null,
      sourceMessageId: draft.sourceMessageId ?? null,
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: null,
      accessCount: 0,
    };
    this.#memories.set(memory.id, memory);
    return memory;
  }

  async getMemory(userId: string, id: string): Promise<Memory | null> {
    const memory = this.#memories.get(id);
    if (!memory || memory.userId !== userId) return null;
    return memory;
  }

  async updateMemory(userId: string, id: string, patch: MemoryPatch): Promise<Memory | null> {
    const existing = await this.getMemory(userId, id);
    if (!existing) return null;

    // `undefined` means "not supplied"; an explicit value means "set to this".
    // Spreading the patch directly would turn every omitted field into an
    // overwrite with `undefined`.
    const updated: Memory = {
      ...existing,
      content: patch.content ?? existing.content,
      importance: patch.importance ?? existing.importance,
      confidence: patch.confidence ?? existing.confidence,
      status: patch.status ?? existing.status,
      tags: patch.tags ? [...patch.tags] : existing.tags,
      updatedAt: new Date(),
    };
    this.#memories.set(id, updated);
    return updated;
  }

  async deleteMemory(userId: string, id: string): Promise<boolean> {
    const updated = await this.updateMemory(userId, id, { status: 'deleted' });
    return updated !== null;
  }

  async listMemories(userId: string, options: MemoryListOptions = {}): Promise<Memory[]> {
    let results = [...this.#memories.values()].filter((memory) => memory.userId === userId);

    if (options.types && options.types.length > 0) {
      const types = new Set(options.types);
      results = results.filter((memory) => types.has(memory.type));
    }
    if (options.statuses && options.statuses.length > 0) {
      const statuses = new Set(options.statuses);
      results = results.filter((memory) => statuses.has(memory.status));
    }

    results.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    return options.limit !== undefined ? results.slice(0, options.limit) : results;
  }

  async markAccessed(userId: string, ids: readonly string[]): Promise<void> {
    const now = new Date();
    for (const id of ids) {
      const memory = this.#memories.get(id);
      if (!memory || memory.userId !== userId) continue;
      this.#memories.set(id, {
        ...memory,
        lastAccessedAt: now,
        accessCount: memory.accessCount + 1,
      });
    }
  }

  async logMemoryEvent(event: MemoryEvent): Promise<void> {
    this.events.push(event);
  }

  // ----------------------------------------------------- conversations -----

  async createConversation(userId: string, title?: string | null): Promise<Conversation> {
    const conversation: StoredConversation = {
      id: randomUUID(),
      userId,
      title: title ?? null,
      startedAt: new Date(),
      lastTurnAt: null,
      turnCount: 0,
      archivedAt: null,
      messages: [],
    };
    this.#conversations.set(conversation.id, conversation);
    return conversation;
  }

  async getConversation(userId: string, conversationId: string): Promise<Conversation | null> {
    const conversation = this.#conversations.get(conversationId);
    return conversation && conversation.userId === userId ? conversation : null;
  }

  async updateConversation(
    userId: string,
    conversationId: string,
    patch: ConversationPatch,
  ): Promise<Conversation | null> {
    const conversation = this.#conversations.get(conversationId);
    if (!conversation || conversation.userId !== userId) return null;

    if (patch.title !== undefined) conversation.title = patch.title;
    if (patch.archived !== undefined) {
      conversation.archivedAt = patch.archived ? new Date() : null;
    }
    return conversation;
  }

  async deleteConversation(userId: string, conversationId: string): Promise<boolean> {
    const conversation = this.#conversations.get(conversationId);
    if (!conversation || conversation.userId !== userId) return false;
    this.#conversations.delete(conversationId);
    return true;
  }

  async ensureConversation(userId: string, conversationId?: string | null): Promise<Conversation> {
    const id = conversationId ?? randomUUID();
    const existing = this.#conversations.get(id);
    if (existing && existing.userId === userId) return existing;

    const conversation: StoredConversation = {
      id,
      userId,
      title: null,
      startedAt: new Date(),
      lastTurnAt: null,
      turnCount: 0,
      archivedAt: null,
      messages: [],
    };
    this.#conversations.set(id, conversation);
    return conversation;
  }

  async nameConversation(userId: string, conversationId: string, title: string): Promise<void> {
    const conversation = this.#conversations.get(conversationId);
    if (!conversation || conversation.userId !== userId) return;
    // Same rule as Postgres: the first name wins.
    if (conversation.title === null) conversation.title = title;
  }

  async appendMessage(message: {
    conversationId: string;
    userId: string;
    role: Message['role'];
    content: string;
  }): Promise<Message> {
    const conversation = this.#conversations.get(message.conversationId);
    if (!conversation || conversation.userId !== message.userId) {
      throw new Error(`unknown conversation ${message.conversationId} for this user`);
    }

    const stored: Message = {
      id: randomUUID(),
      conversationId: message.conversationId,
      userId: message.userId,
      role: message.role,
      content: message.content,
      createdAt: new Date(),
    };
    conversation.messages.push(stored);
    if (message.role === 'user') conversation.turnCount += 1;
    conversation.lastTurnAt = stored.createdAt;
    // Same rule as Postgres: writing into an archived thread resumes it.
    conversation.archivedAt = null;
    return stored;
  }

  async recentMessages(conversationId: string, limit: number): Promise<Message[]> {
    const conversation = this.#conversations.get(conversationId);
    if (!conversation) return [];
    return conversation.messages.slice(-limit);
  }

  async historyStats(userId: string): Promise<HistoryStats> {
    const conversations = [...this.#conversations.values()].filter(
      (conversation) => conversation.userId === userId,
    );
    const messages = conversations.flatMap((conversation) => conversation.messages);

    const times = (dates: (Date | null)[]): number[] =>
      dates.filter((date): date is Date => date instanceof Date).map((date) => date.getTime());

    const starts = times(conversations.map((conversation) => conversation.startedAt));
    const sent = times(messages.map((message) => message.createdAt));

    return {
      conversations: conversations.length,
      messages: messages.length,
      firstAt: starts.length > 0 ? new Date(Math.min(...starts)) : null,
      lastAt: sent.length > 0 ? new Date(Math.max(...sent)) : null,
    };
  }

  async listConversations(
    userId: string,
    options: ConversationListOptions = {},
  ): Promise<Conversation[]> {
    const limit = options.limit ?? 30;
    return [...this.#conversations.values()]
      .filter((conversation) => conversation.userId === userId)
      .filter((conversation) => options.includeArchived || conversation.archivedAt === null)
      .sort((a, b) => {
        // Active rows first, then archived; within each group, newest first.
        const archived = Number(a.archivedAt !== null) - Number(b.archivedAt !== null);
        if (archived !== 0) return archived;
        return (b.lastTurnAt?.getTime() ?? 0) - (a.lastTurnAt?.getTime() ?? 0);
      })
      .slice(0, limit);
  }

  async listMessages(userId: string, conversationId: string, limit = 200): Promise<Message[]> {
    const conversation = this.#conversations.get(conversationId);
    if (!conversation || conversation.userId !== userId) return [];
    return conversation.messages.slice(-limit);
  }

  // --------------------------------------------------------------- runs -----

  async recordRun(run: AgentRunRecord): Promise<void> {
    this.#runs.set(run.id, run);
  }

  async finishRun(
    id: string,
    patch: Partial<Omit<AgentRunRecord, 'id' | 'userId' | 'conversationId' | 'model' | 'promptVersion'>>,
  ): Promise<void> {
    const existing = this.#runs.get(id);
    if (!existing) return;
    this.#runs.set(id, { ...existing, ...patch });
  }

  async upsertEvaluationCases(cases: readonly EvaluationCaseRecord[]): Promise<void> {
    this.#evaluationCases = [...cases];
  }

  async saveEvaluationResults(results: readonly EvaluationResultRecord[]): Promise<void> {
    this.#evaluationResults.push(...results);
  }

  /** Read back what was persisted, so tests can assert on it. */
  get evaluationResults(): readonly EvaluationResultRecord[] {
    return this.#evaluationResults;
  }

  /**
   * The run audit trail. Exposed for the same reason `events` is: "was this turn
   * recorded, and as what?" is a question the tests have to be able to ask.
   */
  get runs(): readonly AgentRunRecord[] {
    return [...this.#runs.values()];
  }

  get evaluationCases(): readonly EvaluationCaseRecord[] {
    return this.#evaluationCases;
  }

  // -------------------------------------------------------- preferences -----

  async getPreference(userId: string, key: string): Promise<unknown | null> {
    return this.#preferences.get(userId)?.get(key) ?? null;
  }

  async setPreference(userId: string, key: string, value: unknown): Promise<void> {
    const forUser = this.#preferences.get(userId) ?? new Map<string, unknown>();
    forUser.set(key, value);
    this.#preferences.set(userId, forUser);
  }

  async listPreferences(userId: string): Promise<Record<string, unknown>> {
    return Object.fromEntries(this.#preferences.get(userId) ?? []);
  }

  // ------------------------------------------------------------ feedback -----

  async saveFeedback(feedback: {
    messageId: string;
    userId: string;
    rating: 'good' | 'bad';
    note?: string | null;
  }): Promise<void> {
    const index = this.#feedback.findIndex(
      (entry) => entry.messageId === feedback.messageId && entry.userId === feedback.userId,
    );
    const record: FeedbackRecord = {
      messageId: feedback.messageId,
      userId: feedback.userId,
      rating: feedback.rating,
      note: feedback.note ?? null,
      createdAt: new Date(),
    };
    if (index >= 0) this.#feedback[index] = record;
    else this.#feedback.push(record);
  }

  async listFeedback(userId: string, limit = 100): Promise<FeedbackRecord[]> {
    return this.#feedback
      .filter((entry) => entry.userId === userId)
      .slice(-limit)
      .reverse();
  }

  // ------------------------------------------------------------ plumbing -----

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    this.#memories.clear();
    this.#conversations.clear();
    this.#preferences.clear();
    this.#runs.clear();
    this.#users.clear();
  }
}

/** Narrow the composite to its parts, for tests that only need one. */
export function asMemoryStore(store: Store): MemoryStore {
  return store;
}
export function asConversationStore(store: Store): ConversationStore {
  return store;
}
export function asRunStore(store: Store): RunStore {
  return store;
}
export function asPreferenceStore(store: Store): PreferenceStore {
  return store;
}
