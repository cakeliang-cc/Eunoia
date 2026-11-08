/**
 * The model transcript: what the model actually saw, in order.
 *
 * Chat messages answer "what does the conversation say" for the UI, search and
 * export. A model transcript answers a different question: "what was submitted
 * to the model, in what order, with which background state and tool results".
 * The two are joined by ids (messageId, requestId, callId) rather than merged,
 * because a UI bubble is a summary of a turn and a model transcript is not.
 *
 * The vocabulary here is deliberately small:
 *
 *   - an **epoch** is a replay interval with one frozen prompt, tool set,
 *     provider/model and encoding revision. Ordinary turns append items inside
 *     the epoch; compaction, a model switch, a prompt/tool change or an explicit
 *     recovery boundary starts a new epoch.
 *   - an **item** is one immutable piece of model input or output. Items are
 *     referenced by id from a window, never copied per turn.
 *   - a **step** is one request attempt inside an epoch. It stores the ordered
 *     input item ids, the output item ids and the provider's usage.
 *   - **context state** is the comparison baseline for application-produced
 *     background blocks. It says which version of a block the active window has
 *     already incorporated, and whether the block was explicitly cleared.
 *
 * Replay never executes a tool. Recovery of tool side effects remains ADR 028's
 * job; this module stores the facts a model request needs and nothing more.
 */

import { createHash } from 'node:crypto';
import type { ModelMessageContent, UserContentV1 } from '../agent/content.ts';
import type { LoopInputItem, LoopOutputItem, ModelUsage } from '../agent/model-port.ts';
import type { ToolSchema } from '../tools/types.ts';

export const MODEL_TRANSCRIPT_VERSION = 'model-transcript-v1';
export const TRANSCRIPT_RENDER_VERSION = 'runtime-block-v1';

/** Server-side switch. A client can never choose durable per request. */
export type TranscriptMode = 'legacy' | 'durable';

/**
 * The server-side replay mode.
 *
 * Deliberate rollout decision (ADR 032): the code default stays `legacy` so an
 * existing installation can upgrade its database without changing replay
 * semantics in the same restart. This installation enables `durable` in `.env`
 * after the offline contract suite and the real-route smoke passed. `legacy`
 * remains a one-variable rollback; it is never a per-request option.
 */
export function transcriptMode(env: NodeJS.ProcessEnv = process.env): TranscriptMode {
  const raw = env.MODEL_TRANSCRIPT_MODE?.trim().toLowerCase();
  if (!raw || raw === 'legacy') return 'legacy';
  if (raw === 'durable') return 'durable';
  throw new Error('MODEL_TRANSCRIPT_MODE must be "legacy" or "durable"');
}

export type EpochReason =
  | 'new-conversation'
  | 'legacy-seed'
  | 'compaction'
  | 'regenerate'
  | 'model-switch'
  | 'prompt-change'
  | 'tools-change'
  | 'budget-trim'
  | 'stop-resume'
  | 'recovery-boundary'
  | 'safety-replaced';

/** A frozen replay interval. The active one is selected by `active`. */
export interface ModelEpoch {
  readonly id: string;
  readonly userId: string;
  readonly conversationId: string;
  readonly parentEpochId: string | null;
  readonly reason: EpochReason;
  /** The exact prompt document this epoch was created with. */
  readonly instructions: string;
  readonly promptVersion: string;
  /** Full tool declarations, not just a hash: an audit can reproduce the wire. */
  readonly tools: readonly ToolSchema[];
  readonly toolsHash: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly protocolRevision: string;
  readonly encoderRevision: string;
  /** Ordered item ids of the active window. Immutable items, explicit view. */
  readonly windowItemIds: readonly string[];
  readonly windowRevision: number;
  /** Highest message seq represented by an item when the epoch started. */
  readonly seededThroughSeq: number;
  readonly createdAt: Date;
  readonly endedAt: Date | null;
}

export type ModelItemKind =
  | 'user'
  | 'assistant'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'background'
  | 'summary'
  | 'interrupt';

/**
 * Who supplied the content. UI text cannot claim `application`; the server
 * decides this when it writes the item.
 */
export type ModelItemSource = 'user' | 'assistant' | 'tool' | 'application' | 'system';

/** How long the item stays applicable. */
export type ModelItemScope = 'conversation' | 'turn' | 'stage';

export type ModelItemStatus = 'complete' | 'incomplete' | 'unknown';

export type TranscriptPayload =
  | {
      readonly type: 'message';
      readonly role: 'user' | 'assistant' | 'system';
      readonly content: ModelMessageContent;
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
      readonly id?: string;
      readonly raw?: unknown;
    }
  | {
      readonly type: 'background';
      readonly key: string;
      readonly scope: 'persistent' | 'turn' | 'stage';
      readonly text: string;
      readonly revision: number;
      readonly cleared: boolean;
      readonly requestId?: string;
    }
  | { readonly type: 'summary'; readonly text: string }
  | {
      readonly type: 'interrupt';
      readonly text: string;
      readonly reason: 'stopped' | 'crashed' | 'unpaired-tool';
      readonly callId?: string;
    };

