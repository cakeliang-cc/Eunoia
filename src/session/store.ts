/**
 * The persistence port for session state.
 *
 * Deliberately separate from `MemoryStore`. A session is a container for turns;
 * a memory is a belief about a person. They meet only at `sourceMessageId`, a
 * plain uuid, so neither layer needs the other's types.
 *
 * Both implementations (`PostgresStore`, `InMemoryStore`) satisfy this
 * interface. The rest of the application talks to this port through
 * `SessionService`, which is where lifecycle intent lives.
 */

import type {
  Conversation,
  ConversationSummary,
  HistoryStats,
  Message,
} from './types.ts';

export interface ConversationListOptions {
  /** Active rows only unless the caller explicitly asks to see the archive. */
  readonly includeArchived?: boolean;
  readonly limit?: number;
}

export interface ConversationPatch {
  /** `null` clears the name; the list then falls back to its unnamed label. */
  readonly title?: string | null;
  readonly archived?: boolean;
  /** `null` clears the pin and returns the conversation to the process default. */
  readonly modelId?: string | null;
}

export interface SessionStore {
  /** Create an empty conversation. The first message is not required to exist. */
  createConversation(
    userId: string,
    title?: string | null,
    modelId?: string | null,
  ): Promise<Conversation>;

  /** Read one conversation owned by this user, or null. */
  getConversation(userId: string, conversationId: string): Promise<Conversation | null>;

  /**
   * Rename or archive in one statement.
   *
   * Returns null when the id does not exist *for this user*. That is the same
   * answer as a nonexistent id on purpose: telling the two apart would leak
   * whether somebody else's conversation exists.
   */
  updateConversation(
    userId: string,
    conversationId: string,
    patch: ConversationPatch,
  ): Promise<Conversation | null>;

  /**
   * Permanently remove a conversation and its messages.
   *
   * `messages` cascades; `agent_runs.conversation_id` and
   * `memories.source_message_id` are `ON DELETE SET NULL`, so the measurement
   * and the memory survive without pointing at a row that is gone.
   */
  deleteConversation(userId: string, conversationId: string): Promise<boolean>;

  ensureConversation(userId: string, conversationId?: string | null): Promise<Conversation>;

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

  /** Messages strictly after the summary boundary, oldest first. */
  messagesAfter(conversationId: string, afterSeq: number, limit: number): Promise<Message[]>;

  getSummary(conversationId: string): Promise<ConversationSummary | null>;

  /**
   * Upsert the rolling checkpoint.
   *
   * The boundary and the summary are written together; a summary row whose
   * boundary did not advance would replay the same messages again.
   */
  saveSummary(summary: ConversationSummary): Promise<void>;

  listConversations(
    userId: string,
    options?: ConversationListOptions,
  ): Promise<Conversation[]>;
  listMessages(userId: string, conversationId: string, limit?: number): Promise<Message[]>;
}
