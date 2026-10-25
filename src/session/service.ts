/**
 * Application service for sessions.
 *
 * This is the layer the HTTP and turn-orchestration code should use. It owns the
 * lifecycle vocabulary, the model-facing replay window, and the compaction
 * decision. It deliberately stops at two ports:
 *
 * - `SessionStore` for rows
 * - `SummaryGenerator` for the one model call compaction needs
 *
 * Neither is a provider SDK. The session layer never learns how a summary is
 * produced, and the agent layer never learns where a boundary is stored.
 */

import { log } from '../observability/logging.ts';
import { defaultModelProfile, modelProfile, summaryModelProfile } from '../models/registry.ts';
import type { ModelProfile } from '../models/types.ts';
import {
  sessionConfig,
  sessionReplayBudget,
  type SessionConfig,
} from './config.ts';
import type { SessionStore, ConversationListOptions, ConversationPatch } from './store.ts';
import {
  cleanSummary,
  SUMMARY_PROMPT_VERSION,
  type SummaryGenerator,
} from './summary.ts';
import { estimateMessageTokens, estimateMessagesTokens, estimateTokens, truncateToTokens } from './tokens.ts';
import type {
  Conversation,
  ConversationSummary,
  HistoryStats,
  Message,
  SessionReplay,
} from './types.ts';

export interface SessionServiceOptions {
  readonly config?: SessionConfig;
  readonly summarize?: SummaryGenerator;
  /** Model used by conversations whose `modelId` is null. */
  readonly model?: ModelProfile;
  /** Model profile used for summary calls, so its own context caps chunks. */
  readonly summaryModel?: ModelProfile;
  /** Resolver for a pinned conversation model; defaults to the catalog. */
  readonly resolveModel?: (modelId: string) => ModelProfile;
  readonly now?: () => Date;
}

export interface PrepareOptions {
  /** Do not put this message (or anything after it) into the summary. */
  readonly protectSeq?: number;
  readonly signal?: AbortSignal;
}

export interface CompactionResult {
  readonly compacted: boolean;
  readonly summarizedMessages: number;
  readonly throughSeq: number;
  readonly chunks: number;
  readonly reason?: string;
}

const NOTHING_TO_KEEP = '（没有需要保留的内容）';

export class SessionService {
  readonly #store: SessionStore;
  readonly #config: SessionConfig;
  readonly #summarize: SummaryGenerator | undefined;
  readonly #defaultModel: ModelProfile;
  readonly #summaryModel: ModelProfile;
  readonly #resolveModel: (modelId: string) => ModelProfile;
  readonly #now: () => Date;

  constructor(store: SessionStore, options: SessionServiceOptions = {}) {
    this.#store = store;
    this.#config = options.config ?? sessionConfig();
    this.#summarize = options.summarize;
    this.#defaultModel = options.model ?? defaultModelProfile();
    this.#summaryModel = options.summaryModel ?? summaryModelProfile();
    this.#resolveModel = options.resolveModel ?? modelProfile;
    this.#now = options.now ?? (() => new Date());
  }

  get config(): SessionConfig {
    return this.#config;
  }

  create(
    userId: string,
    title?: string | null,
    modelId?: string | null,
  ): Promise<Conversation> {
    return this.#store.createConversation(userId, title, modelId);
  }

  get(userId: string, conversationId: string): Promise<Conversation | null> {
    return this.#store.getConversation(userId, conversationId);
  }

