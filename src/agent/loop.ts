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
import type { ToolCall, ToolContext, ToolDefinition, ToolResult, ToolSchema } from '../tools/types.ts';
import { renderToolResult, toolError } from '../tools/types.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { AgentEvent, ThinkingDoneEvent } from './events.ts';
import type { ExecutionRecorder } from './execution-log.ts';
import { fitContext, type ContextBudget } from './context-budget.ts';
import type { PreparedMediaPlan } from './request-plan.ts';
import type {
  LoopInputItem,
  LoopOutputItem,
  ModelTurn,
  ModelUsage,
} from './model-port.ts';
import { log } from '../observability/logging.ts';
import type { RequestProjection } from '../session/model-transcript.ts';

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

/**
 * The transcript seam the loop writes through (ADR 032).
 *
 * Keeping this an interface means the loop stays storage-agnostic: a CLI or an
 * evaluation can run it with no transcript, and the durable implementation in
 * `service/model-transcript.ts` is the only thing that knows about epochs.
 *
 * Two failure rules are non-negotiable and enforced by the loop:
 *
 *   - `prepareStep` failing means the model is not called at all;
 *   - `completeStep`/`recordToolResult` failing means no further model request
 *     is sent. A tool that already ran is not re-run; the turn ends and recovery
 *     reconciles the side effect.
 */
export interface LoopTranscriptStepRequest {
  readonly step: number;
  readonly attemptNo: number;
  readonly input: readonly LoopInputItem[];
  readonly requestInput: readonly LoopInputItem[];
  readonly instructions: string;
  readonly tools: readonly ToolSchema[];
  readonly media?: PreparedMediaPlan;
  readonly estimatedTokens: number | null;
}

export interface LoopTranscriptPreparation {
  readonly attemptId: string;
  readonly inputItemIds: readonly string[];
  /**
   * The view the loop should carry into later steps when the actual request had
   * to be trimmed. Persisting the trimmed view is what stops a trimmed tool
   * result from reappearing on the next step or after restart.
   */
  readonly replacementInput?: readonly LoopInputItem[];
}

export interface LoopTranscriptCompletion {
  readonly step: number;
  readonly attemptNo: number;
  readonly attemptId: string;
  readonly inputItemIds: readonly string[];
  readonly output: readonly LoopOutputItem[];
  readonly usage?: ModelUsage;
  readonly responseId?: string;
  readonly projection?: RequestProjection;
  readonly status: 'completed' | 'incomplete' | 'failed';
  readonly finishReason?: string;
  readonly error?: string;
}

export interface LoopTranscript {
  prepareStep(request: LoopTranscriptStepRequest): Promise<LoopTranscriptPreparation>;
  completeStep(completion: LoopTranscriptCompletion): Promise<void>;
  recordToolResult(result: {
    readonly step: number;
    readonly item: Extract<LoopInputItem, { type: 'function_call_result' }>;
    readonly meta?: Record<string, unknown>;
    readonly ok: boolean;
  }): Promise<void>;
  failStep(result: {
    readonly step: number;
    readonly attemptId: string;
    readonly status: 'incomplete' | 'failed' | 'unknown';
    readonly error: string;
  }): Promise<void>;
}

