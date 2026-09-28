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
}

/** A tool call finished. */
export interface ToolResultEvent {
  readonly type: 'tool_result';
  readonly callId: string;
  readonly name: string;
  readonly ok: boolean;
}

/** The run finished normally. `text` is the complete assistant reply. */
export interface CompletedEvent {
  readonly type: 'completed';
  readonly text: string;
}

/** The run failed. `retryable` distinguishes a transient fault from a real error. */
export interface ErrorEvent {
  readonly type: 'error';
  readonly message: string;
  readonly retryable: boolean;
}

export type AgentEvent =
  | TextDeltaEvent
  | ToolCallEvent
  | ToolResultEvent
  | CompletedEvent
  | ErrorEvent;

/** Event types that carry assistant-visible content. */
export const CONTENT_EVENT_TYPES = ['text_delta', 'completed'] as const;