  list(userId: string, options: ConversationListOptions = {}): Promise<Conversation[]> {
    return this.#store.listConversations(userId, {
      ...options,
      limit: options.limit ?? this.#config.listLimit,
    });
  }

  update(
    userId: string,
    conversationId: string,
    patch: ConversationPatch,
  ): Promise<Conversation | null> {
    return this.#store.updateConversation(userId, conversationId, patch);
  }

  rename(userId: string, conversationId: string, title: string | null): Promise<Conversation | null> {
    return this.update(userId, conversationId, { title });
  }

  archive(userId: string, conversationId: string, archived = true): Promise<Conversation | null> {
    return this.update(userId, conversationId, { archived });
  }

  delete(userId: string, conversationId: string): Promise<boolean> {
    return this.#store.deleteConversation(userId, conversationId);
  }

  /** Create-or-reuse the conversation a turn belongs to. */
  ensure(userId: string, conversationId?: string | null): Promise<Conversation> {
    return this.#store.ensureConversation(userId, conversationId);
  }

  append(message: {
    conversationId: string;
    userId: string;
    role: Message['role'];
    content: string;
  }): Promise<Message> {
    return this.#store.appendMessage(message);
  }

  name(userId: string, conversationId: string, title: string): Promise<void> {
    return this.#store.nameConversation(userId, conversationId, title);
  }

  /** Recent turns, oldest first. Kept for callers that only need a tail. */
  recent(conversationId: string, limit: number): Promise<Message[]> {
    return this.#store.recentMessages(conversationId, limit);
  }

  messages(userId: string, conversationId: string, limit?: number): Promise<Message[]> {
    return this.#store.listMessages(
      userId,
      conversationId,
      limit ?? this.#config.messageLimit,
    );
  }

  stats(userId: string): Promise<HistoryStats> {
    return this.#store.historyStats(userId);
  }

  /**
   * The model-facing history: summary plus the raw tail.
   *
   * Compaction runs here because this is the only place that knows both the
   * budget and the boundary. The caller passes `protectSeq` for the user message
   * that started the turn; it must never be summarized away.
   */
  async prepare(
    userId: string,
    conversationId: string,
    options: PrepareOptions = {},
  ): Promise<SessionReplay> {
    const conversation = await this.#store.getConversation(userId, conversationId);
    if (!conversation) throw new Error(`conversation ${conversationId} not found`);
    const model = this.#modelFor(conversation);

    let summary = await this.#store.getSummary(conversationId);
    let messages = await this.#store.messagesAfter(
      conversationId,
      summary?.throughSeq ?? 0,
      this.#config.replayMaxMessages,
    );

    const budget = sessionReplayBudget(this.#config, model);

    if (this.#shouldCompact(summary, messages, budget)) {
      const result = await this.compact(userId, conversationId, options);
      if (result.compacted) {
        summary = await this.#store.getSummary(conversationId);
        messages = await this.#store.messagesAfter(
          conversationId,
          summary?.throughSeq ?? 0,
          this.#config.replayMaxMessages,
        );
      }
    }

    const summaryText = summary?.summary ?? null;
    const summaryTokens = summaryText ? estimateTokens(summaryText, this.#config.tokenEstimator) : 0;
    const total = summaryTokens + estimateMessagesTokens(messages, this.#config.tokenEstimator);

    // Compaction is the preferred path. If it is disabled, unavailable, or
    // failed, truncate the model window rather than sending a request the
    // provider will reject. The database keeps everything either way.
    if (total > budget) {
      const fitted = this.#fitMessages(messages, budget - summaryTokens);
      if (fitted.length !== messages.length) {
        log.warn('session.replay_truncated', {
          conversation_id: conversationId,
          dropped_messages: messages.length - fitted.length,
          estimated_tokens: total,
          budget,
        });
      }
      messages = fitted;
    }

    return {
      summary: summaryText,
      throughSeq: summary?.throughSeq ?? 0,
      messages,
    };
  }

  /**
   * Replace a prefix of the unsummarized history with a rolling summary.
   *
   * The protected tail (recent messages plus the current user message) is never
   * summarized. Raw messages are never deleted.
   */
  async compact(
    userId: string,
    conversationId: string,
    options: PrepareOptions = {},
  ): Promise<CompactionResult> {
    const noop = async (reason: string): Promise<CompactionResult> => ({
      compacted: false,
      summarizedMessages: 0,
      throughSeq: (await this.#store.getSummary(conversationId))?.throughSeq ?? 0,
      chunks: 0,
      reason,
    });

    if (!this.#config.compactionEnabled) return noop('compaction_disabled');
    if (!this.#summarize) return noop('summarizer_unavailable');

    const conversation = await this.#store.getConversation(userId, conversationId);
    if (!conversation) throw new Error(`conversation ${conversationId} not found`);

    const previous = await this.#store.getSummary(conversationId);
    const messages = await this.#store.messagesAfter(
      conversationId,
      previous?.throughSeq ?? 0,
      this.#config.replayMaxMessages,
    );

    const keepStart = this.#keepStart(messages, options.protectSeq);
    const older = messages.slice(0, keepStart);
    if (older.length < this.#config.compactMinMessages) {
      return noop('not_enough_older_messages');
    }

    const mode = this.#config.tokenEstimator;
    const summaryCap = Math.max(
      1_024,
      this.#summaryModel.contextWindowTokens
        - this.#summaryModel.maxOutputTokens
        - this.#summaryModel.safetyBufferTokens,
    );
    const maxChunkTokens = Math.max(
      1_024,
      Math.min(this.#config.summaryMaxInputTokens, summaryCap)
        - estimateTokens(previous?.summary ?? '', mode)
        - 256,
    );
    const chunks = chunkMessages(older, maxChunkTokens, mode);

    try {
      let rolling = previous?.summary ?? null;
      for (const chunk of chunks) {
        const raw = await this.#summarize({
          previousSummary: rolling,
          messages: chunk,
          maxOutputTokens: this.#config.summaryTargetTokens,
        });
        const cleaned = cleanSummary(raw, this.#config.summaryTargetTokens, mode);
        if (!cleaned) throw new Error('summary model returned an empty summary');
        // A model that says "nothing to keep" must not erase a summary that
        // already covered earlier turns.
        rolling = cleaned === NOTHING_TO_KEEP && rolling ? rolling : cleaned;
      }

      if (!rolling) return noop('empty_summary');
      const summary = truncateToTokens(
        rolling,
        this.#config.summaryTargetTokens,
        mode,
      );
      const record: ConversationSummary = {
        conversationId,
        summary,
        throughSeq: older[older.length - 1]!.seq,
        summaryTokens: estimateTokens(summary, mode),
        model: this.#summaryModel.id,
        promptVersion: SUMMARY_PROMPT_VERSION,
        updatedAt: this.#now(),
      };
      await this.#store.saveSummary(record);

      log.info('session.compacted', {
        conversation_id: conversationId,
        summarized_messages: older.length,
        chunks: chunks.length,
        through_seq: record.throughSeq,
        summary_tokens: record.summaryTokens,
        model: record.model,
      });

      return {
        compacted: true,
        summarizedMessages: older.length,
        throughSeq: record.throughSeq,
        chunks: chunks.length,
      };
    } catch (error) {
      log.warn('session.compact_failed', {
        conversation_id: conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return noop('summary_failed');
    }
  }

  /**
   * Compact conversations that have been idle past the configured threshold.
   *
   * Only called when `SESSION_IDLE_COMPACT_MINUTES` is non-zero. It never
   * deletes; a session that is too short to compact is left alone.
   */
  async compactIdle(
    userId: string,
    olderThanMinutes: number = this.#config.idleCompactMinutes,
    now: Date = this.#now(),
  ): Promise<number> {
    if (!this.#config.compactionEnabled || !this.#summarize) return 0;
    if (olderThanMinutes <= 0) return 0;

    const cutoff = now.getTime() - olderThanMinutes * 60_000;
    const conversations = await this.list(userId, { limit: this.#config.idleScanLimit });
    let compacted = 0;
    for (const conversation of conversations) {
      if (conversation.archivedAt) continue;
      const last = conversation.lastTurnAt ?? conversation.startedAt;
      if (last.getTime() >= cutoff) continue;
      const result = await this.compact(userId, conversation.id);
      if (result.compacted) compacted += 1;
    }
    return compacted;
  }

  #shouldCompact(
    summary: ConversationSummary | null,
    messages: readonly Message[],
    budget: number,
  ): boolean {
    if (!this.#config.compactionEnabled || !this.#summarize) return false;
    if (messages.length < this.#config.compactMinMessages) return false;

    const mode = this.#config.tokenEstimator;
    const summaryTokens = summary ? estimateTokens(summary.summary, mode) : 0;
    const total = summaryTokens + estimateMessagesTokens(messages, mode);
    return total > budget * this.#config.compactTriggerRatio;
  }

  #modelFor(conversation: Conversation): ModelProfile {
    return conversation.modelId
      ? this.#resolveModel(conversation.modelId)
      : this.#defaultModel;
  }

  #keepStart(messages: readonly Message[], protectSeq?: number): number {
    const mode = this.#config.tokenEstimator;
    let keepStart = Math.max(0, messages.length - this.#config.keepRecentMessages);

    if (protectSeq !== undefined) {
      const protectedIndex = messages.findIndex((message) => message.seq >= protectSeq);
      if (protectedIndex >= 0) keepStart = Math.min(keepStart, protectedIndex);
    }

    // Trim the retained tail until it fits its own token cap. Always leave at
    // least one message; a turn with no history at all is worse than a large one.
    while (
      keepStart < messages.length - 1 &&
      estimateMessagesTokens(messages.slice(keepStart), mode) > this.#config.keepRecentTokens
    ) {
      keepStart += 1;
    }

    return keepStart;
  }

  #fitMessages(messages: readonly Message[], budget: number): Message[] {
    const mode = this.#config.tokenEstimator;
    let used = 0;
    let start = messages.length;
    while (start > 0) {
      const cost = estimateMessageTokens(messages[start - 1]!, mode);
      if (used + cost > budget) break;
      used += cost;
      start -= 1;
    }
    // Never return an empty current turn. The newest message is the one the
    // person just sent.
    return messages.slice(start === messages.length ? Math.max(0, messages.length - 1) : start);
  }
}

function chunkMessages(
  messages: readonly Message[],
  maxTokens: number,
  mode: SessionConfig['tokenEstimator'],
): Message[][] {
  const chunks: Message[][] = [];
  let current: Message[] = [];
  let used = 0;

  for (const message of messages) {
    const cost = estimateMessageTokens(message, mode);
    if (current.length > 0 && used + cost > maxTokens) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(message);
    used += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
