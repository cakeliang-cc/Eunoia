/**
 * Memory retrieval: scoring, gating, and the hard context budget (spec §6,
 * ADR 004).
 *
 * Everything here is a pure function over plain values. No store, no clock, no
 * network. That is deliberate: retrieval is the part of a companion most likely
 * to be quietly wrong — injecting too much, injecting the wrong thing, injecting
 * a private memory into an unrelated conversation — and the only way to argue
 * about it is to be able to run it against fixed inputs and see the ranking.
 *
 * ## The score
 *
 *     score = w_s·similarity + w_i·importance + w_r·recency + w_t·typePrior
 *
 * then multiplied by a status factor (1.0 active, 0.85 unconfirmed). The four
 * terms decide relevance; the multiplier is a separate judgement about how much
 * the ranking itself should be trusted, which is why it multiplies rather than
 * joining the sum. This multiplier is an addition to ADR 004's formula, recorded
 * there.
 *
 * `similarity` is injected. Today it is lexical overlap (`lexicalSimilarity`);
 * when an embedding provider exists it becomes cosine similarity over
 * `memories.embedding`, and nothing else in this file changes.
 *
 * ## What the budget is and is not
 *
 * `maxItems` and `maxChars` are hard caps — retrieval can never inject an
 * unbounded amount of the person's history into a single turn, and that property
 * is asserted by test rather than trusted.
 *
 * Relevance is gated by `minSimilarity`, not by `minScore`. The score floor is a
 * sanity gate only: a recent, important memory with no topical connection still
 * scores well on its other three terms, and it *should*, because importance is
 * real. Overlap is a separate question from prominence, so it gets a separate
 * control — and it is only switched on for automatic injection, where nothing
 * downstream can reject a bad match. See `RetrievalBudget.minSimilarity`.
 */

import type { Memory, MemoryType } from './types.ts';

export interface RetrievalWeights {
  readonly similarity: number;
  readonly importance: number;
  readonly recency: number;
  readonly typePrior: number;
}

/**
 * Similarity is weighted highest because a memory that has nothing to do with
 * what was just said is noise no matter how important it once was.
 */
export const DEFAULT_WEIGHTS: RetrievalWeights = {
  similarity: 0.4,
  importance: 0.25,
  recency: 0.2,
  typePrior: 0.15,
};

/**
 * How fast a memory of each type goes stale, in days to half its recency value.
 *
 * Episodic memories are anchored to a moment, so an event from two months ago is
 * genuinely less present than one from yesterday. A fact about who someone is
 * does not decay at that rate — "they are an only child" is as true in a year.
 */
export const HALF_LIFE_DAYS: Readonly<Record<MemoryType, number>> = {
  episodic: 21,
  semantic: 365,
  narrative: 120,
};

/**
 * Prior probability that a memory of this type is the useful one, before looking
 * at the query. Durable facts and ongoing themes are more often the thing worth
 * surfacing than any single past event.
 */
export const TYPE_PRIORS: Readonly<Record<MemoryType, number>> = {
  episodic: 0.6,
  semantic: 1.0,
  narrative: 0.8,
};

/** Trust multiplier applied to the final score by lifecycle status. */
export const STATUS_FACTOR: Readonly<Record<string, number>> = {
  active: 1.0,
  unconfirmed: 0.85,
};

export interface RetrievalBudget {
  readonly maxItems: number;
  readonly maxChars: number;
  readonly minScore: number;
  /**
   * Cap on how many memories of one type may be selected, so a large pile of
   * episodic memories cannot crowd out the durable facts entirely.
   */
  readonly maxPerType: number;
  /**
   * Minimum lexical/semantic overlap required, or `null` for no gate.
   *
   * This is the difference between the two ways retrieval is used, and it is the
   * only term that genuinely separates "relevant" from "irrelevant":
   *
   *   - **Automatic injection** (context built before every turn, no human in
   *     the loop) sets this, because nothing downstream will reject a bad match
   *     — the memory just quietly appears in the prompt.
   *   - **A `search_memory` call** leaves it null, because the model asked, and
   *     the model can judge what came back and ignore it.
   *
   * `minScore` cannot do this job: a recent, important memory with no topical
   * connection at all still scores well on the other three terms, and it should
   * — importance is real. Overlap is a separate question from prominence.
   */
  readonly minSimilarity: number | null;
}

export const DEFAULT_BUDGET: RetrievalBudget = {
  maxItems: 6,
  maxChars: 1600,
  minScore: 0.25,
  maxPerType: 4,
  minSimilarity: null,
};

/**
 * The tighter budget used for automatic injection.
 *
 * Smaller on every axis than a search the model asked for: fewer items, fewer
 * characters, at most two of any one type, and a real overlap gate. A companion
 * that volunteers four loosely-related memories per turn is worse than one that
 * volunteers none.
 */
export const AUTO_INJECT_BUDGET: RetrievalBudget = {
  maxItems: 4,
  maxChars: 900,
  minScore: 0.3,
  maxPerType: 2,
  minSimilarity: 0.06,
};

export type SimilarityFn = (query: string, content: string) => number;

export interface ScoredMemory {
  readonly memory: Memory;
  readonly score: number;
  readonly terms: {
    readonly similarity: number;
    readonly importance: number;
    readonly recency: number;
    readonly typePrior: number;
  };
}