/** One immutable replay item. */
export interface ModelItem {
  readonly id: string;
  readonly conversationId: string;
  readonly epochId: string;
  /** Global order within the conversation, assigned by the store. */
  readonly seq: number;
  readonly requestId: string | null;
  readonly turnId: string | null;
  readonly step: number | null;
  readonly kind: ModelItemKind;
  readonly source: ModelItemSource;
  readonly scope: ModelItemScope;
  readonly contentVersion: string;
  readonly payload: TranscriptPayload;
  readonly contentHash: string;
  readonly messageId: string | null;
  readonly callId: string | null;
  readonly status: ModelItemStatus;
  readonly createdAt: Date;
}

export interface NewModelItem {
  /** Pre-allocated id, so a window can reference an item before it is inserted. */
  readonly id?: string;
  readonly conversationId: string;
  readonly epochId: string;
  /** Stable uniqueness key. A retry with the same key must not append twice. */
  readonly idempotencyKey: string;
  readonly requestId?: string | null;
  readonly turnId?: string | null;
  readonly step?: number | null;
  readonly kind: ModelItemKind;
  readonly source: ModelItemSource;
  readonly scope: ModelItemScope;
  readonly contentVersion?: string;
  readonly payload: TranscriptPayload;
  readonly contentHash?: string;
  readonly messageId?: string | null;
  readonly callId?: string | null;
  readonly status?: ModelItemStatus;
}

export type StepStatus =
  | 'prepared'
  | 'sending'
  | 'completed'
  | 'incomplete'
  | 'failed'
  | 'unknown';

/** Per-request usage. Unknown is null, never zero. */
export interface StepUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly cachedTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly responseModel: string | null;
  readonly imageTokensUnknown: boolean;
}

/** A canonical projection of the encoded request, minus credentials and ids. */
export interface RequestProjection {
  readonly instructionsHash: string;
  readonly toolsHash: string;
  readonly modelId: string;
  readonly providerId: string;
  readonly encoderRevision: string;
  /** Ordered, content-addressed message/tool/reasoning entries. */
  readonly entries: readonly {
    readonly type: string;
    readonly role?: string;
    readonly hash: string;
    readonly chars: number;
  }[];
  readonly imageDigests: readonly string[];
  readonly mediaPolicyRevision: string | null;
  readonly textChars: number;
  readonly estimatedTokens: number | null;
}

/** One request attempt. */
export interface ModelStepRecord {
  readonly attemptId: string;
  readonly requestId: string;
  readonly turnId: string;
  readonly conversationId: string;
  readonly step: number;
  readonly attemptNo: number;
  readonly epochId: string;
  readonly epochRevision: number;
  readonly inputItemIds: readonly string[];
  readonly outputItemIds: readonly string[];
  readonly requestConfigDigest: string;
  readonly projection: RequestProjection | null;
  readonly status: StepStatus;
  readonly responseId: string | null;
  readonly usage: StepUsage | null;
  readonly error: string | null;
  readonly finishReason: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

/** The baseline an active window has already incorporated. */
export interface ModelContextState {
  readonly conversationId: string;
  readonly epochId: string;
  readonly key: string;
  readonly scope: 'persistent' | 'turn' | 'stage';
  readonly contentHash: string;
  readonly renderVersion: string;
  readonly revision: number;
  readonly latestItemId: string;
  readonly cleared: boolean;
  readonly updatedAt: Date;
}

export interface NewModelContextState {
  readonly conversationId: string;
  readonly epochId: string;
  readonly key: string;
  readonly scope: 'persistent' | 'turn' | 'stage';
  readonly contentHash: string;
  readonly renderVersion?: string;
  readonly revision: number;
  readonly latestItemId: string;
  readonly cleared: boolean;
}

/** Aggregated usage for one turn, never presented as a complete bill. */
export interface TurnUsageSummary {
  readonly lastRequestUsage: StepUsage | null;
  readonly turnUsage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly cachedTokens: number;
    readonly cacheWriteTokens: number;
    readonly measuredSteps: number;
    readonly totalSteps: number;
    readonly incomplete: boolean;
    /** Unknown or cache-missing steps, so a caller can say what is missing. */
    readonly missingUsageSteps: number;
    readonly missingCacheSteps: number;
  };
  readonly contextTokens: number | null;
}

// ------------------------------------------------------------------- hashing ---

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Deterministic JSON: object keys sorted, arrays keep order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) sorted[key] = sortValue(record[key]);
  return sorted;
}

export function toolsDigest(tools: readonly ToolSchema[]): string {
  return sha256(canonicalJson(tools));
}

export function itemContentHash(payload: TranscriptPayload): string {
  return sha256(canonicalJson({ version: MODEL_TRANSCRIPT_VERSION, payload }));
}

