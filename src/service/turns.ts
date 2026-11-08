/**
 * Turn admission: one running turn per conversation, and a retry that cannot
 * execute twice.
 *
 * ## Why this exists
 *
 * The transcript showed the bug plainly: send A and B to one conversation at the
 * same time and both turns append their user message before either reply exists.
 * Each model call then replays the other's message, and the stored order becomes
 * `user A → user B → assistant A → assistant B` — a conversation nobody had.
 * Disabling the send button hides this behind one client; it does not stop a
 * second tab or a direct API call.
 *
 * So admission is a state machine, not a UI rule:
 *
 *   1. a turn is admitted only if no other turn of the conversation is running;
 *   2. admission is one atomic operation in the store (`createTurn`), so two
 *      requests cannot both observe "free" and both proceed;
 *   3. the admitted request is written down with a digest of its body, so a
 *      retry is answered from the record rather than from the model.
 *
 * ## What a busy conversation means
 *
 * The first iteration returns `409 busy`. Queueing is a later change with its
 * own semantics (what happens when the queued turn's conversation was deleted,
 * or the person sends five messages by mistake), and pretending to have it now
 * would be worse than refusing clearly.
 *
 * ## Why the hash includes the binding
 *
 * An idempotency key is only meaningful alongside the thing it identifies. The
 * digest covers the user, the conversation and the body, so replaying request X
 * under request Y's id is rejected even when X and Y happen to carry the same
 * text. That is the difference between "the same request, retried" and "a
 * different request that reused an id".
 */

import { createHash } from 'node:crypto';
import type { UserContentV1 } from '../agent/content.ts';
import { canonicalContent } from '../agent/content.ts';
import type { TurnStore } from '../session/turn-store.ts';
import type {
  FinishReason,
  TurnFinishPatch,
  TurnRecord,
} from '../session/turn-types.ts';

/** A turn is already running in this conversation. */
export class ConversationBusyError extends Error {
  readonly code = 'conversation_busy';
  readonly conversationId: string;
  readonly activeTurnId: string | null;

  constructor(conversationId: string, activeTurnId: string | null) {
    super('this conversation already has a running turn');
    this.name = 'ConversationBusyError';
    this.conversationId = conversationId;
    this.activeTurnId = activeTurnId;
  }
}

/**
 * The request id is already recorded against a different request.
 *
 * Not a retry: answering it from the stored record would return a reply to a
 * question the caller did not ask, and running it would make the id ambiguous
 * for every later retry.
 */
export class TurnRequestConflictError extends Error {
  readonly code = 'request_conflict';
  readonly requestId: string;

  constructor(requestId: string) {
    super('this request id is already bound to a different request');
    this.name = 'TurnRequestConflictError';
    this.requestId = requestId;
  }
}

export interface BeginTurnInput {
  readonly requestId: string;
  readonly turnId?: string;
  readonly userId: string;
  readonly conversationId: string;
  readonly requestHash: string;
  readonly model?: string | null;
}

export type BeginTurnResult =
  /** Admitted: the caller owns the conversation until it finishes. */
  | { readonly kind: 'started'; readonly record: TurnRecord }
  /** The same request already finished; answer from the record. */
  | { readonly kind: 'replay'; readonly record: TurnRecord }
  /** The same request is still running; this is a duplicate, not a new turn. */
  | { readonly kind: 'in_flight'; readonly record: TurnRecord };

export class TurnCoordinator {
  readonly #store: TurnStore;
  readonly #now: () => Date;

  constructor(store: TurnStore, options: { readonly now?: () => Date } = {}) {
    this.#store = store;
    this.#now = options.now ?? (() => new Date());
  }

  async begin(input: BeginTurnInput): Promise<BeginTurnResult> {
    const existing = await this.#store.getTurn(input.requestId);
    if (existing) return this.#reuse(existing, input);

    const record: TurnRecord = {
      id: input.requestId,
      turnId: input.turnId ?? input.requestId,
      userId: input.userId,
      conversationId: input.conversationId,
      requestHash: input.requestHash,
      status: 'running',
      finishReason: null,
      reply: '',
      messageId: null,
      error: null,
      model: input.model ?? null,
      steps: 0,
      contextTokens: null,
      accepted: null,
      acceptance: [],
      usage: null,
      startedAt: this.#now(),
      endedAt: null,
    };

    const created = await this.#store.createTurn(record);
    if (created === 'created') return { kind: 'started', record };

    // Lost the insert race, or the conversation is busy. The first is answered
    // by the record the winner wrote; the second is the 409.
    const raced = await this.#store.getTurn(input.requestId);
    if (raced) return this.#reuse(raced, input);

    const active = await this.#store.activeTurn(input.conversationId);
    throw new ConversationBusyError(input.conversationId, active?.turnId ?? null);
  }

  finish(id: string, patch: TurnFinishPatch): Promise<TurnRecord | null> {
    return this.#store.finishTurn(id, patch);
  }

  current(conversationId: string): Promise<TurnRecord | null> {
    return this.#store.activeTurn(conversationId);
  }

  get(id: string): Promise<TurnRecord | null> {
    return this.#store.getTurn(id);
  }

  #reuse(existing: TurnRecord, input: BeginTurnInput): BeginTurnResult {
    if (
      existing.userId !== input.userId ||
      existing.conversationId !== input.conversationId ||
      existing.requestHash !== input.requestHash
    ) {
      throw new TurnRequestConflictError(input.requestId);
    }
    if (existing.status === 'running') return { kind: 'in_flight', record: existing };
    return { kind: 'replay', record: existing };
  }
}

/**
 * A digest of what the request is, not just of its text.
 *
 * Field order is fixed by construction, so the same request always hashes the
 * same way; `\u0000` cannot appear in a JSON body's string values as a
 * separator ambiguity, because it is escaped by `JSON.stringify` first.
 */
export function turnRequestHash(input: {
  readonly kind: 'chat' | 'regenerate';
  readonly userId: string;
  readonly conversationId: string;
  readonly message: string;
  readonly continue?: boolean;
  readonly attachments?: readonly string[];
  /**
   * Ordered blocks, when this request came from the structured field.
   *
   * Included only when present, so a legacy text request keeps the exact digest
   * it had before multimodal support: a retry that started before an upgrade
   * must still be answered from its record.
   */
  readonly content?: UserContentV1;
  /**
   * Immutable digests of the referenced originals, one per image occurrence.
   *
   * The asset id alone is not enough: a retry that swapped the bytes behind an
   * id would otherwise look like the same request. The digest is the content.
   */
  readonly assetDigests?: readonly string[];
}): string {
  const canonical = JSON.stringify([
    input.kind,
    input.userId,
    input.conversationId,
    input.message,
    input.continue === true,
    [...(input.attachments ?? [])],
    ...(input.content
      ? [canonicalContent(input.content), [...(input.assetDigests ?? [])]]
      : []),
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/** Whether a stored turn has reached an outcome a retry may be answered from. */
export function isFinished(status: TurnRecord['status']): boolean {
  return status !== 'running';
}

/** The finish reason a non-running record must have, with a safe fallback. */
export function finishReasonOf(record: TurnRecord): FinishReason {
  if (record.finishReason) return record.finishReason;
  if (record.status === 'completed') return 'completed';
  if (record.status === 'failed') return 'failed';
  return 'cancelled';
}