export class ModelTranscriptUnavailableError extends Error {
  readonly code = 'MODEL_TRANSCRIPT_UNAVAILABLE';
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = 'ModelTranscriptUnavailableError';
  }
}

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
  /**
   * Where the execution log goes, when a turn is being persisted.
   *
   * Optional because an evaluation run has nobody to recover it. The loop never
   * requires it: recording is bookkeeping, and its failure must not end a turn.
   */
  readonly recorder?: ExecutionRecorder;
  /**
   * The model's window, applied before every request.
   *
   * Optional: a loop with no budget (tests, a caller that does not know the
   * model) behaves exactly as before. Production always supplies it, because the
   * session layer's budget covers the history, not the turn.
   */
  readonly contextBudget?: ContextBudget;
  /**
   * Fixed media plan for this turn. The same plan is used by every step's budget
   * and by the adapter, so an image cannot be counted at one size and sent at
   * another.
   */
  readonly media?: PreparedMediaPlan;
  /** Durable replay recorder. Absent in legacy mode and in evaluation runs. */
  readonly transcript?: LoopTranscript;
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
  let input: LoopInputItem[] = [...options.input];
  const recorder = options.recorder ?? null;
  // Serialised once: the same bytes are sent and counted, so the estimate cannot
  // drift from the request it is budgeting.
  const toolSchemas = options.tools.schemas();

  /**
   * Write one execution record, without letting the write end the turn.
   *
   * A full disk or a deleted conversation must degrade what recovery can say,
   * not stop the reply the person is watching.
   */
  const record = async (write: () => Promise<void>): Promise<void> => {
    try {
      await write();
    } catch (error) {
      log.warn('agent.execution_log_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  let reply = '';
  let thinkingStartedAt: number | null = null;
  let thinkingClosed = false;
  let reasoningChars = 0;
  let toolCount = 0;
  let toolChars = 0;
  let lastUsage: ModelUsage | undefined;
  /**
   * The provider ended a step without its completion event.
   *
   * Sticky for the turn: once any step is incomplete, the reply as a whole is
   * not something the model finished, even if a later step returns cleanly.
   */
  let streamIncomplete = false;
  /**
   * The attempt currently in flight, so the catch path can close it. A resolved
   * attempt is cleared after `completeStep`; an unresolved one on error becomes
   * failed/incomplete rather than being silently forgotten.
   */
  const attemptRef: {
    current: { step: number; attemptId: string } | null;
    completed: boolean;
  } = { current: null, completed: false };

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

      // Budget the request that is about to be sent, not the history that was
      // budgeted before the turn started.
      let requestInput: readonly LoopInputItem[] = input;
      let requestTokens: number | null = null;
      if (options.contextBudget) {
        const fit = fitContext({
          instructions: options.instructions,
          tools: toolSchemas,
          items: input,
          budget: options.contextBudget,
          ...(options.media ? { media: options.media } : {}),
        });
        requestInput = fit.items;
        requestTokens = fit.tokens;
        if (fit.compressedResults > 0 || fit.droppedItems > 0) {
          log.warn('agent.context_trimmed', {
            step,
            tokens: fit.tokens,
            available_tokens: fit.availableTokens,
            compressed_results: fit.compressedResults,
            dropped_items: fit.droppedItems,
          });
        }
        if (fit.exhausted) {
          // Sending it anyway would fail at the provider after the person has
          // waited; ending here keeps the partial work and says why.
          const note =
            `[上下文预算不足，无法再发一次模型请求（${fit.reason ?? '估算超出窗口'}）。` +
            '请把任务拆小，或减少一次读取的内容。]';
          const text = reply.trim().length > 0 ? `${reply}\n\n${note}` : note;
          yield {
            type: 'completed',
            text,
            finishReason: 'budget_exhausted',
            steps: step - 1,
            ...(requestTokens !== null ? { contextTokens: requestTokens } : {}),
          };
          return;
        }
      }

      /**
       * Persist the exact request first. If this fails, the model is not
       * called: a request the transcript cannot account for is not a request
       * this product sends.
       */
      let attempt: LoopTranscriptPreparation | null = null;
      let capturedProjection: RequestProjection | undefined;
      if (options.transcript) {
        try {
          attempt = await options.transcript.prepareStep({
            step,
            attemptNo: 1,
            input,
            requestInput,
            instructions: options.instructions,
            tools: toolSchemas,
            ...(options.media ? { media: options.media } : {}),
            estimatedTokens: requestTokens,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log.error('agent.model_transcript_unavailable', { step, error: message });
          yield {
            type: 'error',
            message: `模型轨迹无法保存，本次请求没有发送（MODEL_TRANSCRIPT_UNAVAILABLE）。${message}`,
            retryable: false,
            finishReason: 'failed',
            code: 'MODEL_TRANSCRIPT_UNAVAILABLE',
          };
          return;
        }
        attemptRef.current = { step, attemptId: attempt.attemptId };
        attemptRef.completed = false;
        if (attempt.replacementInput) {
          input = [...attempt.replacementInput];
          requestInput = input;
        }
      }

      const output: LoopOutputItem[] = [];
      let sawTextDelta = false;
      let done = false;
      let responseId: string | undefined;
      /** The text this step produced, which is the unit recovery can trust. */
      let stepText = '';

      for await (const event of options.modelTurn({
        instructions: options.instructions,
        input: requestInput,
        tools: toolSchemas,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.media ? { media: options.media } : {}),
        capture: (projection) => {
          capturedProjection = projection;
        },
      })) {
        if (event.type === 'text_delta') {
          const closed = closeThinking();
          if (closed) yield closed;
          sawTextDelta = true;
          stepText += event.text;
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

        if (event.type === 'incomplete') streamIncomplete = true;
        output.push(...event.output);
        if (event.usage) lastUsage = event.usage;
        responseId = event.responseId;
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
          stepText += message;
          reply += message;
          yield { type: 'text_delta', text: message };
        }
      }

      // Written before the calls it announces, in the same order the model
      // produced them. This is the row that answers "what did it want?" when no
      // result row exists.
      if (recorder && stepText.trim().length > 0) {
        await record(() => recorder.assistantText(step, stepText));
      }

      /**
       * Persist the step's output before any tool runs and before the next
       * request. `incomplete` is sticky for the turn; the step status records
       * what the provider actually delivered.
       */
      if (options.transcript && attempt) {
        try {
          await options.transcript.completeStep({
            step,
            attemptNo: 1,
            attemptId: attempt.attemptId,
            inputItemIds: attempt.inputItemIds,
            output,
            ...(lastUsage ? { usage: lastUsage } : {}),
            ...(responseId ? { responseId } : {}),
            ...(capturedProjection ? { projection: capturedProjection } : {}),
            status: streamIncomplete ? 'incomplete' : 'completed',
            finishReason: streamIncomplete ? 'incomplete_stream' : 'completed',
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log.error('agent.model_transcript_write_failed', { step, error: message });
          yield {
            type: 'error',
            message: `模型输出无法写入可回放轨迹，已停止后续步骤（MODEL_TRANSCRIPT_UNAVAILABLE）。${message}`,
            retryable: false,
            finishReason: 'failed',
            code: 'MODEL_TRANSCRIPT_UNAVAILABLE',
          };
          return;
        }
        attemptRef.completed = true;
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
        yield {
          type: 'completed',
          text: reply,
          finishReason: streamIncomplete ? 'incomplete_stream' : 'completed',
          steps: step,
          ...(requestTokens !== null ? { contextTokens: requestTokens } : {}),
          ...(lastUsage ? { usage: lastUsage } : {}),
        };
        return;
      }

      toolCount += calls.length;
      yield* executeCalls(calls, step);
    }

    // Cap reached. Everything the model did is still a valid partial turn, so
    // this is a notice and a completion, not an error: the person can say
    // "continue" and the next turn starts from what is already on screen.
    const note =
      `[达到 ${maxSteps} 步工具调用上限，还没有给出最终回答。` +
      `说"继续"可以让我接着做。]`;
    const text = reply.trim().length > 0 ? `${reply}\n\n${note}` : note;
    yield { type: 'loop_exhausted', steps: maxSteps };
    yield {
      type: 'completed',
      text,
      finishReason: streamIncomplete ? 'incomplete_stream' : 'loop_exhausted',
      steps: maxSteps,
      ...(lastUsage ? { usage: lastUsage } : {}),
    };
  } catch (error) {
    const closed = closeThinking();
    if (closed) yield closed;

    const message = error instanceof Error ? error.message : String(error);
    const aborted = options.signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
    if (options.transcript && attemptRef.current && !attemptRef.completed) {
      await options.transcript
        .failStep({
          step: attemptRef.current.step,
          attemptId: attemptRef.current.attemptId,
          status: aborted ? 'incomplete' : 'failed',
          error: message,
        })
        .catch(() => undefined);
    }
    log.error('agent.turn_failed', {
      duration_ms: Date.now() - startedAt,
      error: message,
      aborted,
    });
    yield {
      type: 'error',
      message: aborted ? 'cancelled' : message,
      retryable: !aborted,
      finishReason: 'failed',
      ...(error instanceof ModelTranscriptUnavailableError || message.includes('MODEL_TRANSCRIPT_UNAVAILABLE')
        ? { code: 'MODEL_TRANSCRIPT_UNAVAILABLE' }
        : {}),
    };
  }

  /**
   * Persist a tool result before the next model request.
   *
   * The output here is the bounded result the model actually received, not the
   * 2000-character audit slice. If this write fails, the turn stops with a
   * typed error: the tool has already run, so silently continuing would leave a
   * replayable gap and may cause a later step to act on an unrecorded result.
   */
  async function recordTranscriptToolResult(
    step: number,
    item: Extract<LoopInputItem, { type: 'function_call_result' }>,
    invocation: Invocation,
  ): Promise<void> {
    if (!options.transcript) return;
    try {
      await options.transcript.recordToolResult({
        step,
        item,
        ok: invocation.result.ok,
        ...(invocation.result.meta ? { meta: invocation.result.meta } : {}),
      });
    } catch (error) {
      throw new ModelTranscriptUnavailableError(
        `tool result could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
    step: number,
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
        // Recorded before the event is emitted, so a client that saw a call can
        // never be looking at a call the log does not know about.
        if (recorder) {
          await record(() =>
            recorder.toolCallRequested({
              callId: plan.call.callId,
              name: plan.call.name,
              arguments: plan.call.arguments,
              summary: plan.summary,
            }),
          );
        }
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
          const resultItem = {
            type: 'function_call_result' as const,
            callId: plan.call.callId,
            name: plan.call.name,
            output: renderToolResult(invocation.result),
          };
          input.push(resultItem);
          await recordInvocation(plan, invocation);
          await recordTranscriptToolResult(step, resultItem, invocation);
          yield toolResultEvent(plan, invocation);
        }
        continue;
      }

      const plan = plans[0] as CallPlan;
      const invocation = await invoke(plan);
      const resultItem = {
        type: 'function_call_result' as const,
        callId: plan.call.callId,
        name: plan.call.name,
        output: renderToolResult(invocation.result),
      };
      input.push(resultItem);
      await recordInvocation(plan, invocation);
      await recordTranscriptToolResult(step, resultItem, invocation);
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

    const sandboxed =
      options.toolContext.executor != null || options.toolContext.sandboxed === true;
    const denial = policyDenial(plan.definition, options.toolContext.policy, sandboxed);
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
        toolCallId: plan.call.callId,
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

  /**
   * Persist one call's outcome, with the sandbox execution id when there is one.
   *
   * The id is the join key recovery uses: it lets the session row be reconciled
   * against the sandbox's own execution record instead of guessing.
   */
  async function recordInvocation(plan: CallPlan, invocation: Invocation): Promise<void> {
    if (!recorder) return;
    const { result } = invocation;
    const executionId =
      typeof result.meta?.executionId === 'string' ? result.meta.executionId : undefined;
    await record(() =>
      recorder.toolResult({
        callId: plan.call.callId,
        name: plan.call.name,
        ok: result.ok,
        status: result.ok ? 'succeeded' : 'failed',
        ...(executionId ? { executionId } : {}),
        output: result.output,
        outputChars: result.output.length,
        ...(result.ok ? {} : { summary: summarizeToolResult(plan.call.name, result) }),
      }),
    );
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
      // The trace is not the place to parse prose for an approval id; the tool
      // that was refused already recorded the two ids in `meta`.
      ...(result.meta?.approval ? { approval: result.meta.approval } : {}),
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
