/**
 * The persistence port for turn execution.
 *
 * Separate from `SessionStore` on purpose: message history is a conversation
 * fact, turn bookkeeping is an execution fact, and the two have different
 * lifetimes and different recovery rules. A conversation is deleted with its
 * turns; a turn is never replayed to fix a conversation.
 *
 * `createTurn` is the lock acquisition. The SQLite implementation backs it with
 * a partial unique index on the running turn of a conversation, so the lock
 * survives a second process and cannot be lost to a race between two awaits.
 * `InMemoryStore` implements the same rule; a test that passes here is a
 * statement about the rule, not about SQLite.
 */

import type {
  NewTurnEvent,
  TurnEventRecord,
  TurnFinishPatch,
  TurnRecord,
} from './turn-types.ts';

export type CreateTurnResult = 'created' | 'exists' | 'busy';

export interface TurnStore {
  /**
   * Record a running turn.
   *
   * `exists` means the request id is already recorded — the caller re-reads it
   * and answers from it. `busy` means another turn is running in this
   * conversation; that is the 409, and it is why the check and the insert have
   * to be one statement.
   */
  createTurn(record: TurnRecord): Promise<CreateTurnResult>;

  getTurn(id: string): Promise<TurnRecord | null>;

  /** The running turn of a conversation, or null. */
  activeTurn(conversationId: string): Promise<TurnRecord | null>;

  /**
   * Finish a running turn, and only a running turn.
   *
   * Idempotent: a second call finds no running row and changes nothing. That is
   * what lets both the orchestrator and its transport call it without a
   * double-write hazard, and what makes a late finish after recovery harmless.
   */
  finishTurn(id: string, patch: TurnFinishPatch): Promise<TurnRecord | null>;

  /** Every turn still marked running. Read once at startup by recovery. */
  listRunningTurns(): Promise<TurnRecord[]>;

  /** Append one execution record; `seq` is assigned by the store. */
  appendTurnEvent(event: NewTurnEvent): Promise<TurnEventRecord>;

  listTurnEvents(turnId: string): Promise<TurnEventRecord[]>;

  /**
   * Tool events for a whole conversation, oldest first.
   *
   * Compaction is the caller: a checkpoint's work evidence is built from the
   * trace of the messages it is about to shadow, and those messages span many
   * turns. `before` is an event-time bound, not a message seq — the boundary
   * message's timestamp is the closest honest answer to "everything that had
   * happened by the time the summarized part ended".
   *
   * `limit` keeps a pathological conversation from turning a compaction into a
   * full-table read; the newest events win, because they describe the work a
   * resumed model is most likely to continue.
   */
  listConversationTurnEvents(
    conversationId: string,
    options?: { readonly before?: Date; readonly limit?: number },
  ): Promise<TurnEventRecord[]>;

  /**
   * Move a tool call out of `running`.
   *
   * Recovery is the only caller: it reconciles an unobserved call against the
   * sandbox record and writes either a terminal status or `unknown`.
   */
  settleTurnEvent(
    turnId: string,
    seq: number,
    status: TurnEventRecord['status'],
    detail?: Record<string, unknown>,
  ): Promise<void>;
}
