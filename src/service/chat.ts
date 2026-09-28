/**
 * One conversational turn, end to end.
 *
 * This is the orchestrator: it is the only place that knows the order in which
 * memory is retrieved, risk is assessed, the model is run, the reply is checked,
 * and everything is persisted. Both the HTTP layer and the evaluation runner go
 * through it, so an evaluation measures the product rather than a parallel
 * code path that resembles it.
 *
 * ## Crisis turns are not streamed
 *
 * For a high-risk message the reply is buffered and checked *before* a single
 * delta reaches the client; for everything else it streams as it is generated.
 * That is a deliberate loss of streaming, and the reason is the only one that
 * matters here: if the reply fails the safety check, deltas have already been
 * rendered on the person's screen, and replacing the message afterwards does not
 * un-show it. A crisis reply is three to five sentences, so the delay is not
 * perceptible, and correctness wins.
 *
 * ## Failure is contained
 *
 * Persisting a reply must never be able to fail a turn. The person already has
 * their answer on screen; losing it to a database error would turn a working
 * reply into an error message. Every write here is best-effort and logged.
 */

import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '../agent/events.ts';
import {
  createCompanionAgent,
  streamReply,
  type AgentOptions,
  type ConversationTurn,
} from '../agent/infp-agent.ts';
import { createMemoryTools } from '../agent/tools.ts';
import { PROMPT_VERSION } from '../agent/instructions.ts';
import { COMPANION_MODEL } from '../agent/model-client.ts';
import { contentFingerprint, log } from '../observability/logging.ts';
import { buildTurnContext } from './context.ts';
import { applyOutputCheck, safetyDirectiveFor } from '../safety/response.ts';
import { maxRisk } from '../safety/risk.ts';
import { WorkingMemory, seedWorkingMemory } from '../memory/working-memory.ts';
import type { Store } from '../memory/store.ts';

/** How many prior messages are replayed into the model as conversation. */
export const HISTORY_LIMIT = 20;

export type TurnRunner = (
  agent: ReturnType<typeof createCompanionAgent>,
  message: string,
  options: Parameters<typeof streamReply>[2],
) => AsyncIterable<AgentEvent>;

export interface TurnDependencies {
  readonly store: Store;
  readonly working?: WorkingMemory;
  /**
   * Injectable so tests and the evaluation replay mode can drive the whole turn
   * — retrieval, safety, persistence and all — without a model call.
   */
  readonly runner?: TurnRunner;
  readonly now?: () => Date;
}

export interface TurnRequest {
  readonly userId: string;
  readonly conversationId?: string | null;
  readonly message: string;
  readonly signal?: AbortSignal;
  /**
   * Whether to write the user message, the reply and the run row. Evaluation
   * turns set this false: they are not part of anyone's conversation, and
   * letting them into the history would corrupt the thing being measured.
   */
  readonly persist?: boolean;
  /** Force a risk level, for safety tests that need a deterministic path. */
  readonly riskLevel?: 'none' | 'elevated' | 'crisis';
  /**
   * Whether to retrieve memories for this turn. The person can switch this off
   * from the UI; honouring it here means the setting is a promise the system
   * keeps rather than a filter applied to output after the fact.
   */
  readonly retrieve?: boolean;
}

/**
 * Run a turn and stream the reply.
 *
 * Yields `AgentEvent`s in the order a client should act on them: retrieval
 * notice, safety notice if any, tool activity, text, then `completed`.
 */