export function payloadForOutput(item: LoopOutputItem): {
  kind: ModelItemKind;
  source: ModelItemSource;
  payload: TranscriptPayload;
} {
  switch (item.type) {
    case 'message':
      return {
        kind: 'assistant',
        source: 'assistant',
        payload: { type: 'message', role: 'assistant', content: item.content },
      };
    case 'function_call':
      return {
        kind: 'tool_call',
        source: 'assistant',
        payload: {
          type: 'function_call',
          callId: item.callId,
          name: item.name,
          arguments: item.arguments,
        },
      };
    case 'reasoning':
      return {
        kind: 'reasoning',
        source: 'assistant',
        payload: {
          type: 'reasoning',
          text: item.text,
          ...(item.id ? { id: item.id } : {}),
          ...(item.raw !== undefined ? { raw: item.raw } : {}),
        },
      };
  }
}

/** Convert a persisted item back to the loop's wire-neutral input item. */
export function itemToLoopInput(item: ModelItem): LoopInputItem | null {
  const payload = item.payload;
  switch (payload.type) {
    case 'message':
      return {
        type: 'message',
        role: payload.role,
        content: payload.content,
        source: payload.role === 'user' ? 'conversation' : 'conversation',
        ...(item.turnId ? { turnId: item.turnId } : {}),
      };
    case 'background':
      // Background is server-authored data. It is replayed in the wire role the
      // adapter chooses; the identity survives here as a user message whose
      // content is the rendered block (DSH's ordering, with a source marker).
      return {
        type: 'message',
        role: 'user',
        content: payload.text,
        source: 'background',
        ...(item.turnId ? { turnId: item.turnId } : {}),
      };
    case 'summary':
      return { type: 'message', role: 'system', content: payload.text };
    case 'function_call':
      return {
        type: 'function_call',
        callId: payload.callId,
        name: payload.name,
        arguments: payload.arguments,
      };
    case 'function_call_result':
      return {
        type: 'function_call_result',
        callId: payload.callId,
        name: payload.name,
        output: payload.output,
      };
    case 'reasoning':
      return {
        type: 'reasoning',
        text: payload.text,
        ...(payload.id ? { id: payload.id } : {}),
        ...(payload.raw !== undefined ? { raw: payload.raw } : {}),
      };
    case 'interrupt':
      return {
        type: 'message',
        role: 'system',
        content: payload.text,
      };
  }
}

/** The content a user item carries, for media planning. */
export function userContentOf(item: ModelItem): UserContentV1 | null {
  if (item.kind !== 'user' || item.payload.type !== 'message') return null;
  if (item.payload.role !== 'user') return null;
  if (typeof item.payload.content === 'string') {
    return { version: 1, parts: [{ type: 'text', text: item.payload.content }] };
  }
  return { version: 1, parts: item.payload.content };
}

// -------------------------------------------------------------------- usage ---

export function stepUsageOf(
  usage: ModelUsage | undefined,
  options: { readonly imageTokensUnknown?: boolean } = {},
): StepUsage | null {
  if (!usage || usage.reported === false) return null;
  const cacheReported = usage.cacheReported !== false;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    cachedTokens: cacheReported ? usage.cachedTokens : null,
    cacheWriteTokens: usage.cacheWriteTokens ?? null,
    responseModel: usage.responseModel ?? null,
    imageTokensUnknown: options.imageTokensUnknown ?? false,
  };
}

/**
 * Aggregate per-step usage without inventing numbers.
 *
 * A sum over known values is useful; it is not a certificate that the turn is
 * completely measured. `measuredSteps`, `totalSteps` and `incomplete` say which
 * one the caller is looking at, and missing cache detail is counted separately
 * from missing whole-request usage.
 */
export function summarizeTurnUsage(
  steps: readonly ModelStepRecord[],
  contextTokens: number | null,
): TurnUsageSummary {
  let input = 0;
  let output = 0;
  let total = 0;
  let cached = 0;
  let cacheWrite = 0;
  let measured = 0;
  let missingUsage = 0;
  let missingCache = 0;
  let lastRequestUsage: StepUsage | null = null;

  const ordered = [...steps].sort((a, b) => a.step - b.step || a.attemptNo - b.attemptNo);
  for (const step of ordered) {
    const usage = step.usage;
    if (!usage) {
      missingUsage += 1;
      continue;
    }
    measured += 1;
    input += usage.inputTokens ?? 0;
    output += usage.outputTokens ?? 0;
    total += usage.totalTokens ?? 0;
    if (usage.cachedTokens === null) missingCache += 1;
    else cached += usage.cachedTokens;
    cacheWrite += usage.cacheWriteTokens ?? 0;
    lastRequestUsage = usage;
  }

  return {
    lastRequestUsage,
    turnUsage: {
      inputTokens: input,
      outputTokens: output,
      totalTokens: total,
      cachedTokens: cached,
      cacheWriteTokens: cacheWrite,
      measuredSteps: measured,
      totalSteps: ordered.length,
      incomplete: measured !== ordered.length,
      missingUsageSteps: missingUsage,
      missingCacheSteps: missingCache,
    },
    contextTokens,
  };
}
