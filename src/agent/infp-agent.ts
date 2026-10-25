/**
 * The companion's runtime: instructions, tools and the model port, composed into
 * one run.
 *
 * This module is the boundary between product policy (`src/service/`) and the
 * agent runtime. It deliberately knows nothing about HTTP, persistence, memory
 * retrieval or safety — those are decided before a run starts — and it does not
 * import the vendor SDK except for the provider type. The provider itself is
 * constructed in `model-client.ts`, and only the adapter in `model-turn.ts`
 * touches the SDK's request and stream shapes.
 *
 * ## What changed from the SDK-runner version
 *
 * The loop used to be `run()` from the Agents SDK. It is now `runAgentLoop()`
 * from `loop.ts`: the same model transport, but with per-call policy, parallel
 * reads, a per-turn context ledger, tool arguments and results in the event
 * stream, and a step cap that produces a partial answer instead of dropping it.
 * The reasons are in ADR 014; the provider is still the SDK's.
 */

import type { ModelProvider } from '@openai/agents';
import { COMPANION_MODEL, createProvider } from './model-client.ts';
import { buildRuntimeContext } from './runtime-context.ts';
import { buildInstructions, PROMPT_VERSION } from './instructions.ts';
import { DEFAULT_MAX_STEPS, runAgentLoop } from './loop.ts';
import { createModelTurnResolver } from './model-turn.ts';
import type { LoopInputItem, ModelTurn } from './model-port.ts';
import type { AgentEvent } from './events.ts';
import { ToolRegistry } from '../tools/registry.ts';
import { DEFAULT_TOOL_POLICY } from '../tools/types.ts';
import type { ReadLedger, ToolDefinition, ToolPolicy } from '../tools/types.ts';
import { TurnReadLedger } from '../tools/ledger.ts';
import type { Workspace } from '../tools/workspace.ts';

export const AGENT_NAME = 'INFPCompanion';

export interface ConversationTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/** One message item in the request. Function calls are added by the loop. */
export type RunInputItem = Extract<LoopInputItem, { type: 'message' }>;

export interface CompanionOptions {
  /** Tool definitions available to this run. Empty means none. */
  readonly tools?: readonly ToolDefinition[] | ToolRegistry;
  /** Pin the companion model for this run. */
  readonly model?: string;
  /** Pre-built model turn, for tests and for a composition root that shares one. */
  readonly modelTurn?: ModelTurn;
  /** Provider used when no `modelTurn` is supplied; explicit, not process-global. */
  readonly modelProvider?: ModelProvider;
  readonly policy?: ToolPolicy;
  readonly maxSteps?: number;
  readonly workspace?: Workspace | null;
  readonly ledger?: ReadLedger;
  readonly now?: Date;
}

/** Alias kept for the composition root and evaluation tools. */
export type AgentOptions = CompanionOptions;

/**
 * A run's static configuration.
 *
 * `modelTurn` is optional because tests inject a runner and never resolve a
 * model; `streamReply` resolves it lazily only when the real loop is used.
 */
export interface CompanionRun {
  readonly name: string;
  readonly instructions: string;
  readonly tools: ToolRegistry;
  readonly policy: ToolPolicy;
  readonly maxSteps: number;
  readonly workspace: Workspace | null;
  readonly ledger: ReadLedger;
  readonly model: string;
  readonly modelTurn?: ModelTurn;
  readonly modelProvider?: ModelProvider;
  readonly now: Date;
}

/**
 * Build the companion.
 *
 * The instructions are the stable prompt document and nothing else. Per-turn
 * context — the clock, memory, a safety directive — is appended after the
 * current user message by `buildRunInput`, so a changed memory never invalidates
 * the cached history.
 */
export function createCompanionAgent(options: CompanionOptions = {}): CompanionRun {
  const tools =
    options.tools instanceof ToolRegistry
      ? options.tools
      : new ToolRegistry(options.tools ?? []);

  return {
    name: AGENT_NAME,
    instructions: buildInstructions(),
    tools,
    policy: options.policy ?? DEFAULT_TOOL_POLICY,
    maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
    workspace: options.workspace ?? null,
    ledger: options.ledger ?? new TurnReadLedger(),
    model: options.model ?? COMPANION_MODEL,
    ...(options.modelTurn ? { modelTurn: options.modelTurn } : {}),
    ...(options.modelProvider ? { modelProvider: options.modelProvider } : {}),
    now: options.now ?? new Date(),
  };
}

