/**
 * The session layer's vocabulary.
 *
 * A session (stored as a `conversation`) is the durable container for turns:
 * who it belongs to, when it started, what it is called, and whether it has been
 * archived. It owns messages, not memories. A memory may point at the message
 * that produced it (`sourceMessageId`), but memory does not need this module to
 * describe itself, and this module does not need memory.
 *
 * Working memory — the in-process recent turns — is also session state. It lives
 * in `working-memory.ts` and is never persisted; every turn in it already exists
 * in `messages`.
 */

export interface Message {
  readonly id: string;
  readonly conversationId: string;
  readonly userId: string;
  readonly role: 'user' | 'assistant' | 'system';
  readonly content: string;
  readonly createdAt: Date;
  /**
   * Monotonic position inside the conversation.
   *
   * A summary boundary names a seq, so it cannot be confused by two messages
   * sharing a timestamp. It is also the ordering used for replay; the database
   * still keeps `created_at` for display.
   */
  readonly seq: number;
}

export interface Conversation {
  readonly id: string;
  readonly userId: string;
  readonly title: string | null;
  readonly startedAt: Date;
  readonly lastTurnAt: Date | null;
  readonly turnCount: number;
  /**
   * When this conversation was put away.
   *
   * Archived rows stay readable and keep their messages; they are only hidden
   * from the ordinary history list. Deletion is the destructive operation, and
   * it is a different one on purpose.
   */
  readonly archivedAt: Date | null;
  /**
   * The model pinned to this conversation, or null to inherit the process
   * default. A pinned id also pins that model's context budget.
   */
  readonly modelId: string | null;
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

/**
 * A rolling summary of everything up to `throughSeq`.
 *
 * `throughSeq` is the inclusive boundary. The model replays only messages with
 * `seq > throughSeq`; the raw messages remain in `messages` for the UI and for
 * the next compaction.
 */
export interface ConversationSummary {
  readonly conversationId: string;
  readonly summary: string;
  readonly throughSeq: number;
  readonly summaryTokens: number;
  readonly model: string;
  readonly promptVersion: string;
  readonly updatedAt: Date;
}

/** The model-facing slice of a conversation: summary plus the raw tail. */
export interface SessionReplay {
  readonly summary: string | null;
  readonly throughSeq: number;
  readonly messages: readonly Message[];
}

/** How long a derived conversation name can get before it is cut. */
export const CONVERSATION_TITLE_CHARS = 24;

/**
 * The cap for a name the person typed.
 *
 * Larger than the derived title because a person who deliberately names a
 * conversation is doing filing, and 24 characters is a preview, not a name.
 * Still bounded: this value goes into a list row and eventually a model prompt.
 */
export const CONVERSATION_TITLE_MAX_CHARS = 80;

/**
 * Name a conversation after the message that opened it.
 *
 * Derived rather than asked for: a companion that opened by requesting a title
 * would be asking the person to do filing. The first message is a good label
 * precisely because it is what the person came with.
 *
 * Cut at a character budget rather than a word one, because the text is usually
 * Chinese and Chinese has no spaces to cut at. Newlines collapse first — a
 * first message is often several lines, and a title that renders as one line of
 * a paragraph reads worse than a truncated one.
 */
export function conversationTitle(message: string): string {
  const flat = message.replace(/\s+/g, ' ').trim();
  if (flat.length <= CONVERSATION_TITLE_CHARS) return flat;
  return `${flat.slice(0, CONVERSATION_TITLE_CHARS)}…`;
}
