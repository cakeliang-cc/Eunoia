/**
 * Fit one model request into the model's window.
 *
 * `SessionService.prepare()` budgets the *history* before a turn starts. It
 * cannot budget the turn: once the loop runs, the model's own output, its tool
 * calls and their results keep appending. Without a second check at the request
 * boundary, a turn that reads four large files builds a fifth request larger
 * than the window — and the first sign of it is a provider rejection after the
 * person has already watched ten seconds of work.
 *
 * The rules, in the order they are applied:
 *
 *   1. **Reserve first.** Output reservation and safety buffer come off the top,
 *      then the system prompt and the tool schemas — they are not optional, and a
 *      budget that forgets them is a budget that is wrong on every request.
 *   2. **Compress before dropping.** An old tool result is cut to its head with a
 *      marker saying how much was hidden. The call that produced it stays, and so
 *      does its result: a call without a result (or the reverse) is a malformed
 *      request, not a shorter one.
 *   3. **Drop history, never the current turn.** Only items before the last user
 *      message are candidates. Everything from that message on is the work in
 *      progress; if it does not fit after compression, the loop stops with
 *      `budget_exhausted` rather than sending a request the model cannot use.
 *
 * Pairing is the invariant that matters: `groupOf` removes a function call and
 * its result together or not at all. Providers match them by id, and a lone half
 * is worse than a dropped step.
 */

import { estimateTokens, type TokenEstimatorMode } from '../session/tokens.ts';
import type { ToolSchema } from '../tools/types.ts';
import type { LoopInputItem } from './model-port.ts';
import type { PreparedMediaPlan } from './request-plan.ts';

/** Per-item framing cost the estimator cannot see (role tags, tool envelope). */
const ITEM_OVERHEAD_TOKENS = 4;
/**
 * Below this a request cannot carry a useful turn even after trimming.
 *
 * Small on purpose: the decision "does the work in progress fit?" belongs to the
 * trimming pass, and this floor only rejects the absurd case where the prompt and
 * tools leave no room at all.
 */
const MIN_AVAILABLE_TOKENS = 64;
/** Results at or below this size are not worth compressing. */
const COMPRESSION_FLOOR_TOKENS = 300;
/** What a compressed result keeps, in tokens. */
const COMPRESSED_HEAD_TOKENS = 200;

export interface ContextBudget {
  /** The model's hard window, from its profile. */
  readonly windowTokens: number;
  /** Reserved for the model's own output. */
  readonly outputReserveTokens: number;
  /** Headroom so an estimate that is slightly low does not get rejected. */
  readonly safetyBufferTokens: number;
  readonly estimator?: TokenEstimatorMode;
}

export interface FitContextInput {
  readonly instructions: string;
  readonly tools: readonly ToolSchema[];
  readonly items: readonly LoopInputItem[];
  readonly budget: ContextBudget;
  /**
   * The fixed media plan. Image parts are counted by the token estimate their
   * route's policy produced; an image part without a plan entry makes the
   * request unsendable rather than free.
   */
  readonly media?: PreparedMediaPlan;
}

export interface FitContextResult {
  /** The items to send. Unchanged shapes, possibly compressed or shortened. */
  readonly items: readonly LoopInputItem[];
  /** Estimated tokens of the request, system prompt included. */
  readonly tokens: number;
  /** Tokens the items themselves may use. */
  readonly availableTokens: number;
  /** Instructions + tool schemas, which are never trimmed. */
  readonly systemTokens: number;
  /** How many tool results were compressed. */
  readonly compressedResults: number;
  /** How many items were dropped (both halves of a pair count). */
  readonly droppedItems: number;
  /** Image blocks whose planned cost is missing. Must be 0 to send. */
  readonly unplannedImages: number;
  /**
   * True when even the protected work in progress does not fit.
   *
   * The caller must end the turn with `budget_exhausted`; sending the request
   * anyway would fail at the provider with a worse message and no partial reply.
   */
  readonly exhausted: boolean;
  readonly reason?: string;
}

