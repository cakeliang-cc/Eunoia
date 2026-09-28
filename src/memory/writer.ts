/**
 * The write policy (spec §7).
 *
 * The anti-pattern this file exists to prevent is a companion that writes a
 * memory every turn. The prompt asks the model not to; this is what happens when
 * it does anyway.
 *
 * Three rules, in order of how much they matter:
 *
 *   1. **Speculation does not become fact.** An `inferred` memory below a high
 *      confidence threshold is rejected outright. Above it, it is stored as
 *      `unconfirmed` and labelled as a guess wherever it is rendered. The
 *      companion may have a hunch; it may not state the hunch as something it
 *      knows about the person.
 *   2. **Writing the same thing twice is an update.** A near-duplicate refreshes
 *      the existing memory instead of appending a near-copy, so a preference
 *      mentioned five times is one memory that has been confirmed five times,
 *      not five memories competing for the same budget slot.
 *   3. **Every decision is logged**, including rejections. "Why doesn't it
 *      remember this?" is answerable from `memory_events`.
 */

import type { MemoryStore } from './store.ts';
import type { Memory, MemoryDraft, MemorySource, MemoryType } from './types.ts';
import { MEMORY_TYPES } from './types.ts';
import { lexicalSimilarity } from './retrieval.ts';

/**
 * Minimum confidence required to admit a memory, by provenance.
 *
 * `user_explicit` needs none — they asked us to remember it, and second-guessing
 * that is its own kind of failure. `inferred` is set high enough that the model
 * has to be quite sure, because the cost of a wrong "fact" about a person is
 * paid by the person.
 */
export const MIN_CONFIDENCE: Readonly<Record<MemorySource, number>> = {
  user_explicit: 0,
  user_stated: 0.5,
  inferred: 0.85,
};

/**
 * How similar two memories must be before the second is treated as the first.
 *
 * High, because merging two genuinely different memories loses information that
 * the person never agreed to lose. Missing a merge only costs a duplicate.
 */
export const DUPLICATE_THRESHOLD = 0.82;

/** Content longer than this is a transcript, not a memory. */
export const MAX_CONTENT_CHARS = 500;

export type WriteAction = 'created' | 'updated' | 'rejected';

export interface WriteDecision {
  readonly action: WriteAction;
  readonly memory: Memory | null;
  readonly reason: string | null;
  /** True when this was folded into an existing memory rather than added. */
  readonly mergedInto: string | null;
}

export interface WriteRequest extends MemoryDraft {
  readonly userId: string;
}

/**
 * Apply policy, then persist.
 *
 * Returns a decision rather than throwing: a rejected write is a normal outcome
 * that the tool layer reports back to the model, and making it an exception
 * would tempt callers to swallow it.
 */
export async function writeMemory(
  store: MemoryStore,
  request: WriteRequest,
): Promise<WriteDecision> {
  const rejection = validate(request);
  if (rejection) {
    await store.logMemoryEvent({
      memoryId: null,
      userId: request.userId,
      action: 'rejected',
      actor: 'agent',
      reason: rejection,
      detail: { type: request.type, source: request.source },
    });
    return { action: 'rejected', memory: null, reason: rejection, mergedInto: null };
  }

  const content = request.content.trim();
  const confidence = request.confidence ?? defaultConfidence(request.source);
  const existing = await findDuplicate(store, request.userId, content);

  if (existing) {
    // Merging raises confidence toward the higher of the two rather than
    // averaging: hearing the same thing twice should not make us *less* sure,
    // and averaging would punish a memory for having been stored early.
    const merged = await store.updateMemory(request.userId, existing.id, {
      importance: Math.max(existing.importance, request.importance ?? existing.importance),
      confidence: Math.max(existing.confidence, confidence),
      status: existing.status === 'unconfirmed' && request.source !== 'inferred' ? 'active' : existing.status,
    });

    await store.logMemoryEvent({
      memoryId: existing.id,
      userId: request.userId,
      action: 'updated',
      actor: 'agent',
      reason: 'duplicate',
      detail: { similarity: 'above_threshold' },
    });

    return {
      action: 'updated',
      memory: merged ?? existing,
      reason: null,
      mergedInto: existing.id,
    };
  }

  const created = await store.createMemory(request.userId, {
    type: request.type,
    content,
    importance: clamp01(request.importance ?? 0.5),
    confidence: clamp01(confidence),
    source: request.source,
    tags: request.tags ?? [],
    sourceMessageId: request.sourceMessageId ?? null,
    // An inference is stored, but never as settled fact.
    status: request.source === 'inferred' ? 'unconfirmed' : 'active',
  });

  await store.logMemoryEvent({
    memoryId: created.id,
    userId: request.userId,
    action: 'created',
    actor: 'agent',
    detail: { source: request.source, type: request.type },
  });

  return { action: 'created', memory: created, reason: null, mergedInto: null };
}

/**
 * Chinese, because these strings have two readers and neither wants English:
 * the model, which receives them as the tool's `explanation` and has to decide
 * what to do differently, and whoever reads `memory_events.reason` while
 * debugging. The interpolated values stay as they are — they are wire values
 * (`episodic`, `inferred`), not prose.
 *
 * `reason: 'duplicate'` below stays a bare token on purpose: it is a machine
 * key marking a branch, not a sentence explaining one.
 */
function validate(request: WriteRequest): string | null {
  if (!MEMORY_TYPES.includes(request.type as MemoryType)) {
    return `未知的记忆类型：${String(request.type)}`;
  }
  const content = request.content?.trim() ?? '';
  if (content.length === 0) return 'content 是空的';
  if (content.length > MAX_CONTENT_CHARS) {
    return `content 有 ${content.length} 字，超过 ${MAX_CONTENT_CHARS} 字上限`;
  }

  const confidence = request.confidence ?? defaultConfidence(request.source);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return `confidence 必须在 0 到 1 之间，收到的是 ${String(request.confidence)}`;
  }

  const floor = MIN_CONFIDENCE[request.source];
  if (floor === undefined) return `未知的来源：${String(request.source)}`;
  if (confidence < floor) {
    return (
      `source 为 "${request.source}" 时 confidence 至少要 ${floor}，` +
      `收到的是 ${confidence}；如果这只是你的猜测，去问用户，不要存`
    );
  }

  return null;
}

/**
 * `inferred` defaults to exactly its threshold — admissible, but only just, and
 * stored as unconfirmed. The other sources default to a value that does not need
 * defending.
 */
function defaultConfidence(source: MemorySource): number {
  if (source === 'user_explicit') return 1;
  if (source === 'user_stated') return 0.8;
  return MIN_CONFIDENCE.inferred;
}

async function findDuplicate(
  store: MemoryStore,
  userId: string,
  content: string,
): Promise<Memory | null> {
  const candidates = await store.listMemories(userId, { limit: 200 });
  let best: Memory | null = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    if (candidate.status === 'deleted' || candidate.status === 'superseded') continue;
    const similarity = lexicalSimilarity(content, candidate.content);
    if (similarity >= DUPLICATE_THRESHOLD && similarity > bestScore) {
      best = candidate;
      bestScore = similarity;
    }
  }

  return best;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
