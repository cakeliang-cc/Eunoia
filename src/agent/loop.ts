/**
 * The agent loop.
 *
 * One user turn may take several model steps: the model reads, decides it needs
 * another file, reads that, then answers. This module owns that iteration:
 *
 *   model step → parse tool calls → check policy → run tools → feed results back
 *
 * What it deliberately does *not* own:
 *
 *   - **Transport.** A `ModelTurn` port is all it sees; the SDK adapter lives in
 *     `model-turn.ts`.
 *   - **Tool behaviour.** Tools are registry entries; this loop only schedules
 *     them, bounds them and reports them.
 *   - **Approval.** The policy is a value. There is no callback because the chat
 *     transport is a one-way stream; consent is given before the turn.
 *
 * Design notes that came from WhalePod's loop:
 *
 *   - reads run concurrently, writes strictly sequentially (two writes to one
 *     file racing is not theoretical);
 *   - results are appended in call order even when execution was concurrent,
 *     because providers match calls by position and id;
 *   - the step cap is a safety property, not a failure — it produces a partial
 *     answer and an explicit "stopped" notice;
 *   - a malformed tool call is reported to the model *as a malformed call*, not
 *     as a missing file.
 *
 * See docs/adr/014-coding-tools-and-agent-loop.md.
 */

import type { ZodError } from 'zod';
import { policyDenial } from '../tools/policy.ts';
import { parseToolArguments } from '../tools/schema.ts';
import { summarizeToolCall, summarizeToolResult } from '../tools/summary.ts';
import { truncateLine, truncateMiddle } from '../tools/truncate.ts';
import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from '../tools/types.ts';
import { renderToolResult, toolError } from '../tools/types.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { AgentEvent, ThinkingDoneEvent } from './events.ts';
import type {
  LoopInputItem,
  LoopOutputItem,
  ModelTurn,
  ModelUsage,
} from './model-port.ts';
import { log } from '../observability/logging.ts';

export const DEFAULT_MAX_STEPS = 12;
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
const MAX_PARALLEL_READS = 4;
/**
 * A hard budget for all tool output in one turn.
 *
 * Per-call truncation bounds one result; without a total, twelve calls at the
 * per-call limit still add up to more than the session budget. The model gets a
 * refusal and a suggestion to narrow the request, which it can act on.
 */
const MAX_TURN_TOOL_CHARS = 240_000;

export interface AgentLoopOptions {
  readonly modelTurn: ModelTurn;
  readonly instructions: string;
  /** History, the current user message, then the per-turn context. */
  readonly input: readonly LoopInputItem[];
  readonly tools: ToolRegistry;
  /** Workspace, policy and ledger for this turn. `signal` is supplied per call. */
  readonly toolContext: Omit<ToolContext, 'signal'>;
  readonly maxSteps?: number;
  readonly signal?: AbortSignal;
}

interface CallPlan {
  readonly call: ToolCall;
  readonly definition: ToolDefinition | undefined;
  readonly args: Record<string, unknown>;
  readonly summary: string;
  readonly parseError: string | null;
}

interface Invocation {
  readonly result: ToolResult;
  readonly durationMs: number;
}

