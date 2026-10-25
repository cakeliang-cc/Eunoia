/**
 * The single INFP companion agent (spec §8, ADR 001).
 *
 * There is exactly one agent. Fi/Ne/Si/Te are behavioural heuristics inside its
 * instructions, not four collaborating agents.
 *
 * This module owns the translation from the SDK's event stream into the
 * project's own `AgentEvent` stream. That translation is the transport boundary
 * in miniature: everything downstream — SSE, a future mini-program adapter,
 * tests — consumes `AgentEvent` and never sees an SDK type.
 *
 * It is a *raw* adapter: it starts a run and reports what happened. Policy —
 * when to retrieve memory, what to do about a risky message, what to persist —
 * lives in `src/service/`. Keeping those apart is what lets the whole
 * behavioural layer be tested against a fake runner with no model in the loop.
 */

import { Agent, run, type ModelProvider, type Tool } from '@openai/agents';
import type { AgentEvent, ThinkingDoneEvent } from './events.ts';
import { buildInstructions } from './instructions.ts';
import { COMPANION_MODEL } from './model-client.ts';
import { log } from '../observability/logging.ts';

export const AGENT_NAME = 'INFPCompanion';

export interface ConversationTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface StreamReplyOptions {
  /** Cancels the run when the client disconnects. */
  readonly signal?: AbortSignal;
  /** Upper bound on tool-calling turns, so a loop cannot run away. */
  readonly maxTurns?: number;
  /** Prior turns, oldest first. The new message is appended after these. */
  readonly history?: readonly ConversationTurn[];
  /** Tools the agent may call. Empty means none. */
  readonly tools?: readonly Tool[];
  /**
   * Per-turn context sent as a trailing system input item.
   *
   * It deliberately lives after the history: putting it in the system prompt
   * would make every changed memory or clock invalidate the cached history.
   */
  readonly context?: string | null;
  /**
   * The provider for this run. Supplied explicitly by the composition root so
   * multiple providers can coexist without a process-global default.
   */
  readonly modelProvider?: ModelProvider;
}

export interface AgentOptions {
  readonly tools?: readonly Tool[];
  /** Pin the companion model for this turn; defaults to the process model. */
  readonly model?: string;
  /** Provider used when the turn is executed; explicit, not process-global. */
  readonly modelProvider?: ModelProvider;
}

/**
 * Construct the companion.
 *
 * The model id can be pinned per conversation. The provider is supplied when
 * the run starts (`streamReply({ modelProvider })`); tests can build an agent
 * without a live credential, and multiple providers no longer need a
 * process-global default.
 */
export function createCompanionAgent(options: AgentOptions = {}): Agent {
  return new Agent({
    name: AGENT_NAME,
    // Stable bytes only. Per-turn context is sent after the history instead.
    instructions: buildInstructions(),
    model: options.model ?? COMPANION_MODEL,
    tools: [...(options.tools ?? [])],
  });
}

/**
 * Event names that carry a text delta.
 *
 * Two names are accepted because the SDK *normalises* the provider's event
 * before handing it to us. DeepSeek's Responses API sends the wire type
 * `response.output_text.delta`, but the SDK renames it to `output_text_delta`
 * and keeps the original nested under `providerData`. Matching only the wire
 * name silently produced zero deltas — the reply still completed, so the bug
 * was invisible except in the live test.
 *
 * Accepting both means this keeps working whether a given provider or SDK
 * version surfaces the normalised name or passes the wire name through.
 */
const TEXT_DELTA_EVENT_TYPES: ReadonlySet<string> = new Set([
  'output_text_delta',
  'response.output_text.delta',
]);

/**
 * Narrow a raw stream event to a text delta, if it is one.
 *
 * Exported for test: this is the function whose subtle mismatch produced a
 * silently un-streamed reply, so it is worth pinning directly.
 */
export function textDeltaOf(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const event = data as { type?: unknown; delta?: unknown };
  if (typeof event.type !== 'string' || !TEXT_DELTA_EVENT_TYPES.has(event.type)) return null;
  return typeof event.delta === 'string' && event.delta.length > 0 ? event.delta : null;
}

/**
 * The provider's reasoning events, which the SDK does *not* normalise.
 *
 * Measured against DeepSeek: a turn produced 648 of these and 438 text deltas,
 * and the first one arrived 12 seconds before the first character of the reply.
 * The SDK hands the whole provider event through under a generic `model` type,
 * so the useful fields are one level deeper than they are for text — that
 * asymmetry is the entire reason this needs its own function.
 */
const REASONING_DELTA_TYPE = 'response.reasoning_text.delta';
const REASONING_DONE_TYPE = 'response.reasoning_text.done';

export type ReasoningChunk =
  | { readonly kind: 'delta'; readonly text: string }
  | { readonly kind: 'done' };

