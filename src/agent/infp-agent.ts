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
 */

import { Agent, run } from '@openai/agents';
import type { AgentEvent } from './events.ts';
import { buildInstructions } from './instructions.ts';
import { COMPANION_MODEL } from './model-client.ts';
import { log } from '../observability/logging.ts';

export const AGENT_NAME = 'INFPCompanion';

export interface StreamReplyOptions {
  /** Cancels the run when the client disconnects. */
  readonly signal?: AbortSignal;
  /** Upper bound on tool-calling turns, so a loop cannot run away. */
  readonly maxTurns?: number;
}

/**
 * Construct the companion.
 *
 * Requires the default model provider to be installed first — see
 * `installProvider()` in `model-client.ts`. Keeping construction separate from
 * provider setup means tests can build an agent without a live credential.
 */
export function createCompanionAgent(): Agent {
  return new Agent({
    name: AGENT_NAME,
    instructions: buildInstructions(),
    model: COMPANION_MODEL,
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
 * Run one turn and yield the reply as a transport-agnostic event stream.
 *
 * A non-streaming caller can ignore `text_delta` events and use the final
 * `completed` event, which carries the whole reply — so no separate
 * non-streaming code path is needed.
 */
export async function* streamReply(
  agent: Agent,
  message: string,
  options: StreamReplyOptions = {},
): AsyncIterable<AgentEvent> {
  const startedAt = Date.now();
  let collected = '';
  let sawToolCall = false;

  try {
    const result = await run(agent, message, {
      stream: true,
      signal: options.signal,
      maxTurns: options.maxTurns,
    });

    for await (const event of result) {
      if (event.type === 'raw_model_stream_event') {
        const delta = textDeltaOf(event.data);
        if (delta !== null) {
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
          yield { type: 'tool_call', callId: info.callId, name: info.name, displayable: false };
        } else if (event.name === 'tool_output') {
          yield { type: 'tool_result', callId: info.callId, name: info.name, ok: true };
        }
      }
    }

    // The iterator can finish before the run is marked complete, so awaiting
    // this is required — reading `finalOutput` early makes the SDK warn and can
    // yield a partial value.
    await result.completed;

    // Prefer the SDK's final output when present; fall back to the deltas.
    const final = (result as { finalOutput?: unknown }).finalOutput;
    const text = typeof final === 'string' && final.length > 0 ? final : collected;

    log.info('agent.turn_completed', {
      duration_ms: Date.now() - startedAt,
      reply_fingerprint: `len=${text.length}`,
      used_tools: sawToolCall,
    });

    yield { type: 'completed', text };
  } catch (error) {
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
