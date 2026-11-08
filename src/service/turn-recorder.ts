/**
 * Bind the agent loop's execution log to a turn's persisted events.
 *
 * The loop knows the order but nothing about storage; `TurnStore` knows storage
 * but nothing about the loop. This adapter is the join, and it lives in the
 * service layer because a turn is a service concept.
 *
 * What is stored is deliberately bounded. Tool arguments are kept verbatim —
 * they are what the model asked for, and a truncated argument cannot be audited.
 * Tool output is cut at a diagnostic length: the full body already had one life
 * in the model's context, and copying a 200 KB file into an audit row would make
 * recovery slower than the failure it is recovering from.
 */

import type { ExecutionRecorder, RecordedToolCall, RecordedToolResult } from '../agent/execution-log.ts';
import type { TurnStore } from '../session/turn-store.ts';

/** How much of a tool result is kept for diagnosis. */
const MAX_RECORDED_OUTPUT_CHARS = 2_000;

export interface StoreTurnRecorderOptions {
  readonly store: TurnStore;
  /** The request id, which is also `turn_requests.id`. */
  readonly turnId: string;
  readonly conversationId: string;
}

export class StoreTurnRecorder implements ExecutionRecorder {
  readonly #store: TurnStore;
  readonly #turnId: string;
  readonly #conversationId: string;

  constructor(options: StoreTurnRecorderOptions) {
    this.#store = options.store;
    this.#turnId = options.turnId;
    this.#conversationId = options.conversationId;
  }

  async toolCallRequested(call: RecordedToolCall): Promise<void> {
    await this.#store.appendTurnEvent({
      turnId: this.#turnId,
      conversationId: this.#conversationId,
      kind: 'tool_call',
      callId: call.callId,
      toolName: call.name,
      // `running` rather than `requested`: the loop records the call and invokes
      // it in the same step, so the only observable window is "about to run".
      // Recovery treats both the same way — an outcome nobody observed.
      status: 'running',
      payload: {
        arguments: call.arguments,
        ...(call.summary ? { summary: call.summary } : {}),
      },
    });
  }

  async toolResult(result: RecordedToolResult): Promise<void> {
    await this.#store.appendTurnEvent({
      turnId: this.#turnId,
      conversationId: this.#conversationId,
      kind: 'tool_result',
      callId: result.callId,
      toolName: result.name,
      status: result.status,
      executionId: result.executionId ?? null,
      payload: {
        ok: result.ok,
        output: result.output.slice(0, MAX_RECORDED_OUTPUT_CHARS),
        outputChars: result.outputChars,
        ...(result.summary ? { summary: result.summary } : {}),
      },
    });
  }

  async assistantText(step: number, text: string): Promise<void> {
    await this.#store.appendTurnEvent({
      turnId: this.#turnId,
      conversationId: this.#conversationId,
      kind: 'assistant_text',
      status: 'succeeded',
      payload: { step, text },
    });
  }
}