export async function* runTurn(
  deps: TurnDependencies,
  request: TurnRequest,
): AsyncIterable<AgentEvent> {
  const startedAt = Date.now();
  const runId = randomUUID();
  const persist = request.persist ?? true;
  const runner = deps.runner ?? streamReply;

  const message = request.message?.trim() ?? '';
  if (message.length === 0) {
    yield { type: 'error', message: 'message is empty', retryable: false };
    return;
  }

  // Before anything is written. `conversations.user_id` and every per-user table
  // reference `users`, and the in-memory store enforces none of those keys — so
  // this ordering was invisible offline and a 500 the first time it met
  // Postgres: the conversation was created before its owner existed.
  await deps.store.ensureUser(request.userId);

  const conversation = await deps.store.ensureConversation(request.userId, request.conversationId);
  const conversationId = conversation.id;

  let userMessageId: string | null = null;
  if (persist) {
    const stored = await deps.store.appendMessage({
      conversationId,
      userId: request.userId,
      role: 'user',
      content: message,
    });
    userMessageId = stored.id;
  }

  const working = deps.working ?? new WorkingMemory();
  if (working.context(conversationId).length === 0 && persist) {
    const recent = await deps.store.recentMessages(conversationId, HISTORY_LIMIT);
    // Drop the message just written; it is passed as the current turn, not as
    // history, and including it twice would have the model answer itself.
    seedWorkingMemory(
      working,
      conversationId,
      recent.filter((entry) => entry.id !== userMessageId).slice(0, HISTORY_LIMIT - 1),
    );
  }

  const context = await buildTurnContext(deps.store, request.userId, message, {
    now: deps.now?.() ?? new Date(),
    retrieve: request.retrieve,
  });
  const riskLevel = request.riskLevel ?? context.risk.level;

  if (context.memoryCount > 0) {
    yield {
      type: 'memory_retrieved',
      count: context.memoryCount,
      considered: context.memoryConsidered,
    };
  }
  if (riskLevel !== 'none') {
    yield { type: 'safety_notice', level: riskLevel, replaced: false };
  }

  const history: ConversationTurn[] = working
    .context(conversationId)
    .map((turn) => ({ role: turn.role, content: turn.content }));

  const agentOptions: AgentOptions = {
    tools: createMemoryTools({
      store: deps.store,
      userId: request.userId,
      sourceMessageId: userMessageId,
      now: deps.now?.(),
    }),
    memoryBlock: context.memoryBlock,
    safetyDirective: safetyDirectiveFor(riskLevel),
  };
  const agent = createCompanionAgent(agentOptions);

  const buffer = riskLevel === 'crisis';
  let reply = '';
  let usedTools = false;
  const toolCalls: string[] = [];
  let failed: string | null = null;

  for await (const event of runner(agent, message, {
    signal: request.signal,
    history,
    tools: agentOptions.tools,
  })) {
    if (event.type === 'completed') {
      reply = event.text;
      continue;
    }
    if (event.type === 'error') {
      failed = event.message;
      yield event;
      break;
    }
    if (event.type === 'tool_call') {
      usedTools = true;
      toolCalls.push(event.name);
    }
    // Withholding deltas is the whole point of `buffer`.
    if (buffer && event.type === 'text_delta') continue;
    yield event;
  }

  if (failed !== null) {
    if (persist) {
      await deps.store
        .recordRun({
          id: runId,
          userId: request.userId,
          conversationId,
          model: COMPANION_MODEL,
          promptVersion: PROMPT_VERSION,
          status: 'failed',
          usedTools,
          toolCalls,
          inputFingerprint: contentFingerprint(message),
          outputFingerprint: null,
          riskLevel,
          durationMs: Date.now() - startedAt,
          error: failed,
        })
        .catch((error: unknown) => log.warn('run.record_failed', { error: String(error) }));
    }
    return;
  }

  const outcome = applyOutputCheck(riskLevel, reply);
  if (outcome.violations.length > 0) {
    log.warn('safety.output_violation', {
      level: maxRisk(riskLevel, 'elevated'),
      violations: outcome.violations,
      replaced: outcome.replaced,
    });
  }
  if (outcome.replaced) {
    yield { type: 'safety_notice', level: 'crisis', replaced: true };
  }

  // In buffered mode nothing has been sent yet, so the checked reply goes out as
  // one delta followed by `completed` — the same shape a non-streaming client
  // already handles (see events.ts).
  if (buffer && outcome.reply.length > 0) {
    yield { type: 'text_delta', text: outcome.reply };
  }

  let assistantMessageId: string | null = null;
  if (persist) {
    working.remember(conversationId, { role: 'user', content: message });
    working.remember(conversationId, { role: 'assistant', content: outcome.reply });
    assistantMessageId = await persistTurn(deps.store, {
      runId,
      userId: request.userId,
      conversationId,
      message,
      reply: outcome.reply,
      riskLevel,
      usedTools,
      toolCalls,
      status: outcome.replaced ? 'safety_replaced' : 'completed',
      durationMs: Date.now() - startedAt,
    });
  }

  yield {
    type: 'completed',
    text: outcome.reply,
    conversationId: persist ? conversationId : null,
    messageId: assistantMessageId,
  };
}

/** Returns the stored assistant message id, or null if persistence failed. */
async function persistTurn(
  store: Store,
  turn: {
    runId: string;
    userId: string;
    conversationId: string;
    message: string;
    reply: string;
    riskLevel: 'none' | 'elevated' | 'crisis';
    usedTools: boolean;
    toolCalls: readonly string[];
    status: 'completed' | 'safety_replaced';
    durationMs: number;
  },
): Promise<string | null> {
  try {
    const stored = await store.appendMessage({
      conversationId: turn.conversationId,
      userId: turn.userId,
      role: 'assistant',
      content: turn.reply,
    });
    await store.recordRun({
      id: turn.runId,
      userId: turn.userId,
      conversationId: turn.conversationId,
      model: COMPANION_MODEL,
      promptVersion: PROMPT_VERSION,
      status: turn.status,
      usedTools: turn.usedTools,
      toolCalls: turn.toolCalls,
      inputFingerprint: contentFingerprint(turn.message),
      outputFingerprint: contentFingerprint(turn.reply),
      riskLevel: turn.riskLevel,
      durationMs: turn.durationMs,
      error: null,
    });
    return stored.id;
  } catch (error) {
    // The reply is already on the person's screen. Failing the turn now would
    // take it away over a bookkeeping problem.
    log.error('turn.persist_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Drain a turn into its final text. Used by the evaluation runner and tests. */
export async function collectTurn(
  deps: TurnDependencies,
  request: TurnRequest,
): Promise<{ reply: string; events: AgentEvent[]; riskLevel: 'none' | 'elevated' | 'crisis' }> {
  const events: AgentEvent[] = [];
  let reply = '';
  let riskLevel: 'none' | 'elevated' | 'crisis' = 'none';

  for await (const event of runTurn(deps, { ...request, persist: request.persist ?? false })) {
    events.push(event);
    if (event.type === 'completed') reply = event.text;
    else if (event.type === 'error') reply = '';
    else if (event.type === 'safety_notice') riskLevel = maxRisk(riskLevel, event.level);
  }

  return { reply, events, riskLevel };
}
