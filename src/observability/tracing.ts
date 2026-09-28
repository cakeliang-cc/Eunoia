/**
 * Tracing (spec §14).
 *
 * The Agents SDK ships with an OpenAI-hosted tracing exporter enabled by
 * default. This runtime has no OpenAI credentials — it talks to DeepSeek — so
 * that exporter would fail on every run. Rather than disable tracing (which
 * §14 forbids in spirit), this installs a **custom processor** that writes
 * structured spans to the application log.
 *
 * Two properties matter here:
 *
 * 1. **Runs stay diagnosable.** Every span is emitted with its trace id, parent
 *    id, duration, and the fields that actually help debug a bad turn: which
 *    model ran, how many tokens it used, which tool was called, whether it
 *    errored.
 * 2. **No raw content leaks.** Function span `input`/`output` carry tool
 *    arguments, which for this product means memory content — the most
 *    sensitive text in the system. Those are fingerprinted, never logged.
 */

import {
  setTraceProcessors,
  setTracingDisabled,
  type Trace,
  type TracingProcessor,
} from '@openai/agents';
import { contentFingerprint, log } from './logging.ts';

/**
 * The span type the processor interface hands us.
 *
 * Derived from the interface rather than written as `Span<SpanData>` because the
 * SDK does not export its `SpanData` union, and hardcoding `any` would lose the
 * checking we want. This stays correct across SDK versions.
 */
type AnySpan = Parameters<TracingProcessor['onSpanStart']>[0];

/** Milliseconds between two ISO timestamps, or null if either is missing. */
function durationMs(startedAt: string | null, endedAt: string | null): number | null {
  if (!startedAt || !endedAt) return null;
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Extract the fields worth logging from a span, respecting the no-raw-content
 * rule. Returns an empty object for span types with nothing useful to say.
 */
function describeSpan(span: AnySpan): Record<string, unknown> {
  const data = span.spanData as { type?: string } & Record<string, unknown>;
  switch (data.type) {
    case 'generation':
      return {
        model: data.model,
        input_tokens: (data.usage as Record<string, unknown> | undefined)?.input_tokens,
        output_tokens: (data.usage as Record<string, unknown> | undefined)?.output_tokens,
      };
    case 'response':
      return { response_id: data.response_id };
    case 'function':
      // `input`/`output` here are tool arguments and results. Fingerprint them.
      return {
        tool: data.name,
        input: typeof data.input === 'string' ? contentFingerprint(data.input) : undefined,
        output: typeof data.output === 'string' ? contentFingerprint(data.output) : undefined,
      };
    case 'guardrail':
      return { guardrail: data.name };
    default:
      return {};
  }
}

export class StructuredTraceProcessor implements TracingProcessor {
  /** Spans in flight, so a span end can report its duration. */
  readonly #startedAt = new Map<string, string | null>();

  async onTraceStart(trace: Trace): Promise<void> {
    log.debug('trace.start', {
      trace_id: trace.traceId,
      name: trace.name,
    });
  }

  async onTraceEnd(trace: Trace): Promise<void> {
    log.info('trace.end', {
      trace_id: trace.traceId,
      name: trace.name,
      duration_ms: durationMs(
        (trace as { startedAt?: string | null }).startedAt ?? null,
        (trace as { endedAt?: string | null }).endedAt ?? null,
      ),
    });
  }

  async onSpanStart(span: AnySpan): Promise<void> {
    this.#startedAt.set(span.spanId, span.startedAt);
    log.debug('span.start', {
      trace_id: span.traceId,
      span_id: span.spanId,
      parent_id: span.parentId,
      span_type: (span.spanData as { type?: string }).type,
      ...describeSpan(span),
    });
  }

  async onSpanEnd(span: AnySpan): Promise<void> {
    const started = this.#startedAt.get(span.spanId) ?? span.startedAt;
    this.#startedAt.delete(span.spanId);
    log.debug('span.end', {
      trace_id: span.traceId,
      span_id: span.spanId,
      span_type: (span.spanData as { type?: string }).type,
      duration_ms: durationMs(started, span.endedAt),
      error: span.error?.message,
      ...describeSpan(span),
    });
  }

  async shutdown(): Promise<void> {
    this.#startedAt.clear();
  }

  async forceFlush(): Promise<void> {
    // Synchronous logging: nothing is buffered, so there is nothing to flush.
  }
}

/**
 * Install the structured processor in place of the SDK default.
 *
 * Call once at process start. Idempotent enough to be safe in tests.
 */
export function installTracing(): void {
  setTraceProcessors([new StructuredTraceProcessor()]);
  setTracingDisabled(false);
  log.info('tracing.installed', { exporter: 'structured-log' });
}
