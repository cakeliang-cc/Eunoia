/**
 * The lifecycle vocabulary for one execution of a turn.
 *
 * A `Message` is what the conversation says. A `TurnRecord` is what *happened
 * while producing* a message: which request started it, whether it is still
 * running, why it stopped, and what the request body was. Keeping the two apart
 * is what lets a retried request be answered from the record instead of running
 * the model again — the transcript alone cannot tell "this reply exists" from
 * "this reply exists *because of this request*".
 *
 * Three distinctions matter here and each one has been a bug somewhere:
 *
 *   - **A conversation is a lock domain.** Two turns of one conversation must
 *     not interleave, or two user messages are written before either reply and
 *     each model call sees the other's message. A `UNIQUE` index on
 *     `(conversation_id) WHERE status = 'running'` is the lock; a process-local
 *     `Map` is only a fast path for abort controllers.
 *   - **A request id is not a turn id.** The client generates a request id and
 *     reuses it when it retries; the turn id addresses the live stream for
 *     `POST /api/chat/stop`. One request may be retried after its process died,
 *     which produces a new turn id but the same request id.
 *   - **Interrupted is not failed.** A person pressing stop, a dropped
 *     connection, a crash, and a provider error are four different facts; the
 *     run statistics and the recovery sweep must be able to tell them apart.
 *     Hence `TurnStatus` for the outcome class and `FinishReason` for the cause.
 */

/**
 * Why a turn stopped. The union lives in `src/finish-reason.ts` because the run
 * audit in the memory layer needs it too, and session/memory do not import each
 * other.
 */
import type { FinishReason } from '../finish-reason.ts';
export type { FinishReason };

/** The coarse outcome class, which is what the database constrains. */
export type TurnStatus = 'running' | 'completed' | 'interrupted' | 'failed';

/**
 * One acceptance check, evaluated independently of the finish reason.
 *
 * A turn can finish with output and still not have succeeded (the model ran out
 * of steps), or finish abnormally and still have produced something useful (the
 * stream was cut mid-answer). Collapsing "has output", "ended normally" and
 * "accepted" into a single boolean is what made "the connection closed" read as
 * "the task succeeded".
 */
export interface AcceptanceCheck {
  /** Stable id, so a client or an evaluation can key on the failure. */
  readonly id: string;
  readonly ok: boolean;
  /** One line of evidence. Never the reply itself. */
  readonly detail?: string;
}

/**
 * Actual usage reported by the provider for the last request of a turn.
 *
 * `imageTokensUnknown` is deliberate: the provider does not split image tokens
 * out of `input_tokens`, so subtracting a local estimate would manufacture a
 * number nobody measured. `inputTokens` is the provider's total, not the local
 * estimate plus a text guess.
 */
export interface TurnUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cachedTokens: number;
  readonly responseModel: string | null;
  readonly imageTokensUnknown: boolean;
}

/** A request that has been accepted, is running, or has finished. */
export interface TurnRecord {
  /** The client-supplied request id. Primary key. */
  readonly id: string;
  /** The stream/stop id for the execution this request produced. */
  readonly turnId: string;
  readonly userId: string;
  readonly conversationId: string;
  /**
   * A digest of the request body plus its binding (user, conversation).
   *
   * Retrying the same id with the same hash is a retry; the same id with a
   * different hash is a client bug or a collision, and reusing the record would
   * answer a question nobody asked.
   */
  readonly requestHash: string;
  readonly status: TurnStatus;
  readonly finishReason: FinishReason | null;
  /** The reply as it was persisted, or '' when nothing was produced. */
  readonly reply: string;
  readonly messageId: string | null;
  readonly error: string | null;
  readonly model: string | null;
  /** Model steps taken; 0 before the loop starts. */
  readonly steps: number;
  /** Estimated size of the last model request, for budget diagnostics. */
  readonly contextTokens: number | null;
  /** The acceptance verdict, independent of `finishReason`. */
  readonly accepted: boolean | null;
  readonly acceptance: readonly AcceptanceCheck[];
  /** Real usage for the last request, or null when the provider reported none. */
  readonly usage: TurnUsage | null;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
}

/** What a finished turn is allowed to write. Everything else is immutable. */
export interface TurnFinishPatch {
  readonly status: Exclude<TurnStatus, 'running'>;
  readonly finishReason: FinishReason;
  readonly reply?: string;
  readonly messageId?: string | null;
  readonly error?: string | null;
  readonly steps?: number;
  readonly contextTokens?: number | null;
  readonly accepted?: boolean;
  readonly acceptance?: readonly AcceptanceCheck[];
  readonly usage?: TurnUsage | null;
}

/**
 * The durable half of a turn's execution.
 *
 * A tool call is written when the model asks for it, before it runs, so the
 * record answers "what did the model want" even if the process dies during the
 * call. The result is written when it returns. Recovery reconciles the two
 * against the sandbox's own execution rows rather than guessing.
 */
export type TurnEventKind = 'tool_call' | 'tool_result' | 'assistant_text';

/**
 * How far a tool call got.
 *
 * `unknown` is a real value, not a placeholder: a call that was running when the
 * process died has an unobserved outcome. Marking it `succeeded` because the
 * row exists would be a lie, and automatic replay would be a worse one.
 */
export type TurnEventStatus = 'requested' | 'running' | 'succeeded' | 'failed' | 'unknown';

export interface TurnEventRecord {
  readonly turnId: string;
  readonly conversationId: string;
  /** Monotonic within the turn. The pair `(turn_id, seq)` is unique. */
  readonly seq: number;
  readonly kind: TurnEventKind;
  readonly callId: string | null;
  readonly toolName: string | null;
  readonly status: TurnEventStatus;
  /** The sandbox execution id, when the tool produced one. */
  readonly executionId: string | null;
  /** Arguments for a call, output for a result, text for assistant text. */
  readonly payload: Record<string, unknown>;
  readonly createdAt: Date;
}

export interface NewTurnEvent {
  readonly turnId: string;
  readonly conversationId: string;
  readonly kind: TurnEventKind;
  readonly callId?: string | null;
  readonly toolName?: string | null;
  readonly status: TurnEventStatus;
  readonly executionId?: string | null;
  readonly payload?: Record<string, unknown>;
}