/**
 * Narrow a raw stream event to a reasoning delta or the end of the reasoning.
 *
 * Both the wrapped shape the SDK actually sends and the flat shape it would
 * send if it ever normalised this event are accepted, for the same reason
 * `textDeltaOf` accepts two names: a silent rename is the failure mode this
 * code has already had once, and the cost of tolerating both is one branch.
 *
 * Exported for test.
 */
export function reasoningChunkOf(data: unknown): ReasoningChunk | null {
  if (typeof data !== 'object' || data === null) return null;
  const outer = data as { type?: unknown; delta?: unknown; event?: unknown };
  const inner =
    typeof outer.event === 'object' && outer.event !== null
      ? (outer.event as { type?: unknown; delta?: unknown })
      : outer;
  if (typeof inner.type !== 'string') return null;

  if (inner.type === REASONING_DONE_TYPE) return { kind: 'done' };
  if (inner.type !== REASONING_DELTA_TYPE) return null;

  return typeof inner.delta === 'string' && inner.delta.length > 0
    ? { kind: 'delta', text: inner.delta }
    : null;
}

/** Pull the tool name and call id out of a run item, defensively. */
function toolInfoOf(item: unknown): { callId: string; name: string } | null {
  if (typeof item !== 'object' || item === null) return null;
  const raw = (item as { rawItem?: unknown }).rawItem;
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as { name?: unknown; callId?: unknown; call_id?: unknown; id?: unknown };
  const name = typeof record.name === 'string' ? record.name : null;
  const callId =
    typeof record.callId === 'string'
      ? record.callId
      : typeof record.call_id === 'string'
        ? record.call_id
        : typeof record.id === 'string'
          ? record.id
          : null;
  if (!name || !callId) return null;
  return { callId, name };
}

/**
 * One prior turn, in the shape the Responses API expects.
 *
 * The asymmetry between the two roles is not ours to choose: a user message
 * takes a plain string, while an assistant message must carry `status` and its
 * content as typed parts. Sending an assistant turn in the user's shape produces
 * a 400 from the provider, which is why this is typed explicitly rather than
 * inferred from a map.
 */
export type RunInputItem =
  | { readonly role: 'user'; readonly content: string; readonly type: 'message' }
  | {
      readonly role: 'assistant';
      readonly status: 'completed';
      readonly content: { readonly type: 'output_text'; readonly text: string }[];
      readonly type: 'message';
    }
  | { readonly role: 'system'; readonly content: string; readonly type: 'message' };

/**
 * Build the run input.
 *
 * History is passed as explicit message items rather than as a session object,
 * because the conversation's canonical copy lives in Postgres and a second
 * in-SDK copy would be a second source of truth about what was said. It also
 * means the exact prompt sent on a turn is reconstructible from our own data,
 * which is what the evaluation runner needs.
 *
 * The per-turn context is appended after the current user message, never
 * before it. That ordering keeps the persisted history as the leading bytes of
 * the next request: the context is new tail, not a changed head. DeepSeek's
 * Responses API accepts a `system` input item in this position.
 *
 * The single-message, no-context case still passes a bare string: it is the
 * shape the provider sees most often, and there is no reason to make the common
 * path go through the array form.
 */
export function buildRunInput(
  message: string,
  history: readonly ConversationTurn[] = [],
  context?: string | null,
): string | RunInputItem[] {
  const trailing = context?.trim();
  if (history.length === 0 && !trailing) return message;

  const items: RunInputItem[] = history.map((turn) =>
    turn.role === 'user'
      ? { role: 'user' as const, content: turn.content, type: 'message' as const }
      : {
          role: 'assistant' as const,
          status: 'completed' as const,
          content: [{ type: 'output_text' as const, text: turn.content }],
          type: 'message' as const,
        },
  );

  items.push({ role: 'user', content: message, type: 'message' });
  if (trailing) {
    items.push({ role: 'system', content: trailing, type: 'message' });
  }
  return items;
}

/**
 * Server-measured prompt-cache usage, when the provider reports it.
 *
 * The Responses API puts cached input tokens in `input_tokens_details`;
 * Chat Completions uses top-level fields. This helper accepts both, and returns
 * null rather than inventing a number when the provider said nothing.
 */
export function cacheUsageOf(
  usage:
    | {
        readonly inputTokens?: number;
        readonly promptTokens?: number;
        readonly inputTokensDetails?: readonly Record<string, number>[];
        readonly promptTokensDetails?: Record<string, number>;
      }
    | null
    | undefined,
): { input_tokens: number; cached_tokens: number; cache_hit_rate: number } | null {
  if (!usage) return null;
  const input = usage.inputTokens ?? usage.promptTokens ?? 0;
  if (!(input > 0)) return null;

  let cached = 0;
  for (const detail of usage.inputTokensDetails ?? []) {
    cached += Number(detail.cached_tokens ?? 0);
  }
  cached += Number(usage.promptTokensDetails?.cached_tokens ?? 0);

  return {
    input_tokens: input,
    cached_tokens: cached,
    cache_hit_rate: Number((cached / input).toFixed(4)),
  };
}