/**
 * Build the run input.
 *
 * History is passed as explicit message items rather than as an SDK session,
 * because the conversation's canonical copy lives in Postgres and a second
 * in-SDK copy would be a second source of truth about what was said. It also
 * means the exact prompt sent on a turn is reconstructible from our own data,
 * which is what the evaluation runner needs.
 *
 * The per-turn context is appended after the current user message, never before
 * it. That ordering keeps the persisted history as the leading bytes of the next
 * request: the context is new tail, not a changed head.
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

  const items: RunInputItem[] = history.map((turn) => ({
    type: 'message',
    role: turn.role,
    content: turn.content,
  }));

  items.push({ type: 'message', role: 'user', content: message });
  if (trailing) {
    items.push({ type: 'message', role: 'system', content: trailing });
  }
  return items;
}

export interface StreamReplyOptions {
  /** Cancels the run when the client disconnects. */
  readonly signal?: AbortSignal;
  /** Upper bound on model/tool steps, so a loop cannot run away. */
  readonly maxTurns?: number;
  /** Prior turns, oldest first. The new message is appended after these. */
  readonly history?: readonly ConversationTurn[];
  /**
   * Per-turn context sent as a trailing system input item.
   *
   * It deliberately lives after the history: putting it in the system prompt
   * would make every changed memory or clock invalidate the cached history.
   */
  readonly context?: string | null;
  /** Explicit provider, for a composition root that has already built one. */
  readonly modelProvider?: ModelProvider;
}

/** Resolvers are process-wide: the SDK model object is immutable config. */
let cachedResolver: ((modelId: string) => Promise<ModelTurn>) | null = null;

/**
 * Run one turn and yield the reply as a transport-agnostic event stream.
 *
 * A non-streaming caller can ignore `text_delta` events and use the final
 * `completed` event, which carries the whole reply — so no separate
 * non-streaming code path is needed.
 */
export async function* streamReply(
  agent: CompanionRun,
  message: string,
  options: StreamReplyOptions = {},
): AsyncIterable<AgentEvent> {
  const input = buildRunInput(message, options.history, options.context);
  const items: LoopInputItem[] =
    typeof input === 'string' ? [{ type: 'message', role: 'user', content: input }] : input;

  let modelTurn: ModelTurn;
  try {
    modelTurn = agent.modelTurn ?? (await resolveModelTurn(agent, options));
  } catch (error) {
    // A missing credential or an unknown provider id is a turn error, not a
    // transport failure: it has to reach the client as an SSE `error` frame,
    // not as a 500 from the HTTP layer.
    yield {
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
    };
    return;
  }

  yield* runAgentLoop({
    modelTurn,
    instructions: agent.instructions,
    input: items,
    tools: agent.tools,
    toolContext: {
      workspace: agent.workspace,
      policy: agent.policy,
      ledger: agent.ledger,
      now: agent.now,
    },
    maxSteps: options.maxTurns ?? agent.maxSteps,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

async function resolveModelTurn(
  agent: CompanionRun,
  options: StreamReplyOptions,
): Promise<ModelTurn> {
  if (!cachedResolver) {
    cachedResolver = createModelTurnResolver(options.modelProvider ?? agent.modelProvider ?? createProvider());
  }
  return cachedResolver(agent.model);
}

/** The prompt identity recorded with a run. Re-exported for composition roots. */
export { PROMPT_VERSION };

/** Stream-event narrowing, re-exported where it has always been imported. */
export { cacheUsageOf, reasoningChunkOf, textDeltaOf } from './stream-events.ts';
export type { ReasoningChunk } from './stream-events.ts';

/**
 * The exact prompt the model would receive on this turn.
 *
 * Exported for the evaluation runner and for tests that need to assert ordering
 * without calling a model.
 */
export function composePrompt(
  message: string,
  history: readonly ConversationTurn[] = [],
  context?: string | null,
): { instructions: string; input: string | RunInputItem[] } {
  return { instructions: buildInstructions(), input: buildRunInput(message, history, context) };
}

/** Build per-turn context in the shape the run expects. */
export { buildRuntimeContext };