export function fitContext(input: FitContextInput): FitContextResult {
  const mode = input.budget.estimator ?? 'mixed';
  const systemTokens = estimateSystemTokens(input.instructions, input.tools, mode);
  const availableTokens =
    input.budget.windowTokens -
    input.budget.outputReserveTokens -
    input.budget.safetyBufferTokens -
    systemTokens;

  const items: LoopInputItem[] = [...input.items];
  const unplannedImages = countUnplannedImages(items, input.media);
  let total = items.reduce(
    (sum, item) => sum + estimateItemTokens(item, mode, input.media),
    0,
  );

  if (availableTokens < MIN_AVAILABLE_TOKENS) {
    return {
      items,
      tokens: systemTokens + total,
      availableTokens: Math.max(0, availableTokens),
      systemTokens,
      compressedResults: 0,
      droppedItems: 0,
      unplannedImages,
      exhausted: true,
      reason: `the prompt and tools alone need ${systemTokens} tokens`,
    };
  }
  if (unplannedImages > 0) {
    return {
      items,
      tokens: systemTokens + total,
      availableTokens: Math.max(0, availableTokens),
      systemTokens,
      compressedResults: 0,
      droppedItems: 0,
      unplannedImages,
      exhausted: true,
      reason: `${unplannedImages} image block(s) have no planned token cost`,
    };
  }

  let compressedResults = 0;
  if (total > availableTokens) {
    const resultIndices = items
      .map((item, index) => ({ item, index }))
      .filter(
        (entry): entry is { item: Extract<LoopInputItem, { type: 'function_call_result' }>; index: number } =>
          entry.item.type === 'function_call_result',
      )
      // Oldest first; the newest result is what the model was just handed.
      .slice(0, -1);

    for (const { item, index } of resultIndices) {
      if (total <= availableTokens) break;
      const cost = estimateItemTokens(item, mode);
      if (cost <= COMPRESSION_FLOOR_TOKENS) continue;
      const compressed = compressResult(item, mode);
      const nextCost = estimateItemTokens(compressed, mode);
      if (nextCost >= cost) continue;
      items[index] = compressed;
      total -= cost - nextCost;
      compressedResults += 1;
    }
  }

  let droppedItems = 0;
  const removed = new Set<number>();
  if (total > availableTokens) {
    const protectedFrom = lastUserIndex(items);
    let cursor = 0;
    while (total > availableTokens && cursor < protectedFrom) {
      if (removed.has(cursor)) {
        cursor += 1;
        continue;
      }
      const group = droppableGroup(items, cursor, protectedFrom, removed);
      if (!group) {
        cursor += 1;
        continue;
      }
      for (const index of group) {
        removed.add(index);
        total -= estimateItemTokens(items[index] as LoopInputItem, mode);
      }
      droppedItems += group.length;
      cursor = Math.max(...group) + 1;
    }
  }

  const exhausted = total > availableTokens;
  // The accounting above works on indices; the request is what is left.
  const kept = removed.size > 0 ? items.filter((_item, index) => !removed.has(index)) : items;
  return {
    items: kept,
    tokens: systemTokens + total,
    availableTokens,
    systemTokens,
    compressedResults,
    droppedItems,
    unplannedImages,
    exhausted,
    ...(exhausted
      ? {
          reason: `the turn needs about ${systemTokens + total} tokens but only ${input.budget.windowTokens - input.budget.outputReserveTokens - input.budget.safetyBufferTokens} are available`,
        }
      : {}),
  };
}

/** The fixed cost of a request: instructions plus the tool declarations. */
export function estimateSystemTokens(
  instructions: string,
  tools: readonly ToolSchema[],
  mode: TokenEstimatorMode = 'mixed',
): number {
  let total = estimateTokens(instructions, mode);
  for (const tool of tools) {
    total += estimateTokens(tool.name, mode);
    total += estimateTokens(tool.description, mode);
    total += estimateTokens(JSON.stringify(tool.parameters), mode);
    total += 16;
  }
  return total;
}

