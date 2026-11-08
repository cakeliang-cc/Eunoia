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
 * It is also what `STORE=memory` selects, which is convenient for a throwaway
 * experiment and unacceptable as a default: a server that forgets everything on
 * restart is exactly the failure the SQLite store exists to prevent. `selectStore`
 * reports which one is in use so the difference is visible at startup.
 */

import { randomUUID } from 'node:crypto';
import type {
  AgentRunRecord,
  EvaluationCaseRecord,
  EvaluationResultRecord,
  FeedbackRecord,
  MemoryListOptions,
  PreferenceStore,
  RunStore,
} from '../memory/store.ts';
import type {
  Memory,
  MemoryDraft,
  MemoryEvent,
  MemoryPatch,
} from '../memory/types.ts';
import type {
  ConversationListOptions,
  ConversationPatch,
  SessionStore,
} from '../session/store.ts';
import type { CreateTurnResult, TurnStore } from '../session/turn-store.ts';
import type {
  CreateEpochInput,
  ModelTranscriptStore,
  PrepareStepInput,
  PrepareStepResult,
  StepPatch,
} from '../session/model-transcript-store.ts';
import { TranscriptRevisionConflictError } from '../session/model-transcript-store.ts';
import type {
  ModelContextState,
  ModelEpoch,
  ModelItem,
  ModelStepRecord,
  NewModelContextState,
  NewModelItem,
} from '../session/model-transcript.ts';
import { itemContentHash, MODEL_TRANSCRIPT_VERSION } from '../session/model-transcript.ts';
import type {
  NewTurnEvent,
  TurnEventRecord,
  TurnFinishPatch,
  TurnRecord,
} from '../session/turn-types.ts';
import type { Conversation, ConversationSummary, HistoryStats, Message } from '../session/types.ts';
import type { Store } from '../store.ts';
import type { UserContentV1 } from '../agent/content.ts';
import { contentText } from '../agent/content.ts';
import type { ImageAsset } from '../media/types.ts';
import type { MediaAssetStore } from '../media/store.ts';
import type { WebDocumentRecord } from '../web/store.ts';
import type { UserQuestionRecord, QuestionStatus } from '../questions/types.ts';
import type { DevJobRecord } from '../processes/types.ts';
import type {
  ChangesetFileRecord,
  ChangesetStatus,
  NewChangesetInput,
  WorkspaceChangesetRecord,
  WorkspaceChangesetSummary,
} from '../session/changeset.ts';

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
  modelId: string | null;
  messages: Message[];
}