export async function* runAgentLoop(options: AgentLoopOptions): AsyncIterable<AgentEvent> {
  const startedAt = Date.now();
  const maxSteps = Math.max(1, options.maxSteps ?? DEFAULT_MAX_STEPS);
  const input: LoopInputItem[] = [...options.input];

  let reply = '';
  let thinkingStartedAt: number | null = null;
  let thinkingClosed = false;
  let reasoningChars = 0;
  let toolCount = 0;
  let toolChars = 0;
  let lastUsage: ModelUsage | undefined;

  /**
   * Close the reasoning block, once.
   *
   * Returns the event to yield rather than yielding it, because a generator
   * cannot yield from inside a closure. Called on the provider's own end signal,
   * on the first reply character, and after the stream — whichever comes first —
   * so a client never has to guess whether a thinking block is still live.
   */
  const closeThinking = (): ThinkingDoneEvent | null => {
    if (thinkingStartedAt === null || thinkingClosed) return null;
    thinkingClosed = true;
    return { type: 'thinking_done', elapsedMs: Date.now() - thinkingStartedAt };
  };

  try {
    for (let step = 1; step <= maxSteps; step += 1) {
      throwIfAborted(options.signal);

      const output: LoopOutputItem[] = [];
      let sawTextDelta = false;
      let done = false;

      for await (const event of options.modelTurn({
        instructions: options.instructions,
        input,
        tools: options.tools.schemas(),
        ...(options.signal ? { signal: options.signal } : {}),
      })) {
        if (event.type === 'text_delta') {
          const closed = closeThinking();
          if (closed) yield closed;
          sawTextDelta = true;
          reply += event.text;
          yield event;
          continue;
        }

        if (event.type === 'reasoning_delta') {
          thinkingStartedAt ??= Date.now();
          reasoningChars += event.text.length;
          yield { type: 'thinking_delta', text: event.text };
          continue;
        }

        if (event.type === 'reasoning_done') {
          const closed = closeThinking();
          if (closed) yield closed;
          continue;
        }

        output.push(...event.output);
        if (event.usage) lastUsage = event.usage;
        done = true;
      }

      if (!done) throw new Error('model step ended without a completion event');

      const closed = closeThinking();
      if (closed) yield closed;

      // A non-streaming fake (and some providers) deliver the assistant text
      // only in the final item. The person saw nothing in that case, so emit it
      // as a delta too — `completed` alone would leave the bubble empty until
      // the very end.
      if (!sawTextDelta) {
        const message = output
          .filter((item): item is Extract<LoopOutputItem, { type: 'message' }> => item.type === 'message')
          .map((item) => item.content)
          .join('');
        if (message.length > 0) {
          reply += message;
          yield { type: 'text_delta', text: message };
        }
      }

      // The model must see its own calls before their results, and reasoning is
      // replayed because DeepSeek requires it on tool-call turns.
      for (const item of output) input.push(outputToInput(item));

      const calls = output.filter(
        (item): item is Extract<LoopOutputItem, { type: 'function_call' }> =>
          item.type === 'function_call',
      );

      if (calls.length === 0) {
        log.info('agent.turn_completed', {
          duration_ms: Date.now() - startedAt,
          reply_fingerprint: `len=${reply.length}`,
          reasoning_chars: reasoningChars,
          used_tools: toolCount > 0,
          tool_calls: toolCount,
          tool_chars: toolChars,
          steps: step,
          ...cacheLog(lastUsage),
        });
        yield { type: 'completed', text: reply };
        return;
      }

      toolCount += calls.length;
      yield* executeCalls(calls);
    }

    // Cap reached. Everything the model did is still a valid partial turn, so
    // this is a notice and a completion, not an error: the person can say
    // "continue" and the next turn starts from what is already on screen.
    const note =
      `[达到 ${maxSteps} 步工具调用上限，还没有给出最终回答。` +
      `说"继续"可以让我接着做。]`;
    const text = reply.trim().length > 0 ? `${reply}\n\n${note}` : note;
    yield { type: 'loop_exhausted', steps: maxSteps };
    yield { type: 'completed', text };
  } catch (error) {
    const closed = closeThinking();
    if (closed) yield closed;

    const message = error instanceof Error ? error.message : String(error);
    const aborted = options.signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
    log.error('agent.turn_failed', {
      duration_ms: Date.now() - startedAt,
      error: message,
      aborted,
    });
    yield { type: 'error', message: aborted ? 'cancelled' : message, retryable: !aborted };
  }

  /**
   * Run a step's calls in the order the model gave them.
   *
   * Consecutive read-only calls are dispatched together, up to a cap. Everything
   * else is strictly sequential: a write needs its own turn, and two writes to
   * the same file must not race.
   */
  async function* executeCalls(
    calls: readonly Extract<LoopOutputItem, { type: 'function_call' }>[],
  ): AsyncIterable<AgentEvent> {
    let index = 0;
    while (index < calls.length) {
      const plans: CallPlan[] = [];
      const first = planFor(calls[index] as Extract<LoopOutputItem, { type: 'function_call' }>);

      if (first.definition?.readOnly === true) {
        while (index < calls.length && plans.length < MAX_PARALLEL_READS) {
          const next = planFor(
            calls[index] as Extract<LoopOutputItem, { type: 'function_call' }>,
          );
          if (next.definition?.readOnly !== true) break;
          plans.push(next);
          index += 1;
        }
      } else {
        plans.push(first);
        index += 1;
      }

      for (const plan of plans) {
        yield {
          type: 'tool_call',
          callId: plan.call.callId,
          name: plan.call.name,
          displayable: true,
          summary: plan.summary,
        };
      }

      if (plans.length > 1) {
        const results = await Promise.all(plans.map((plan) => invoke(plan)));
        for (const [offset, plan] of plans.entries()) {
          const invocation = results[offset] as Invocation;
          input.push({
            type: 'function_call_result',
            callId: plan.call.callId,
            name: plan.call.name,
            output: renderToolResult(invocation.result),
          });
          yield toolResultEvent(plan, invocation);
        }
        continue;
      }

      const plan = plans[0] as CallPlan;
      const invocation = await invoke(plan);
      input.push({
        type: 'function_call_result',
        callId: plan.call.callId,
        name: plan.call.name,
        output: renderToolResult(invocation.result),
      });
      yield toolResultEvent(plan, invocation);
    }
  }

  function planFor(call: Extract<LoopOutputItem, { type: 'function_call' }>): CallPlan {
    const parsed = parseToolArguments(call.arguments);
    const args = parsed.ok
      ? (parsed.value as Record<string, unknown>)
      : {};
    const definition = options.tools.get(call.name);
    return {
      call: { callId: call.callId, name: call.name, arguments: call.arguments },
      definition,
      args,
      summary: summarizeToolCall(call.name, args),
      parseError: parsed.ok ? null : parsed.error,
    };
  }

  async function invoke(plan: CallPlan): Promise<Invocation> {
    const startedAtMs = Date.now();

    if (plan.parseError !== null) {
      return { result: toolError(plan.parseError), durationMs: Date.now() - startedAtMs };
    }
    if (!plan.definition) {
      return {
        result: toolError(
          `unknown tool ${JSON.stringify(plan.call.name)}. Available: ${options.tools.names().join(', ')}`,
        ),
        durationMs: Date.now() - startedAtMs,
      };
    }

    const denial = policyDenial(plan.definition, options.toolContext.policy);
    if (denial !== null) {
      return { result: toolError(denial), durationMs: Date.now() - startedAtMs };
    }

    const parsed = plan.definition.parameters.safeParse(plan.args);
    if (!parsed.success) {
      return {
        result: toolError(`invalid arguments for ${plan.call.name}: ${formatIssues(parsed.error)}`),
        durationMs: Date.now() - startedAtMs,
      };
    }

    const timeoutMs = plan.definition.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    let timer: NodeJS.Timeout | undefined;
    try {
      const execution = plan.definition.execute(parsed.data, {
        ...options.toolContext,
        signal: controller.signal,
      });
      const result = await Promise.race([
        execution,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            // Abort as well as reject: a command tool that listens can kill its
            // child instead of running to its own, longer timeout in the
            // background.
            controller.abort();
            reject(new Error(`tool timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          timer.unref();
        }),
      ]);
      const perCall = clampOutput(result, options.toolContext.policy.maxOutputChars);
      const remaining = MAX_TURN_TOOL_CHARS - toolChars;
      const bounded =
        remaining <= 0
          ? toolError(
              `本轮工具输出已经达到 ${MAX_TURN_TOOL_CHARS} 字符上限；不要再读更多内容，基于已有的结果回答，或让用户把请求缩小。`,
            )
          : clampOutput(perCall, remaining);
      toolChars += bounded.output.length;
      return {
        result: bounded,
        durationMs: Date.now() - startedAtMs,
      };
    } catch (error) {
      return {
        result: toolError(error instanceof Error ? error.message : String(error)),
        durationMs: Date.now() - startedAtMs,
      };
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  function toolResultEvent(plan: CallPlan, invocation: Invocation): AgentEvent {
    const { result } = invocation;
    return {
      type: 'tool_result',
      callId: plan.call.callId,
      name: plan.call.name,
      ok: result.ok,
      durationMs: invocation.durationMs,
      summary: summarizeToolResult(plan.call.name, result),
      ...(result.ok
        ? {}
        : { error: truncateLine(result.error ?? 'tool failed', 300) }),
    };
  }
}

/**
 * Append an output item to the next request.
 *
 * A reasoning item is replayed with its original provider representation when
 * the adapter kept one: DeepSeek requires reasoning on tool-call continuations,
 * and reconstructing it from text is a weaker approximation than passing the
 * item back.
 */
function outputToInput(item: LoopOutputItem): LoopInputItem {
  if (item.type === 'reasoning') {
    return {
      type: 'reasoning',
      text: item.text,
      ...(item.id ? { id: item.id } : {}),
      ...(item.raw !== undefined ? { raw: item.raw } : {}),
    };
  }
  return item;
}

/**
 * Enforce the turn's hard output cap after the tool's own (semantic) truncation.
 *
 * This is a middle-out cut on purpose only because it is a last-resort cap: a
 * tool that hits it has already failed to bound itself, and losing the middle of
 * an unbounded result is better than letting one call fill the window. Tools
 * that know what they are returning cut at one end instead.
 */
function clampOutput(result: ToolResult, maxChars: number): ToolResult {
  if (result.output.length <= maxChars) return result;
  return {
    ...result,
    output: truncateMiddle(result.output, maxChars),
    meta: { ...result.meta, truncated: true },
  };
}

function formatIssues(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

function cacheLog(usage: ModelUsage | undefined): Record<string, number> {
  if (!usage || usage.inputTokens <= 0) return {};
  return {
    input_tokens: usage.inputTokens,
    cached_tokens: usage.cachedTokens,
    cache_hit_rate: Number((usage.cachedTokens / usage.inputTokens).toFixed(4)),
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error('cancelled');
  error.name = 'AbortError';
  throw error;
}
