/**
 * The event contract between the agent core and every client.
 *
 * This is the most important type in the project. The core emits a stream of
 * `AgentEvent`; it does not know or care whether a transport renders them as
 * SSE frames, WebSocket messages, or test assertions. That boundary is what
 * makes a future mini-program client a new adapter rather than a rewrite.
 *
 * See docs/adr/006-client-server-separation.md.
 *
 * Note that a non-streaming reply is simply a stream with a single
 * `text_delta` followed by `completed`, so a client that cannot stream needs no
 * separate server path.
 */

import type { FinishReason } from '../finish-reason.ts';
import type { AcceptanceCheck } from '../session/turn-types.ts';

/**
 * Why a turn ended, re-exported here because this module is the event contract
 * and every client reads it from the terminal event. The type lives in the
 * session layer, which owns turn lifecycle; keeping one definition is what stops
 * a wire value from drifting away from the value written to the database.
 */
export type { FinishReason };

/** A chunk of assistant-visible text. */
export interface TextDeltaEvent {
  readonly type: 'text_delta';
  readonly text: string;
}

/**
 * A chunk of the model's reasoning, before it starts answering.
 *
 * This exists because of a measurement, not a preference. DeepSeek's reasoning
 * models spend 3–18 seconds thinking before the first visible character, and
 * during that window the previous client showed a static "…" — so a streamed
 * reply *looked* like a non-streamed one. The text was always arriving; nothing
 * was forwarding it.
 *
 * It is a separate event from `text_delta` rather than being merged into it,
 * because the two are not the same thing to a client: the reply is the product
 * and the reasoning is a working-out. A client may collapse it, hide it, or
 * ignore it entirely, and the reply is still complete without it. A client that
 * ignores this event type is still correct.
 */
export interface ThinkingDeltaEvent {
  readonly type: 'thinking_delta';
  readonly text: string;
}

/**
 * The reasoning phase ended — the reply follows, or a tool call does.
 *
 * Carries the elapsed time so a client can close the block with a summary
 * ("思考了 12 秒") instead of leaving a collapsed mystery. Sent at most once per
 * turn, and only if some `thinking_delta` preceded it.
 */
export interface ThinkingDoneEvent {
  readonly type: 'thinking_done';
  readonly elapsedMs: number;
}

/** The agent decided to call a tool. Emitted before the call resolves. */
export interface ToolCallEvent {
  readonly type: 'tool_call';
  readonly callId: string;
  readonly name: string;
  /**
   * Whether the call is safe to show the user. Memory tools are, but this
   * exists so a future tool with sensitive arguments is not leaked by default.
   */
  readonly displayable: boolean;
  /**
   * One line for the trace: a path and a line range, a command, a search term.
   * Never the tool's arguments or output — a path is what a person needs to
   * recognise a step, and file content has already had one life in the model.
   */
  readonly summary?: string;
}

/** A tool call finished. */
export interface ToolResultEvent {
  readonly type: 'tool_result';
  readonly callId: string;
  readonly name: string;
  readonly ok: boolean;
  readonly durationMs?: number;
  /** A one-line outcome for the trace, not the result body. */
  readonly summary?: string;
  /** Present when `ok` is false; bounded by the tool, never a stack trace. */
  readonly error?: string;
  /**
   * Present when the permission layer stopped the call and is waiting for a
   * person. The ids address the persisted request and its approval queue entry;
   * a client that ignores this field still sees a failed tool row.
   */
  readonly approval?: {
    readonly requestId: string | null;
    readonly approvalRequestId: string | null;
  };
}

/**
 * The loop hit its step cap without a final answer.
 *
 * This is not an error: everything the model did is still a valid partial turn,
 * and stopping is the safety property. It is a separate event so a client can
 * say "stopped after N steps" without the turn being marked failed and without
 * the reply being thrown away.
 */
export interface LoopExhaustedEvent {
  readonly type: 'loop_exhausted';
  readonly steps: number;
}

/**
 * Memories were pulled into context for this turn.
 *
 * Carries counts, never content. The client needs to know the companion looked
 * — that is what the "回想中" affordance shows — but the memories themselves are
 * the person's private history and putting them on the wire for a UI flourish
 * would be the wrong trade. The one place they are shown is the memory panel,
 * which reads them from an endpoint the person opened deliberately.
 */