export function estimateItemTokens(
  item: LoopInputItem,
  mode: TokenEstimatorMode = 'mixed',
  media?: PreparedMediaPlan,
): number {
  switch (item.type) {
    case 'message': {
      if (typeof item.content === 'string') {
        return estimateTokens(item.content, mode) + ITEM_OVERHEAD_TOKENS;
      }
      let total = ITEM_OVERHEAD_TOKENS;
      for (const part of item.content) {
        if (part.type === 'text') {
          total += estimateTokens(part.text, mode);
        } else {
          // Counted per occurrence, never once per storage row: the same image
          // sent twice is two visual inputs.
          total += media?.images.get(part.assetId)?.estimatedTokens ?? 0;
        }
      }
      return total;
    }
    case 'function_call':
      return estimateTokens(item.name, mode) + estimateTokens(item.arguments, mode) + ITEM_OVERHEAD_TOKENS;
    case 'function_call_result':
      return (
        estimateTokens(item.output, mode) +
        ITEM_OVERHEAD_TOKENS +
        (item.images ?? []).reduce(
          (sum, image) => sum + (media?.images.get(image.assetId)?.estimatedTokens ?? 0),
          0,
        )
      );
    case 'reasoning':
      return estimateTokens(item.text, mode) + ITEM_OVERHEAD_TOKENS;
  }
}

/**
 * Cut an old result to its head, keeping a note of how much was hidden.
 *
 * Head rather than middle: a read result starts with the part that identifies
 * it (a path, a listing, the first lines of a file), and that is what makes the
 * compressed row still recognisable in the transcript.
 */
function compressResult(
  item: Extract<LoopInputItem, { type: 'function_call_result' }>,
  mode: TokenEstimatorMode,
): LoopInputItem {
  const chars = item.output.length;
  const head = sliceToTokens(item.output, COMPRESSED_HEAD_TOKENS, mode);
  const marker = `\n[较早的工具输出已压缩：原文 ${chars} 字符，这里保留开头 ${head.length} 字符]`;
  return { ...item, output: `${head}${marker}` };
}

function sliceToTokens(text: string, maxTokens: number, mode: TokenEstimatorMode): string {
  if (estimateTokens(text, mode) <= maxTokens) return text;
  // Reuse the estimator's own weighting by growing the slice until it stops
  // growing; text is bounded by a tool's own output cap, so this is cheap.
  let end = Math.min(text.length, maxTokens * 4);
  while (end > 0 && estimateTokens(text.slice(0, end), mode) > maxTokens) {
    end = Math.floor(end * 0.9);
  }
  return text.slice(0, Math.max(0, end));
}

/** Image blocks that the plan did not price, which must block the request. */
function countUnplannedImages(
  items: readonly LoopInputItem[],
  media: PreparedMediaPlan | undefined,
): number {
  let unplanned = 0;
  for (const item of items) {
    if (item.type !== 'message' || typeof item.content === 'string') continue;
    for (const part of item.content) {
      if (part.type === 'image' && !media?.images.has(part.assetId)) unplanned += 1;
    }
  }
  return unplanned;
}

/**
 * The index of the current turn's user message; everything after it is protected.
 *
 * Identity, not wire role: a persisted background update may be encoded as a
 * user message (it is a better cache tail than a system message on some routes)
 * and it must not move the protected boundary past the real request.
 */
function lastUserIndex(items: readonly LoopInputItem[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type === 'message' && item.role === 'user' && item.source !== 'background') {
      return index;
    }
  }
  // No user message at all (a bare continuation request): protect the tail.
  return Math.max(0, items.length - 2);
}

/**
 * The indices that must be removed together for one old step.
 *
 * A function call and its result are one unit: providers match them by `callId`,
 * and half a pair is a malformed request. Returns null when the item cannot be
 * dropped on its own — a lone result is never the entry point, the call is.
 */
function droppableGroup(
  items: readonly LoopInputItem[],
  index: number,
  protectedFrom: number,
  removed: ReadonlySet<number>,
): number[] | null {
  const item = items[index];
  if (!item) return null;
  if (index >= protectedFrom) return null;

  if (item.type === 'function_call') {
    const resultIndex = items.findIndex(
      (candidate, candidateIndex) =>
        candidateIndex > index &&
        candidateIndex < protectedFrom &&
        !removed.has(candidateIndex) &&
        candidate.type === 'function_call_result' &&
        candidate.callId === item.callId,
    );
    // A call without its result is already malformed; removing only the call
    // would make it worse, so it is left for the exhausted path to report.
    return resultIndex === -1 ? null : [index, resultIndex];
  }

  if (item.type === 'function_call_result') {
    // Always handled from its call's side, so pairing is decided once.
    return null;
  }

  return [index];
}