/**
 * Run one turn and yield the reply as a transport-agnostic event stream.
 *
 * A non-streaming caller can ignore `text_delta` events and use the final
 * `completed` event, which carries the whole reply — so no separate
 * non-streaming code path is needed. The same is true of `thinking_delta`,
 * which a client may show, collapse, or drop without affecting correctness.
 *
 * The reasoning phase is forwarded rather than discarded because the wait is
 * long enough to be mistaken for a broken stream. See `ThinkingDeltaEvent`.
 */
export async function* streamReply(
  agent: Agent,
  message: string,
  options: StreamReplyOptions = {},
): AsyncIterable<AgentEvent> {
  const startedAt = Date.now();
  let collected = '';
  let sawToolCall = false;

  let thinkingStartedAt: number | null = null;
  let thinkingClosed = false;
  let reasoningChars = 0;

  /**
   * Close the reasoning block, once.
   *
   * Returns the event to yield rather than yielding it, because a generator
   * cannot yield from inside a closure. Called on the provider's own
   * end-of-reasoning signal, on the first character of the reply, and after the
   * stream ends — whichever happens first — so a client never has to guess
   * whether a thinking block is still live.
   */
  const closeThinking = (): ThinkingDoneEvent | null => {
    if (thinkingStartedAt === null || thinkingClosed) return null;
    thinkingClosed = true;
    return { type: 'thinking_done', elapsedMs: Date.now() - thinkingStartedAt };
  };

  try {
    const result = await run(agent, buildRunInput(message, options.history, options.context), {
      stream: true as const,
      signal: options.signal,
      maxTurns: options.maxTurns,
      ...(options.modelProvider ? { modelProvider: options.modelProvider } : {}),
    });

    for await (const event of result) {
      if (event.type === 'raw_model_stream_event') {
        const reasoning = reasoningChunkOf(event.data);
        if (reasoning !== null) {
          if (reasoning.kind === 'delta') {
            thinkingStartedAt ??= Date.now();
            reasoningChars += reasoning.text.length;
            yield { type: 'thinking_delta', text: reasoning.text };
          } else {
            const closed = closeThinking();
            if (closed) yield closed;
          }
          continue;
        }

        const delta = textDeltaOf(event.data);
        if (delta !== null) {
          const closed = closeThinking();
          if (closed) yield closed;
          collected += delta;
          yield { type: 'text_delta', text: delta };
        }
        continue;
      }

      if (event.type === 'run_item_stream_event') {
        const info = toolInfoOf(event.item);
        if (!info) continue;

        if (event.name === 'tool_called') {
          sawToolCall = true;
          log.debug('agent.tool_call', { tool: info.name, call_id: info.callId });
          yield { type: 'tool_call', callId: info.callId, name: info.name, displayable: true };
        } else if (event.name === 'tool_output') {
          yield { type: 'tool_result', callId: info.callId, name: info.name, ok: true };
        }
      }
    }

    // A model that reasons and then calls a tool produces no reply text at all
    // before the call, so this is the only place that can close the block.
    const dangling = closeThinking();
    if (dangling) yield dangling;

    // The iterator can finish before the run is marked complete, so awaiting
    // this is required — reading `finalOutput` early makes the SDK warn and can
    // yield a partial value.
    await result.completed;

    // Prefer the SDK's final output when present; fall back to the deltas.
    const final = (result as { finalOutput?: unknown }).finalOutput;
    const text = typeof final === 'string' && final.length > 0 ? final : collected;

    const cache = cacheUsageOf(result.state?.usage);
    log.info('agent.turn_completed', {
      duration_ms: Date.now() - startedAt,
      reply_fingerprint: `len=${text.length}`,
      // A count, never the text. The reasoning is the model's working-out and
      // goes to the person watching it, not into a log line (spec §14).
      reasoning_chars: reasoningChars,
      used_tools: sawToolCall,
      ...(cache ?? {}),
    });

    yield { type: 'completed', text };
  } catch (error) {
    const closed = closeThinking();
    if (closed) yield closed;

    const message = error instanceof Error ? error.message : String(error);
    const retryable = !(error instanceof Error && error.name.includes('Guardrail'));
    log.error('agent.turn_failed', {
      duration_ms: Date.now() - startedAt,
      error: message,
      retryable,
    });
    yield { type: 'error', message, retryable };
  }
}
