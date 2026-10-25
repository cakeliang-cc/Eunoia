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
}

/** The run failed. `retryable` distinguishes a transient fault from a real error. */
export interface ErrorEvent {
  readonly type: 'error';
  readonly message: string;
  readonly retryable: boolean;
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
export const CONTENT_EVENT_TYPES = ['text_delta', 'thinking_delta', 'completed'] as const;
