/**
 * Narrowing the provider's stream events.
 *
 * These two functions are small and have both shipped a real bug, which is why
 * they are separate from the loop and pinned directly by tests:
 *
 * - The SDK normalises `response.output_text.delta` to `output_text_delta` but
 *   passes reasoning through under a generic `model` wrapper. Matching only one
 *   name produced zero text deltas while the turn still completed, so streaming
 *   looked correct in the final output and broken on screen.
 * - Reasoning fields sit one level deeper than text, for the same reason. A
 *   matcher written by analogy with the text one found nothing, and the person
 *   watched a static "…" for twelve seconds.
 *
 * The fix is tolerance: accept both names and both nestings. The cost is one
 * branch; the alternative is a silent regression.
 */

const TEXT_DELTA_EVENT_TYPES: ReadonlySet<string> = new Set([
  'output_text_delta',
  'response.output_text.delta',
]);

const REASONING_DELTA_TYPE = 'response.reasoning_text.delta';
const REASONING_DONE_TYPE = 'response.reasoning_text.done';

export type ReasoningChunk =
  | { readonly kind: 'delta'; readonly text: string }
  | { readonly kind: 'done' };

/** A text delta, or null when the event is anything else. */
export function textDeltaOf(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const event = data as { type?: unknown; delta?: unknown };
  if (typeof event.type !== 'string' || !TEXT_DELTA_EVENT_TYPES.has(event.type)) return null;
  return typeof event.delta === 'string' && event.delta.length > 0 ? event.delta : null;
}

/**
 * A reasoning delta or the end of the reasoning, or null.
 *
 * Accepts the wrapped shape the SDK actually sends (`{ type: 'model', event }`)
 * and the flat shape it would send if it ever normalised this event.
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

/**
 * Server-measured prompt-cache usage, when the provider reports it.
 *
 * The Responses API puts cached input tokens in `input_tokens_details`; Chat
 * Completions uses top-level fields. This accepts both, and returns null rather
 * than inventing a number when the provider said nothing.
 */
export function cacheUsageOf(
  usage:
    | {
        readonly inputTokens?: number;
        readonly promptTokens?: number;
        readonly inputTokensDetails?: readonly Record<string, number>[] | Record<string, number>;
        readonly promptTokensDetails?: Record<string, number>;
      }
    | null
    | undefined,
): { input_tokens: number; cached_tokens: number; cache_hit_rate: number } | null {
  if (!usage) return null;
  const input = usage.inputTokens ?? usage.promptTokens ?? 0;
  if (!(input > 0)) return null;

  let cached = 0;
  const details = usage.inputTokensDetails;
  if (Array.isArray(details)) {
    for (const detail of details) cached += Number(detail.cached_tokens ?? 0);
  } else if (details) {
    const record = details as Record<string, number>;
    cached += Number(record.cached_tokens ?? 0);
  }
  cached += Number(usage.promptTokensDetails?.cached_tokens ?? 0);

  return {
    input_tokens: input,
    cached_tokens: cached,
    cache_hit_rate: Number((cached / input).toFixed(4)),
  };
}