/**
 * Split text into comparable tokens.
 *
 * Chinese is written without spaces, so word splitting does not apply. Character
 * bigrams are the standard cheap answer: they survive word-order changes and
 * give partial credit for shared substrings, which is roughly what a person
 * means by "these are about the same thing". Latin runs are lowercased and split
 * on non-letters.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const normalised = text.toLowerCase();

  for (const word of normalised.match(/[a-z0-9]+/g) ?? []) tokens.push(word);

  const cjkRuns = normalised.match(/[一-鿿]+/g) ?? [];
  for (const run of cjkRuns) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) tokens.push(run.slice(i, i + 2));
  }

  return tokens;
}

/**
 * Overlap coefficient, not Jaccard.
 *
 * A short query matching one clause of a long memory is a real match, and
 * Jaccard divides by the union — so it punishes exactly the case we care about
 * most. Dividing by the smaller set asks instead: "how much of the shorter text
 * is accounted for by the longer one?"
 */
export function lexicalSimilarity(query: string, content: string): number {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return 0;
  const contentTokens = new Set(tokenize(content));
  if (contentTokens.size === 0) return 0;

  let shared = 0;
  for (const token of queryTokens) if (contentTokens.has(token)) shared += 1;
  return shared / Math.min(queryTokens.size, contentTokens.size);
}

/** Exponential decay: 1.0 at age zero, 0.5 at one half-life. */
export function recencyFactor(ageDays: number, halfLifeDays: number): number {
  if (!Number.isFinite(ageDays) || ageDays <= 0) return 1;
  return 0.5 ** (ageDays / halfLifeDays);
}

export interface ScoreOptions {
  readonly now: Date;
  readonly query: string;
  readonly weights?: RetrievalWeights;
  readonly similarity?: SimilarityFn;
}

export function scoreMemory(
  memory: Memory,
  options: ScoreOptions,
): ScoredMemory {
  const weights = options.weights ?? DEFAULT_WEIGHTS;
  const similarityFn = options.similarity ?? lexicalSimilarity;

  const similarity = clamp01(similarityFn(options.query, memory.content));
  const importance = clamp01(memory.importance);

  // Freshness is measured from `updatedAt`, not from `lastAccessedAt`. Scoring
  // access would create a rich-get-richer loop in which the memories already
  // recalled most often become permanently the most recallable, and the set
  // converges on a handful of items. Access counts are still recorded; they are
  // displayed in Phase 5 and are not an input to ranking.
  const ageDays = (options.now.getTime() - memory.updatedAt.getTime()) / 86_400_000;
  const recency = recencyFactor(ageDays, HALF_LIFE_DAYS[memory.type]);
  const typePrior = TYPE_PRIORS[memory.type] ?? 0.5;

  const sum =
    weights.similarity * similarity +
    weights.importance * importance +
    weights.recency * recency +
    weights.typePrior * typePrior;

  const score = sum * (STATUS_FACTOR[memory.status] ?? 1);

  return { memory, score, terms: { similarity, importance, recency, typePrior } };
}

export interface SelectionResult {
  readonly selected: readonly ScoredMemory[];
  /** Everything that was scored, including what did not fit. For tests and logs. */
  readonly ranked: readonly ScoredMemory[];
  readonly droppedReasons: Readonly<Record<string, number>>;
}

/**
 * Rank, gate, and cut to the budget.
 *
 * The budget is enforced on both count and characters. A memory that would push
 * past either cap is skipped rather than truncating the list early, so a short
 * memory can still fill a gap a long one could not.
 */
export function selectMemories(
  memories: readonly Memory[],
  query: string,
  options: {
    readonly now?: Date;
    readonly budget?: Partial<RetrievalBudget>;
    readonly weights?: RetrievalWeights;
    readonly similarity?: SimilarityFn;
  } = {},
): SelectionResult {
  const now = options.now ?? new Date();
  const budget: RetrievalBudget = { ...DEFAULT_BUDGET, ...options.budget };

  const ranked = memories
    .filter((memory) => memory.status !== 'deleted' && memory.status !== 'superseded')
    .map((memory) =>
      scoreMemory(memory, { now, query, weights: options.weights, similarity: options.similarity }),
    )
    .sort((a, b) => b.score - a.score || a.memory.id.localeCompare(b.memory.id));

  const selected: ScoredMemory[] = [];
  const perType: Record<string, number> = {};
  let chars = 0;
  const droppedReasons: Record<string, number> = {};

  const drop = (reason: string): void => {
    droppedReasons[reason] = (droppedReasons[reason] ?? 0) + 1;
  };

  for (const candidate of ranked) {
    const type = candidate.memory.type;

    if (selected.length >= budget.maxItems) {
      drop('budget_items');
      continue;
    }
    if (candidate.score < budget.minScore) {
      drop('below_min_score');
      continue;
    }
    if (budget.minSimilarity !== null && candidate.terms.similarity < budget.minSimilarity) {
      drop('below_min_similarity');
      continue;
    }
    if ((perType[type] ?? 0) >= budget.maxPerType) {
      drop('type_cap');
      continue;
    }
    if (chars + candidate.memory.content.length > budget.maxChars) {
      drop('budget_chars');
      continue;
    }

    selected.push(candidate);
    perType[type] = (perType[type] ?? 0) + 1;
    chars += candidate.memory.content.length;
  }

  return { selected, ranked, droppedReasons };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
