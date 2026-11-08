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
import type { ModelMessageContent } from './content.ts';
import type { PreparedMediaPlan } from './request-plan.ts';

export type LoopInputItem =
  | {
      readonly type: 'message';
      readonly role: 'user' | 'assistant' | 'system';
      /**
       * A user message may be an ordered block list; every other role stays a
       * plain string because its content constraints are not an arbitrary media
       * array.
       */
      readonly content: ModelMessageContent;
      /**
       * Who authored the message. Budget protection, turn boundaries and user
       * counting key on this, never on `role === 'user'`: an adapter may encode
       * background as a user message for cache-friendly ordering, and that must
       * not make it look like the person's current turn.
       */
      readonly source?: 'conversation' | 'background' | 'summary' | 'team_message';
      /** The real turn a background update belongs to, when scope=turn. */
      readonly turnId?: string;
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
  /** The provider's response model, when it differs from the requested one. */
  readonly responseModel?: string;
  /**
   * False when the provider omitted the whole usage object's numeric fields.
   *
   * The adapter keeps the numeric type for the common path, but a transcript
   * must be able to store null rather than a fabricated zero.
   */
  readonly reported?: boolean;
  /** False when cache detail was absent, so cachedTokens is not known to be 0. */
  readonly cacheReported?: boolean;
  /** Provider cache-write tokens, when the route exposes them. */
  readonly cacheWriteTokens?: number;
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
    }
  /**
   * The provider's stream ended without its completion event.
   *
   * Distinct from `done` on purpose: the text (if any) is real and must be kept,
   * but "the connection closed" is not "the model finished". The loop turns this
   * into `finishReason: 'incomplete_stream'`.
   */
  | {
      readonly type: 'incomplete';
      readonly output: readonly LoopOutputItem[];
      readonly usage?: ModelUsage;
      readonly responseId?: string;
      readonly reason?: string;
    };

export interface ModelTurnRequest {
  readonly instructions: string;
  readonly input: readonly LoopInputItem[];
  readonly tools: readonly ToolSchema[];
  readonly signal?: AbortSignal;
  /**
   * The fixed media plan for this turn.
   *
   * The adapter encodes exactly these bytes and counts these variants; it may
   * not re-read, re-scale or substitute an image at send time. Present whenever
   * any input item contains an image part.
   */
  readonly media?: PreparedMediaPlan;
  /**
   * Called by the adapter with a canonical projection of the encoded request.
   *
   * It carries hashes and sizes, never credentials, image bytes or response
   * ids. The transcript uses it to prove what was actually sent.
   */
  readonly capture?: (projection: import('../session/model-transcript.ts').RequestProjection) => void;
}

/**
 * One model step: the model sees the whole input and produces either text, tool
 * calls, or both. It never executes a tool; that is the loop's job.
 */
export type ModelTurn = (request: ModelTurnRequest) => AsyncIterable<ModelTurnEvent>;