export class InMemoryStore implements Store, TurnStore, MediaAssetStore, ModelTranscriptStore {
  readonly #memories = new Map<string, Memory>();
  readonly #conversations = new Map<string, StoredConversation>();
  readonly #summaries = new Map<string, ConversationSummary>();
  readonly #users = new Map<string, { externalId: string | null; createdAt: Date }>();
  readonly #preferences = new Map<string, Map<string, unknown>>();
  readonly #runs = new Map<string, AgentRunRecord>();
  readonly #evaluationResults: EvaluationResultRecord[] = [];
  readonly #feedback: FeedbackRecord[] = [];
  readonly #turns = new Map<string, TurnRecord>();
  readonly #turnEvents: TurnEventRecord[] = [];
  readonly #media = new Map<string, ImageAsset>();
  readonly #changesets = new Map<string, WorkspaceChangesetRecord>();
  readonly #webDocuments = new Map<string, WebDocumentRecord>();
  readonly #questions = new Map<string, UserQuestionRecord>();
  readonly #devJobs = new Map<string, DevJobRecord>();
  /** Message id → asset ids in content order; the reference index. */
  readonly #messageAssets = new Map<string, string[]>();
  /** Model transcript state (ADR 032). */
  readonly #epochs = new Map<string, ModelEpoch>();
  readonly #modelItems = new Map<string, ModelItem>();
  readonly #itemKeys = new Map<string, string>();
  readonly #itemsByConversation = new Map<string, string[]>();
  readonly #steps = new Map<string, ModelStepRecord>();
  readonly #contextState = new Map<string, ModelContextState>();
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
    for (const id of conversations) {
      this.#conversations.delete(id);
      this.#summaries.delete(id);
      this.#deleteTranscript(id);
    }
    for (const [id, asset] of this.#media) {
      if (asset.userId === userId) this.#media.delete(id);
    }
    for (const messageId of [...this.#messageAssets.keys()]) {
      if (!this.#messageExists(messageId)) this.#messageAssets.delete(messageId);
    }
    this.#preferences.delete(userId);

    for (const [id, run] of this.#runs) {
      if (run.userId === userId) this.#runs.set(id, { ...run, userId: null, conversationId: null });
    }
    for (const [id, turn] of this.#turns) {
      if (turn.userId === userId) this.#turns.delete(id);
    }
    for (let index = this.#turnEvents.length - 1; index >= 0; index -= 1) {
      if (this.#turnEvents[index]?.conversationId && conversations.has(this.#turnEvents[index]!.conversationId)) {
        this.#turnEvents.splice(index, 1);
      }
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

  async recordRetrieval(input: {
    userId: string;
    memoryIds: readonly string[];
    event: MemoryEvent;
  }): Promise<void> {
    await this.markAccessed(input.userId, input.memoryIds);
    await this.logMemoryEvent(input.event);
  }

  // ----------------------------------------------------- conversations -----

  async createConversation(
    userId: string,
    title?: string | null,
    modelId?: string | null,
  ): Promise<Conversation> {
    const conversation: StoredConversation = {
      id: randomUUID(),
      userId,
      title: title ?? null,
      startedAt: new Date(),
      lastTurnAt: null,
      turnCount: 0,
      archivedAt: null,
      modelId: modelId ?? null,
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
    if (patch.modelId !== undefined) conversation.modelId = patch.modelId;
    return conversation;
  }

  async deleteConversation(userId: string, conversationId: string): Promise<boolean> {
    const conversation = this.#conversations.get(conversationId);
    if (!conversation || conversation.userId !== userId) return false;
    this.#conversations.delete(conversationId);
    this.#summaries.delete(conversationId);
    this.#deleteTranscript(conversationId);
    for (const [id, asset] of this.#media) {
      if (asset.conversationId === conversationId) this.#media.delete(id);
    }
    for (const messageId of [...this.#messageAssets.keys()]) {
      if (!this.#messageExists(messageId)) this.#messageAssets.delete(messageId);
    }
    for (const [id, turn] of this.#turns) {
      if (turn.conversationId === conversationId) this.#turns.delete(id);
    }
    for (let index = this.#turnEvents.length - 1; index >= 0; index -= 1) {
      if (this.#turnEvents[index]?.conversationId === conversationId) {
        this.#turnEvents.splice(index, 1);
      }
    }
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
      modelId: null,
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
    interrupted?: boolean;
    contentParts?: UserContentV1 | null;
    assetIds?: readonly string[];
  }): Promise<Message> {
    const conversation = this.#conversations.get(message.conversationId);
    if (!conversation || conversation.userId !== message.userId) {
      throw new Error(`unknown conversation ${message.conversationId} for this user`);
    }
    if (message.contentParts && message.contentParts.version !== 1) {
      throw new Error(`unsupported content version ${String(message.contentParts.version)}`);
    }
    const projection = message.contentParts ? contentText(message.contentParts) : message.content;
    const assetIds = message.role === 'user' ? (message.assetIds ?? []) : [];
    for (const assetId of assetIds) {
      const asset = this.#media.get(assetId);
      if (
        !asset ||
        asset.userId !== message.userId ||
        asset.conversationId !== message.conversationId ||
        asset.status === 'released'
      ) {
        throw new Error(`media asset ${assetId} is not available to this conversation`);
      }
    }

    const stored: Message = {
      id: randomUUID(),
      conversationId: message.conversationId,
      userId: message.userId,
      role: message.role,
      content: projection,
      contentParts: message.contentParts ?? null,
      interrupted: message.interrupted ?? false,
      createdAt: new Date(),
      seq: (conversation.messages.at(-1)?.seq ?? 0) + 1,
    };
    conversation.messages.push(stored);
    if (assetIds.length > 0) {
      this.#messageAssets.set(stored.id, [...assetIds]);
      for (const assetId of assetIds) {
        const asset = this.#media.get(assetId);
        if (asset) this.#media.set(assetId, { ...asset, status: 'bound' });
      }
    }
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

  async messagesAfter(
    conversationId: string,
    afterSeq: number,
    limit: number,
  ): Promise<Message[]> {
    const conversation = this.#conversations.get(conversationId);
    if (!conversation) return [];
    return conversation.messages.filter((message) => message.seq > afterSeq).slice(0, limit);
  }

  async lastUserMessage(userId: string, conversationId: string): Promise<Message | null> {
    const conversation = this.#conversations.get(conversationId);
    if (!conversation || conversation.userId !== userId) return null;
    for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
      const message = conversation.messages[index];
      if (message?.role === 'user') return message;
    }
    return null;
  }

  async deleteMessagesAfter(userId: string, conversationId: string, seq: number): Promise<number> {
    const conversation = this.#conversations.get(conversationId);
    if (!conversation || conversation.userId !== userId) return 0;
    const before = conversation.messages.length;
    conversation.messages = conversation.messages.filter((message) => message.seq <= seq);
    // `turn_count` is the number of user messages, and the tail that was just
    // removed is an assistant reply, so this only matters for a generic caller.
    conversation.turnCount = conversation.messages.filter(
      (message) => message.role === 'user',
    ).length;
    conversation.lastTurnAt = conversation.messages.at(-1)?.createdAt ?? null;
    for (const [messageId] of this.#messageAssets) {
      if (!conversation.messages.some((entry) => entry.id === messageId)) {
        this.#messageAssets.delete(messageId);
      }
    }
    this.#releaseUnreferencedAssets(conversationId);
    return before - conversation.messages.length;
  }

  async getSummary(conversationId: string): Promise<ConversationSummary | null> {
    return this.#summaries.get(conversationId) ?? null;
  }

  async saveSummary(summary: ConversationSummary): Promise<void> {
    this.#summaries.set(summary.conversationId, summary);
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


  // --------------------------------------------------------------- media -----

  async createMediaAsset(asset: ImageAsset): Promise<void> {
    this.#media.set(asset.id, asset);
  }

  async getMediaAsset(userId: string, assetId: string): Promise<ImageAsset | null> {
    const asset = this.#media.get(assetId);
    return asset && asset.userId === userId ? asset : null;
  }

  async listMediaAssets(userId: string, assetIds: readonly string[]): Promise<ImageAsset[]> {
    return assetIds
      .map((id) => this.#media.get(id))
      .filter((asset): asset is ImageAsset => asset !== undefined && asset.userId === userId);
  }

  async listConversationMedia(userId: string, conversationId: string): Promise<ImageAsset[]> {
    return [...this.#media.values()]
      .filter((asset) => asset.userId === userId && asset.conversationId === conversationId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async listUserMedia(userId: string): Promise<ImageAsset[]> {
    return [...this.#media.values()]
      .filter((asset) => asset.userId === userId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async messageAssetIds(messageId: string): Promise<string[]> {
    return [...(this.#messageAssets.get(messageId) ?? [])];
  }

  async setMediaLease(
    userId: string,
    assetIds: readonly string[],
    until: Date | null,
  ): Promise<void> {
    for (const id of assetIds) {
      const asset = this.#media.get(id);
      if (asset && asset.userId === userId) {
        this.#media.set(id, { ...asset, leaseExpiresAt: until });
      }
    }
  }

  async deletePendingMediaAsset(
    userId: string,
    assetId: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    const asset = this.#media.get(assetId);
    if (
      !asset ||
      asset.userId !== userId ||
      asset.status !== 'pending' ||
      (asset.leaseExpiresAt !== null && asset.leaseExpiresAt > now) ||
      this.#assetReferenced(assetId)
    ) {
      return false;
    }
    this.#media.delete(assetId);
    return true;
  }

  async bindMediaAsset(userId: string, assetId: string): Promise<void> {
    const asset = this.#media.get(assetId);
    if (!asset || asset.userId !== userId || asset.status !== 'pending') return;
    this.#media.set(assetId, { ...asset, status: 'bound', leaseExpiresAt: null });
  }

  async deleteMediaAssets(assetIds: readonly string[]): Promise<void> {
    for (const id of assetIds) this.#media.delete(id);
  }

  async listCollectableMedia(now: Date, graceMs: number): Promise<ImageAsset[]> {
    const cutoff = now.getTime() - graceMs;
    return [...this.#media.values()]
      .filter((asset) => asset.createdAt.getTime() <= cutoff)
      .filter((asset) => asset.leaseExpiresAt === null || asset.leaseExpiresAt <= now)
      .filter(
        (asset) =>
          asset.status === 'released' ||
          (asset.status === 'pending' && !this.#assetReferenced(asset.id)),
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async releaseUnreferencedAssets(conversationId: string): Promise<void> {
    this.#releaseUnreferencedAssets(conversationId);
  }

  #releaseUnreferencedAssets(conversationId: string): void {
    for (const [id, asset] of this.#media) {
      if (asset.conversationId !== conversationId || asset.status !== 'bound') continue;
      if (!this.#assetReferenced(id)) {
        this.#media.set(id, { ...asset, status: 'released', leaseExpiresAt: null });
      }
    }
  }

  #assetReferenced(assetId: string): boolean {
    for (const ids of this.#messageAssets.values()) {
      if (ids.includes(assetId)) return true;
    }
    // A replayed model item also references the image. Dropping the UI message
    // on regeneration must not let the collector remove bytes the active window
    // can still replay.
    for (const item of this.#modelItems.values()) {
      if (JSON.stringify(item.payload).includes(assetId)) return true;
    }
    return false;
  }

  #messageExists(messageId: string): boolean {
    for (const conversation of this.#conversations.values()) {
      if (conversation.messages.some((message) => message.id === messageId)) return true;
    }
    return false;
  }

  // --------------------------------------------------------------- turns -----

  async createTurn(record: TurnRecord): Promise<CreateTurnResult> {
    // Synchronous on purpose: the check and the insert must not be separated by
    // an await, or two callers could both pass the check. This is the same
    // guarantee the SQLite partial unique index gives.
    if (this.#turns.has(record.id)) return 'exists';
    for (const turn of this.#turns.values()) {
      if (turn.conversationId === record.conversationId && turn.status === 'running') {
        return 'busy';
      }
    }
    this.#turns.set(record.id, record);
    return 'created';
  }

  async getTurn(id: string): Promise<TurnRecord | null> {
    return this.#turns.get(id) ?? null;
  }

  async activeTurn(conversationId: string): Promise<TurnRecord | null> {
    for (const turn of this.#turns.values()) {
      if (turn.conversationId === conversationId && turn.status === 'running') return turn;
    }
    return null;
  }

  async finishTurn(id: string, patch: TurnFinishPatch): Promise<TurnRecord | null> {
    const existing = this.#turns.get(id);
    if (!existing || existing.status !== 'running') return existing ?? null;
    const updated: TurnRecord = {
      ...existing,
      status: patch.status,
      finishReason: patch.finishReason,
      reply: patch.reply ?? existing.reply,
      messageId: patch.messageId !== undefined ? patch.messageId : existing.messageId,
      error: patch.error !== undefined ? patch.error : existing.error,
      steps: patch.steps ?? existing.steps,
      contextTokens: patch.contextTokens !== undefined ? patch.contextTokens : existing.contextTokens,
      accepted: patch.accepted ?? existing.accepted,
      acceptance: patch.acceptance ?? existing.acceptance,
      usage: patch.usage !== undefined ? patch.usage : existing.usage,
      turnUsage: patch.turnUsage !== undefined ? patch.turnUsage : existing.turnUsage,
      endedAt: new Date(),
    };
    this.#turns.set(id, updated);
    return updated;
  }

  async listRunningTurns(): Promise<TurnRecord[]> {
    return [...this.#turns.values()]
      .filter((turn) => turn.status === 'running')
      .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  }

  async appendTurnEvent(event: NewTurnEvent): Promise<TurnEventRecord> {
    const existing = this.#turnEvents.filter((entry) => entry.turnId === event.turnId);
    const seq = (existing.at(-1)?.seq ?? 0) + 1;
    const stored: TurnEventRecord = {
      turnId: event.turnId,
      conversationId: event.conversationId,
      seq,
      kind: event.kind,
      callId: event.callId ?? null,
      toolName: event.toolName ?? null,
      status: event.status,
      executionId: event.executionId ?? null,
      payload: { ...(event.payload ?? {}) },
      createdAt: new Date(),
    };
    this.#turnEvents.push(stored);
    return stored;
  }

  async listTurnEvents(turnId: string): Promise<TurnEventRecord[]> {
    return this.#turnEvents
      .filter((entry) => entry.turnId === turnId)
      .sort((a, b) => a.seq - b.seq);
  }

  async listConversationTurnEvents(
    conversationId: string,
    options: { readonly before?: Date; readonly limit?: number } = {},
  ): Promise<TurnEventRecord[]> {
    const before = options.before?.getTime();
    const limit = Math.max(1, Math.min(options.limit ?? 4_000, 20_000));
    return this.#turnEvents
      .filter(
        (entry) =>
          entry.conversationId === conversationId &&
          (before === undefined || entry.createdAt.getTime() <= before),
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.seq - b.seq)
      .slice(-limit);
  }

  async settleTurnEvent(
    turnId: string,
    seq: number,
    status: TurnEventRecord['status'],
    detail?: Record<string, unknown>,
  ): Promise<void> {
    const index = this.#turnEvents.findIndex((entry) => entry.turnId === turnId && entry.seq === seq);
    if (index < 0) return;
    const current = this.#turnEvents[index]!;
    this.#turnEvents[index] = {
      ...current,
      status,
      executionId:
        typeof detail?.executionId === 'string' ? detail.executionId : current.executionId,
      payload: detail ? { ...current.payload, ...detail } : current.payload,
    };
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


  // ---------------------------------------------------- model transcript -----

  async createEpoch(input: CreateEpochInput): Promise<ModelEpoch> {
    const existing = [...this.#epochs.values()].find(
      (epoch) => epoch.conversationId === input.conversationId && epoch.endedAt === null,
    );
    if (existing) {
      this.#epochs.set(existing.id, { ...existing, endedAt: input.createdAt });
    }
    this.#assertItemsBelongToConversation(input.conversationId, input.windowItemIds);
    const epoch: ModelEpoch = {
      id: input.id,
      userId: input.userId,
      conversationId: input.conversationId,
      parentEpochId: input.parentEpochId,
      reason: input.reason,
      instructions: input.instructions,
      promptVersion: input.promptVersion,
      tools: input.tools,
      toolsHash: input.toolsHash,
      providerId: input.providerId,
      modelId: input.modelId,
      protocolRevision: input.protocolRevision,
      encoderRevision: input.encoderRevision,
      windowItemIds: [...input.windowItemIds],
      windowRevision: input.windowRevision,
      seededThroughSeq: input.seededThroughSeq,
      createdAt: input.createdAt,
      endedAt: null,
    };
    this.#epochs.set(epoch.id, epoch);
    return epoch;
  }

  async activeEpoch(conversationId: string): Promise<ModelEpoch | null> {
    return (
      [...this.#epochs.values()].find(
        (epoch) => epoch.conversationId === conversationId && epoch.endedAt === null,
      ) ?? null
    );
  }

  async listEpochs(conversationId: string): Promise<ModelEpoch[]> {
    return [...this.#epochs.values()]
      .filter((epoch) => epoch.conversationId === conversationId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async getEpoch(epochId: string): Promise<ModelEpoch | null> {
    return this.#epochs.get(epochId) ?? null;
  }

  async appendItems(items: readonly NewModelItem[]): Promise<ModelItem[]> {
    return items.map((entry) => this.#appendItem(entry));
  }

  async listItems(conversationId: string, ids?: readonly string[]): Promise<ModelItem[]> {
    const wanted = ids ? new Set(ids) : null;
    const order = this.#itemsByConversation.get(conversationId) ?? [];
    return order
      .map((id) => this.#modelItems.get(id))
      .filter((item): item is ModelItem => item !== undefined && (!wanted || wanted.has(item.id)));
  }

  async listEpochItems(epochId: string): Promise<ModelItem[]> {
    return [...this.#modelItems.values()]
      .filter((item) => item.epochId === epochId)
      .sort((a, b) => a.seq - b.seq);
  }

  async knownMessageIds(conversationId: string): Promise<Set<string>> {
    const set = new Set<string>();
    for (const id of this.#itemsByConversation.get(conversationId) ?? []) {
      const messageId = this.#modelItems.get(id)?.messageId;
      if (messageId) set.add(messageId);
    }
    return set;
  }

  async contextState(conversationId: string, epochId: string): Promise<ModelContextState[]> {
    return [...this.#contextState.values()].filter(
      (state) => state.conversationId === conversationId && state.epochId === epochId,
    );
  }

  async saveContextState(states: readonly NewModelContextState[]): Promise<void> {
    for (const state of states) this.#applyState(state);
  }

  async updateWindow(
    epochId: string,
    expectedRevision: number,
    itemIds: readonly string[],
  ): Promise<ModelEpoch> {
    return this.#applyWindow({ epochId, expectedRevision, itemIds });
  }

  async prepareStep(input: PrepareStepInput): Promise<PrepareStepResult> {
    const dedupeKey = `${input.step.requestId}\u0000${input.step.step}\u0000${input.step.attemptNo}`;
    const existing = [...this.#steps.values()].find(
      (step) =>
        step.requestId === input.step.requestId &&
        step.step === input.step.step &&
        step.attemptNo === input.step.attemptNo,
    );
    if (existing) {
      const items = await this.listItems(input.step.conversationId, input.step.inputItemIds);
      return {
        items,
        step: existing,
        epoch: this.#epochs.get(existing.epochId) ?? null,
      };
    }
    void dedupeKey;

    const appended = input.items.map((entry) => this.#appendItem(entry));
    let epoch = this.#epochs.get(input.step.epochId) ?? null;
    if (input.window) {
      epoch = this.#applyWindow(input.window);
    }
    for (const state of input.state ?? []) this.#applyState(state);
    const step: ModelStepRecord = {
      attemptId: input.step.attemptId,
      requestId: input.step.requestId,
      turnId: input.step.turnId,
      conversationId: input.step.conversationId,
      step: input.step.step,
      attemptNo: input.step.attemptNo,
      epochId: input.step.epochId,
      epochRevision: input.step.epochRevision,
      inputItemIds: [...input.step.inputItemIds],
      outputItemIds: [...(input.step.outputItemIds ?? [])],
      requestConfigDigest: input.step.requestConfigDigest,
      projection: input.step.projection,
      status: input.step.status,
      responseId: null,
      usage: null,
      error: null,
      finishReason: null,
      createdAt: input.step.createdAt,
      completedAt: null,
    };
    this.#steps.set(step.attemptId, step);
    return { items: appended, step, epoch };
  }

  async updateStep(attemptId: string, patch: StepPatch): Promise<ModelStepRecord | null> {
    const step = this.#steps.get(attemptId);
    if (!step) return null;
    const updated: ModelStepRecord = {
      ...step,
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.outputItemIds ? { outputItemIds: [...patch.outputItemIds] } : {}),
      ...(patch.usage !== undefined ? { usage: patch.usage } : {}),
      ...(patch.responseId !== undefined ? { responseId: patch.responseId } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      ...(patch.finishReason !== undefined ? { finishReason: patch.finishReason } : {}),
      ...(patch.projection !== undefined ? { projection: patch.projection } : {}),
      ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt } : {}),
    };
    this.#steps.set(attemptId, updated);
    return updated;
  }

  async getStep(attemptId: string): Promise<ModelStepRecord | null> {
    return this.#steps.get(attemptId) ?? null;
  }

  async listSteps(requestId: string): Promise<ModelStepRecord[]> {
    return [...this.#steps.values()]
      .filter((step) => step.requestId === requestId)
      .sort((a, b) => a.step - b.step || a.attemptNo - b.attemptNo);
  }

  async listRecentSteps(conversationId: string, limit: number): Promise<ModelStepRecord[]> {
    return [...this.#steps.values()]
      .filter((step) => step.conversationId === conversationId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async linkAssistantMessage(
    conversationId: string,
    requestId: string,
    messageId: string,
  ): Promise<void> {
    let latest: ModelItem | null = null;
    for (const id of this.#itemsByConversation.get(conversationId) ?? []) {
      const item = this.#modelItems.get(id);
      if (item?.requestId === requestId && item.kind === 'assistant') latest = item;
    }
    if (latest) this.#modelItems.set(latest.id, { ...latest, messageId });
  }

  async deleteTranscript(conversationId: string): Promise<void> {
    this.#deleteTranscript(conversationId);
  }

  #appendItem(entry: NewModelItem): ModelItem {
    const key = `${entry.conversationId}\u0000${entry.idempotencyKey}`;
    const existingId = this.#itemKeys.get(key);
    if (existingId) {
      const existing = this.#modelItems.get(existingId);
      if (existing) return existing;
    }
    const epoch = this.#epochs.get(entry.epochId);
    if (!epoch) throw new Error(`model item references unknown epoch ${entry.epochId}`);
    if (epoch.conversationId !== entry.conversationId) {
      throw new Error(`model item ${entry.idempotencyKey} belongs to another conversation`);
    }
    const order = this.#itemsByConversation.get(entry.conversationId) ?? [];
    const seq = (order.at(-1) ? this.#modelItems.get(order.at(-1) as string)?.seq ?? 0 : 0) + 1;
    const payload = entry.payload;
    const item: ModelItem = {
      id: entry.id ?? randomUUID(),
      conversationId: entry.conversationId,
      epochId: entry.epochId,
      seq,
      requestId: entry.requestId ?? null,
      turnId: entry.turnId ?? null,
      step: entry.step ?? null,
      kind: entry.kind,
      source: entry.source,
      scope: entry.scope,
      contentVersion: entry.contentVersion ?? MODEL_TRANSCRIPT_VERSION,
      payload,
      contentHash: entry.contentHash ?? itemContentHash(payload),
      messageId: entry.messageId ?? null,
      callId: entry.callId ?? null,
      status: entry.status ?? 'complete',
      createdAt: new Date(),
    };
    this.#modelItems.set(item.id, item);
    this.#itemKeys.set(key, item.id);
    this.#itemsByConversation.set(entry.conversationId, [...order, item.id]);
    return item;
  }

  #applyWindow(window: {
    readonly epochId: string;
    readonly expectedRevision: number;
    readonly itemIds: readonly string[];
  }): ModelEpoch {
    const epoch = this.#epochs.get(window.epochId);
    if (!epoch) throw new Error(`model epoch ${window.epochId} not found`);
    if (epoch.windowRevision !== window.expectedRevision) {
      throw new TranscriptRevisionConflictError(
        epoch.id,
        window.expectedRevision,
        epoch.windowRevision,
      );
    }
    this.#assertItemsBelongToConversation(epoch.conversationId, window.itemIds);
    const updated: ModelEpoch = {
      ...epoch,
      windowItemIds: [...window.itemIds],
      windowRevision: epoch.windowRevision + 1,
    };
    this.#epochs.set(updated.id, updated);
    return updated;
  }

  #applyState(input: NewModelContextState): void {
    const key = `${input.epochId}\u0000${input.key}`;
    this.#contextState.set(key, {
      conversationId: input.conversationId,
      epochId: input.epochId,
      key: input.key,
      scope: input.scope,
      contentHash: input.contentHash,
      renderVersion: input.renderVersion ?? 'runtime-block-v1',
      revision: input.revision,
      latestItemId: input.latestItemId,
      cleared: input.cleared,
      updatedAt: new Date(),
    });
  }

  #assertItemsBelongToConversation(
    conversationId: string,
    ids: readonly string[],
  ): void {
    for (const id of ids) {
      const item = this.#modelItems.get(id);
      if (!item) throw new Error(`model item ${id} not found`);
      if (item.conversationId !== conversationId) {
        throw new Error(`model item ${id} belongs to another conversation`);
      }
    }
  }

  #deleteTranscript(conversationId: string): void {
    for (const [id, epoch] of this.#epochs) {
      if (epoch.conversationId === conversationId) this.#epochs.delete(id);
    }
    for (const [id, item] of this.#modelItems) {
      if (item.conversationId === conversationId) this.#modelItems.delete(id);
    }
    for (const [key, itemId] of this.#itemKeys) {
      if (!this.#modelItems.has(itemId)) this.#itemKeys.delete(key);
    }
    this.#itemsByConversation.delete(conversationId);
    for (const [id, step] of this.#steps) {
      if (step.conversationId === conversationId) this.#steps.delete(id);
    }
    for (const [key, state] of this.#contextState) {
      if (state.conversationId === conversationId) this.#contextState.delete(key);
    }
  }

  // ------------------------------------------------------------ plumbing -----

  async saveWebDocument(record: WebDocumentRecord): Promise<void> {
    this.#webDocuments.set(record.id, { ...record });
  }

  async getWebDocument(userId: string, id: string): Promise<WebDocumentRecord | null> {
    const record = this.#webDocuments.get(id);
    return record && record.userId === userId ? { ...record } : null;
  }

  async createUserQuestion(record: UserQuestionRecord): Promise<void> {
    this.#questions.set(record.id, { ...record });
  }

  async getUserQuestion(userId: string, id: string): Promise<UserQuestionRecord | null> {
    const record = this.#questions.get(id);
    return record && record.userId === userId ? { ...record } : null;
  }

  async getUserQuestionByCall(
    userId: string,
    conversationId: string,
    callId: string,
  ): Promise<UserQuestionRecord | null> {
    for (const record of this.#questions.values()) {
      if (
        record.userId === userId &&
        record.conversationId === conversationId &&
        record.callId === callId
      ) {
        return { ...record };
      }
    }
    return null;
  }

  async listPendingQuestions(userId: string, conversationId: string): Promise<UserQuestionRecord[]> {
    return [...this.#questions.values()]
      .filter(
        (record) =>
          record.userId === userId &&
          record.conversationId === conversationId &&
          record.status === 'pending',
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((record) => ({ ...record }));
  }

  async listPendingQuestionsByMember(
    userId: string,
    memberId: string,
  ): Promise<UserQuestionRecord[]> {
    return [...this.#questions.values()]
      .filter(
        (record) =>
          record.userId === userId &&
          record.memberId === memberId &&
          record.status === 'pending',
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((record) => ({ ...record }));
  }

  async resolveUserQuestion(input: {
    readonly userId: string;
    readonly id: string;
    readonly status: Exclude<QuestionStatus, 'pending'>;
    readonly answer: Record<string, unknown> | null;
    readonly at: string;
  }): Promise<boolean> {
    const record = this.#questions.get(input.id);
    if (!record || record.userId !== input.userId || record.status !== 'pending') return false;
    this.#questions.set(input.id, {
      ...record,
      status: input.status,
      answer: input.answer,
      answeredAt: input.at,
    });
    return true;
  }

  async expireUserQuestions(now: Date): Promise<number> {
    let count = 0;
    for (const [id, record] of this.#questions) {
      if (record.status !== 'pending' || record.expiresAt > now.toISOString()) continue;
      this.#questions.set(id, { ...record, status: 'expired', answeredAt: now.toISOString() });
      count += 1;
    }
    return count;
  }

  async createDevJob(record: DevJobRecord): Promise<void> {
    this.#devJobs.set(record.id, { ...record });
  }

  async updateDevJob(
    userId: string,
    id: string,
    patch: Partial<
      Pick<DevJobRecord, 'pid' | 'status' | 'exitCode' | 'endedAt' | 'error' | 'expiresAt'>
    >,
  ): Promise<void> {
    const record = this.#devJobs.get(id);
    if (!record || record.userId !== userId) return;
    this.#devJobs.set(id, { ...record, ...patch });
  }

  async getDevJob(userId: string, id: string): Promise<DevJobRecord | null> {
    const record = this.#devJobs.get(id);
    return record && record.userId === userId ? { ...record } : null;
  }

  async getDevJobByCall(
    userId: string,
    conversationId: string,
    toolCallId: string,
  ): Promise<DevJobRecord | null> {
    for (const record of this.#devJobs.values()) {
      if (
        record.userId === userId &&
        record.conversationId === conversationId &&
        record.toolCallId === toolCallId
      ) {
        return { ...record };
      }
    }
    return null;
  }

  async listDevJobs(userId: string, conversationId: string): Promise<DevJobRecord[]> {
    return [...this.#devJobs.values()]
      .filter((record) => record.userId === userId && record.conversationId === conversationId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .map((record) => ({ ...record }));
  }

  async listRunningDevJobs(): Promise<DevJobRecord[]> {
    return [...this.#devJobs.values()]
      .filter((record) => record.status === 'running' || record.status === 'starting')
      .map((record) => ({ ...record }));
  }

  // ---------------------------------------------------------- changesets -----

  async createWorkspaceChangeset(input: NewChangesetInput): Promise<void> {
    this.#changesets.set(input.summary.id, {
      ...input.summary,
      files: input.files.map((file) => ({ ...file })),
    });
  }

  async getWorkspaceChangeset(
    userId: string,
    id: string,
  ): Promise<WorkspaceChangesetRecord | null> {
    const record = this.#changesets.get(id);
    if (!record || record.userId !== userId) return null;
    return {
      ...record,
      files: record.files.map((file) => ({ ...file })),
    };
  }

  async getWorkspaceChangesetForTurn(
    userId: string,
    conversationId: string,
    turnId: string,
  ): Promise<WorkspaceChangesetRecord | null> {
    for (const record of this.#changesets.values()) {
      if (
        record.userId === userId &&
        record.conversationId === conversationId &&
        record.turnId === turnId
      ) {
        return this.getWorkspaceChangeset(userId, record.id);
      }
    }
    return null;
  }

  async listWorkspaceChangesets(
    userId: string,
    conversationId: string,
    limit = 50,
  ): Promise<WorkspaceChangesetSummary[]> {
    return [...this.#changesets.values()]
      .filter((record) => record.userId === userId && record.conversationId === conversationId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map((record) => {
        const summary: WorkspaceChangesetSummary = {
          id: record.id,
          userId: record.userId,
          conversationId: record.conversationId,
          turnId: record.turnId,
          workspaceId: record.workspaceId,
          checkpointId: record.checkpointId,
          beforeDigest: record.beforeDigest,
          afterDigest: record.afterDigest,
          fileCount: record.fileCount,
          added: record.added,
          modified: record.modified,
          deleted: record.deleted,
          status: record.status,
          createdAt: record.createdAt,
          undoneAt: record.undoneAt,
        };
        return summary;
      });
  }

  async finishWorkspaceUndo(input: {
    readonly userId: string;
    readonly changesetId: string;
    readonly restoredPaths: readonly string[];
    readonly status: ChangesetStatus;
    readonly undoneAt: string;
  }): Promise<void> {
    const record = this.#changesets.get(input.changesetId);
    if (!record || record.userId !== input.userId) return;
    const restored = new Set(input.restoredPaths);
    this.#changesets.set(input.changesetId, {
      ...record,
      status: input.status,
      undoneAt: input.undoneAt,
      files: record.files.map((file): ChangesetFileRecord =>
        restored.has(file.path) ? { ...file, restored: true } : file,
      ),
    });
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    this.#memories.clear();
    this.#conversations.clear();
    this.#summaries.clear();
    this.#preferences.clear();
    this.#runs.clear();
    this.#turns.clear();
    this.#turnEvents.length = 0;
    this.#users.clear();
    this.#epochs.clear();
    this.#modelItems.clear();
    this.#itemKeys.clear();
    this.#itemsByConversation.clear();
    this.#steps.clear();
    this.#contextState.clear();
  }
}

/** Narrow the composite to its parts, for tests that only need one. */
export function asSessionStore(store: Store): SessionStore {
  return store;
}
export function asRunStore(store: Store): RunStore {
  return store;
}
export function asPreferenceStore(store: Store): PreferenceStore {
  return store;
}
