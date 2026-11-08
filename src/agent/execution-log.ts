/**
 * The loop's execution log port.
 *
 * The loop is the only place that knows the order: the model asked for this
 * call, then the call ran, then its result went back to the model. Persisting
 * that order is what makes the difference between "the process died" and "we do
 * not know what the process was doing".
 *
 * Two rules shape this interface:
 *
 *   - **Calls are written before they run.** A record written after execution
 *     cannot answer the question a crash actually asks. The call row is written
 *     first, so its presence means "this was requested"; its status says how far
 *     it got.
 *   - **Recording never fails a turn.** The recorder is bookkeeping; the reply is
 *     the product. The loop wraps every call in a guarded write, so a full disk
 *     degrades recovery information rather than the conversation.
 *
 * Deliberately *not* here: replay. The recorder answers "what happened"; it never
 * decides to run something again. That is ADR 028's boundary, and the sandbox's
 * own reconciliation is the only thing allowed to resolve an unknown outcome.
 */

/** One tool call, as the model asked for it. */
export interface RecordedToolCall {
  readonly callId: string;
  readonly name: string;
  /** The raw JSON argument string, exactly as the model produced it. */
  readonly arguments: string;
  readonly summary?: string;
}

/** One tool result, after the call returned (or failed). */
export interface RecordedToolResult {
  readonly callId: string;
  readonly name: string;
  readonly ok: boolean;
  readonly status: 'succeeded' | 'failed' | 'unknown';
  /** The sandbox execution id, when the tool produced one. */
  readonly executionId?: string;
  /** Bounded result text; the full body is not an audit requirement. */
  readonly output: string;
  readonly outputChars: number;
  readonly summary?: string;
}

/**
 * What the loop reports, in the order it happens.
 *
 * `assistantText` is per model step rather than per delta: a write per token
 * would make the log the slowest part of a turn, and a step's text is the
 * smallest unit recovery can honestly reconstruct.
 */
export interface ExecutionRecorder {
  toolCallRequested(call: RecordedToolCall): Promise<void>;
  toolResult(result: RecordedToolResult): Promise<void>;
  /** Text the model produced in one step, before any tool calls it made. */
  assistantText(step: number, text: string): Promise<void>;
}
