/**
 * Application service for sessions.
 *
 * This is the layer the HTTP and turn-orchestration code should use. It exists
 * so those callers express *intent* — create a conversation, rename it, archive
 * it, append a turn — instead of assembling SQL-shaped calls and remembering
 * which owner checks belong on each one.
 *
 * It deliberately stops at the port: validation that belongs to HTTP (JSON
 * shape, title length) stays in the transport, and storage-specific work stays
 * in `PostgresStore` / `InMemoryStore`. What lives here is the lifecycle
 * vocabulary shared by both.
 */

import type { SessionStore, ConversationListOptions, ConversationPatch } from './store.ts';
import type { Conversation, HistoryStats, Message } from './types.ts';

export class SessionService {
  readonly #store: SessionStore;

  constructor(store: SessionStore) {
    this.#store = store;
  }

  create(userId: string, title?: string | null): Promise<Conversation> {
    return this.#store.createConversation(userId, title);
  }

  get(userId: string, conversationId: string): Promise<Conversation | null> {
    return this.#store.getConversation(userId, conversationId);
  }

  list(userId: string, options?: ConversationListOptions): Promise<Conversation[]> {
    return this.#store.listConversations(userId, options);
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

  /** Recent turns, oldest first, used to rebuild working memory. */
  recent(conversationId: string, limit: number): Promise<Message[]> {
    return this.#store.recentMessages(conversationId, limit);
  }

  messages(userId: string, conversationId: string, limit?: number): Promise<Message[]> {
    return this.#store.listMessages(userId, conversationId, limit);
  }

  stats(userId: string): Promise<HistoryStats> {
    return this.#store.historyStats(userId);
  }
}