export interface MemoryRetrievedEvent {
  readonly type: 'memory_retrieved';
  readonly count: number;
  readonly considered: number;
}

/**
 * A risk signal was detected, or a reply was replaced because it failed the
 * output check.
 *
 * `level` is sent; the matched phrases are not, because this reaches a client
 * and potentially a log.
 */
export interface SafetyNoticeEvent {
  readonly type: 'safety_notice';
  readonly level: 'elevated' | 'crisis';
  readonly replaced: boolean;
}

/** The run finished normally. `text` is the complete assistant reply. */
export interface CompletedEvent {
  readonly type: 'completed';
  readonly text: string;
  /**
   * The conversation this turn belongs to, so a client that started without one
   * can continue the thread. Null when the turn was not persisted.
   */
  readonly conversationId?: string | null;
  /**
   * The stored assistant message, used as the target for feedback. Null when
   * the turn was not persisted.
   */
  readonly messageId?: string | null;
  /**
   * Why the turn ended (ADR 029).
   *
   * `completed` means the model delivered a final answer. `incomplete_stream`
   * means the provider's stream ended without its completion event and the text
   * shown is all there is; `loop_exhausted` and `budget_exhausted` mean the
   * harness stopped, not the model. A client that ignores this field still has
   * the text, which is the point: keeping what was shown and calling it finished
   * are separate decisions.
   */
  readonly finishReason?: FinishReason;
  /**
   * Whether the turn met its acceptance conditions (ADR 029).
   *
   * Deliberately separate from `finishReason`: a reply can arrive complete and
   * still fail an acceptance check, and a stream can end abnormally while the
   * part that arrived is accepted. A client that ignores this field loses
   * nothing it already had.
   */
  readonly accepted?: boolean;
  readonly acceptance?: readonly AcceptanceCheck[];
  /**
   * True when this frame is a replay of an already-finished request rather than
   * a live generation. A retried request sees the same text without the model
   * being called again.
   */
  readonly replayed?: boolean;
}

/**
 * The person stopped the turn while it was generating.
 *
 * This is a normal ending, not a failure: what was already streamed stays on
 * screen, and it has been persisted as an interrupted assistant message so the
 * next turn can continue from the break instead of starting over. `text` is the
 * part that was actually shown — a client that never rendered the deltas can
 * still draw it.
 *
 * It is a separate event from `error` because the two lead to opposite UI: an
 * error is something to report, an interruption is something to continue.
 */
export interface InterruptedEvent {
  readonly type: 'interrupted';
  /** The reply as it stood when the turn stopped; empty if nothing was shown. */
  readonly text: string;
  /**
   * The conversation the partial reply belongs to, so a first turn that was
   * interrupted can still be continued. Null when the turn was not persisted.
   */
  readonly conversationId?: string | null;
  /** The stored interrupted message, when there was text to store. */
  readonly messageId?: string | null;
  /**
   * Always `cancelled` today: a person pressing stop and a dropped connection
   * are the same user-visible outcome. It is on the event anyway so a client
   * never has to infer a reason from an absent field.
   */
  readonly finishReason?: FinishReason;
  /** True when this is a stored outcome being replayed, not a live stop. */
  readonly replayed?: boolean;
}

/** The run failed. `retryable` distinguishes a transient fault from a real error. */
export interface ErrorEvent {
  readonly type: 'error';
  readonly message: string;
  readonly retryable: boolean;
  /** Always `failed` today; kept explicit for the same reason as above. */
  readonly finishReason?: FinishReason;
  /** True when a stored failure is being replayed for a retried request. */
  readonly replayed?: boolean;
}

export type AgentEvent =
  | TextDeltaEvent
  | ThinkingDeltaEvent
  | ThinkingDoneEvent
  | ToolCallEvent
  | ToolResultEvent
  | LoopExhaustedEvent
  | MemoryRetrievedEvent
  | SafetyNoticeEvent
  | CompletedEvent
  | InterruptedEvent
  | ErrorEvent;

/**
 * Event types that carry model-authored text.
 *
 * `thinking_delta` is here because the reasoning is model-authored text that
 * reaches a client, and a caller that is counting what the model produced —
 * a fingerprint, a length cap, a redaction pass — has to know about it. It is
 * deliberately *not* in any list of things to persist: reasoning is never
 * written to the conversation, only to the person watching it arrive.
 */
