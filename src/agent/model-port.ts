/**
 * The loop's model port.
 *
 * The loop owns iteration, tool dispatch and policy; it does not own a provider.
 * This interface is the seam: one implementation talks to the Agents SDK's
 * `Model`, a test implementation returns scripted turns, and neither the loop nor
 * a tool imports either.
 *
 * `LoopInputItem` is deliberately smaller than the SDK's `AgentInputItem`. The
 * SDK vocabulary is large because it supports images, hosted tools and provider
 * extensions; this product uses text, function calls and results. Keeping the
 * port small means a provider swap is a change in one adapter, not in the loop
 * and every test.
 */

import type { ToolSchema } from '../tools/types.ts';

export type LoopInputItem =
  | {
      readonly type: 'message';
      readonly role: 'user' | 'assistant' | 'system';
      readonly content: string;
    }
  | {
      readonly type: 'function_call';
      readonly callId: string;
      readonly name: string;
      readonly arguments: string;
    }
  | {
      readonly type: 'function_call_result';
      readonly callId: string;
      readonly name: string;
      readonly output: string;
    }
  | {
      readonly type: 'reasoning';
      readonly text: string;
      /** Provider item id, when the adapter has one to preserve. */
      readonly id?: string;
      /** The adapter's original item, replayed verbatim when present. */
      readonly raw?: unknown;
    };

export type LoopOutputItem =
  | {
      readonly type: 'message';
      readonly role: 'assistant';
      readonly content: string;
    }
  | {
      readonly type: 'function_call';
      readonly callId: string;
      readonly name: string;
      readonly arguments: string;
    }
  | {
      readonly type: 'reasoning';
      readonly text: string;
      readonly id?: string;
      readonly raw?: unknown;
    };

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cachedTokens: number;
}

export type ModelTurnEvent =
  | { readonly type: 'text_delta'; readonly text: string }
  | { readonly type: 'reasoning_delta'; readonly text: string }
  | { readonly type: 'reasoning_done' }
  | {
      readonly type: 'done';
      readonly output: readonly LoopOutputItem[];
      readonly usage?: ModelUsage;
      readonly responseId?: string;
    };

export interface ModelTurnRequest {
  readonly instructions: string;
  readonly input: readonly LoopInputItem[];
  readonly tools: readonly ToolSchema[];
  readonly signal?: AbortSignal;
}

/**
 * One model step: the model sees the whole input and produces either text, tool
 * calls, or both. It never executes a tool; that is the loop's job.
 */
export type ModelTurn = (request: ModelTurnRequest) => AsyncIterable<ModelTurnEvent>;
