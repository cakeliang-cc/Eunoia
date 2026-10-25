/**
 * Working memory: a bounded process-local cache of recent turns.
 *
 * Since compaction landed, this is **not** the source of the model's history.
 * `SessionService.prepare` reads the durable summary boundary and the messages
 * after it from the database; this class remains a small cache utility for
 * callers that only need a recent tail, and its bounds are still tested. A
 * process-local window cannot honour a summary boundary, and two sources of
 * truth for "what the model has seen" would eventually disagree.
 *
 * It is still never persisted: every turn here is also a row in `messages`.
 */

export interface WorkingTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly at: Date;
}

export interface WorkingMemoryOptions {
  readonly maxTurns: number;
  readonly maxChars: number;
  /** Idle time after which a conversation's working set is dropped. */
  readonly ttlMs: number;
}

export const DEFAULT_WORKING_MEMORY: WorkingMemoryOptions = {
  maxTurns: 12,
  maxChars: 6000,
  ttlMs: 60 * 60 * 1000,
};

export class WorkingMemory {
  readonly #byConversation = new Map<string, WorkingTurn[]>();
  readonly #lastTouched = new Map<string, number>();
  readonly #options: WorkingMemoryOptions;

  constructor(options: Partial<WorkingMemoryOptions> = {}) {
    this.#options = { ...DEFAULT_WORKING_MEMORY, ...options };
  }

  /**
   * Append a turn, trimming from the front until both caps hold.
   *
   * The newest turn is always kept even if it alone exceeds `maxChars` —
   * dropping the thing the person just said in order to satisfy a character
   * budget would be the wrong trade every time.
   */
  remember(
    conversationId: string,
    turn: { role: 'user' | 'assistant'; content: string; at?: Date },
  ): void {
    const turns = this.#byConversation.get(conversationId) ?? [];
    turns.push({ role: turn.role, content: turn.content, at: turn.at ?? new Date() });

    while (turns.length > this.#options.maxTurns) turns.shift();

    let total = turns.reduce((sum, t) => sum + t.content.length, 0);
    while (turns.length > 1 && total > this.#options.maxChars) {
      total -= turns.shift()?.content.length ?? 0;
    }

    this.#byConversation.set(conversationId, turns);
    this.#lastTouched.set(conversationId, Date.now());
  }

  /** A copy, so callers cannot mutate session state by accident. */
  context(conversationId: string): readonly WorkingTurn[] {
    return [...(this.#byConversation.get(conversationId) ?? [])];
  }

  forget(conversationId: string): void {
    this.#byConversation.delete(conversationId);
    this.#lastTouched.delete(conversationId);
  }

  /** Drop conversations idle past the TTL. Called on the server's sweep timer. */
  sweep(now: number = Date.now()): number {
    let dropped = 0;
    for (const [conversationId, touchedAt] of this.#lastTouched) {
      if (now - touchedAt > this.#options.ttlMs) {
        this.forget(conversationId);
        dropped += 1;
      }
    }
    return dropped;
  }

  /** Live conversation count. Exposed for the sweep test and for metrics. */
  get size(): number {
    return this.#byConversation.size;
  }
}

/**
 * Seed a working set from persisted history.
 *
 * Used when a conversation resumes after the process restarted or the TTL
 * expired: the messages are in the database, so the session state is
 * reconstructible rather than lost.
 */
export function seedWorkingMemory(
  working: WorkingMemory,
  conversationId: string,
  messages: readonly { role: string; content: string; createdAt: Date }[],
): void {
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    working.remember(conversationId, {
      role: message.role,
      content: message.content,
      at: message.createdAt,
    });
  }
}
