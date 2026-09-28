/**
 * Narrative continuity: the themes a person is living through (spec §43).
 *
 * ## Why this is a block rather than a retrieval result
 *
 * `narrative` is already a memory type and already carries the label 你正在经历
 * 的. What was missing is that nothing could *deliver* one. A theme is, by its
 * nature, lexically distant from any single sentence about it: someone writes
 * "最近老是梦见小时候住的那个院子" and the theme they are living through is
 * "纠结要不要离开现在的城市、回老家". Those two strings share no terms, so the
 * similarity gate drops the memory before the model ever sees it. Measured, not
 * assumed:
 *
 *     missing: candidates 1, selected 0, dropped {below_min_similarity: 1}
 *
 * The gate is right to drop it — that is what the gate is for, and ADR 007 says
 * so. The conclusion is not that the gate is wrong but that *this* content does
 * not belong behind it.
 *
 * ## The measurement that built this
 *
 * `narrative-01` was written for exactly this case, and run five times before
 * this module existed:
 *
 *   - once at `1e0d7fcd97a2`, where the model called `search_memory` and connected
 *     the dream to 老家 on its own;
 *   - four times at `372297600bf1`, where it did not call the tool once, and
 *     every reply treated the dream as a thing to explore in the present tense.
 *
 * Those four replies are good replies. They are simply not narrative continuity,
 * which is the dimension the spec names. An earlier version of this decision
 * deferred the block on the strength of the single success; the four failures are
 * what reversed it, and [ADR 012](../../docs/adr/012-relationship-and-narrative.md)
 * records both the deferral and the reversal.
 *
 * ## Bounded, and not by similarity
 *
 * Selection is by **importance and recency**, with no query term at all. There is
 * no similarity to gate on — that is the whole point — so the budget has to do
 * the work instead: a small number of the most important themes, and a hard
 * character cap. A person accumulates narratives over months, and a prompt that
 * carried all of them would be a diary read aloud every turn.
 */

import type { Memory } from './types.ts';
import { HALF_LIFE_DAYS, recencyFactor } from './retrieval.ts';

export interface NarrativeBudget {
  readonly maxItems: number;
  readonly maxChars: number;
}

/**
 * Three themes, 400 characters.
 *
 * Deliberately much tighter than `AUTO_INJECT_BUDGET` (four items, 900 chars),
 * because this block is unconditional: retrieved memory is gated by relevance and
 * still costs nothing most turns, while these lines are sent on every single one.
 * A theme that is not in the top three is not worth a permanent tax on every
 * reply.
 */
export const NARRATIVE_BUDGET: NarrativeBudget = {
  maxItems: 3,
  maxChars: 400,
};

/**
 * The themes worth carrying, most worth carrying first.
 *
 * `active` only. An `unconfirmed` narrative is the model's own guess about
 * someone's life, and stating a guess about what a person is going through as
 * though it were their story is the failure mode the source labels exist to
 * prevent — the block that says "你正在经历的" cannot also be the block that says
 * "maybe".
 */
export function selectNarratives(
  memories: readonly Memory[],
  options: { readonly now?: Date; readonly budget?: Partial<NarrativeBudget> } = {},
): readonly Memory[] {
  const budget = { ...NARRATIVE_BUDGET, ...options.budget };
  const now = options.now ?? new Date();

  const ranked = memories
    .filter((memory) => memory.type === 'narrative' && memory.status === 'active')
    .map((memory) => {
      const ageDays = (now.getTime() - memory.updatedAt.getTime()) / 86_400_000;
      return {
        memory,
        // Importance carries a theme; recency keeps it current. There is no
        // similarity term here and there cannot be one, so these two are the
        // whole ranking.
        rank: memory.importance * recencyFactor(ageDays, HALF_LIFE_DAYS.narrative),
      };
    })
    .sort((a, b) => b.rank - a.rank);

  const chosen: Memory[] = [];
  let used = 0;

  for (const entry of ranked) {
    if (chosen.length >= budget.maxItems) break;
    // The rendered line carries a provenance prefix, so the budget is charged
    // for the line rather than for the content alone.
    const cost = entry.memory.content.length + 24;
    if (used + cost > budget.maxChars) continue;
    chosen.push(entry.memory);
    used += cost;
  }

  return chosen;
}

/**
 * The block appended to the system prompt, or `''` when there is nothing.
 *
 * The rules mirror the relationship block's, for the same reason: this is
 * background the model should think *from*, not material it should read out. The
 * one addition is the failure the four measured replies actually had — treating a
 * theme as though it had never come up before — which is what the last bullet is
 * for.
 */
export function renderNarratives(narratives: readonly Memory[]): string {
  if (narratives.length === 0) return '';

  return [
    '这是 ta 正在经历、还没有结束的事：',
    ...narratives.map((memory) => `- ${memory.content}`),
    '',
    '所以：这些是背景，不是话题。不要罗列它们，不要说"根据我的记录"，也不要为了显得了解而硬提。',
    '但如果这一轮说的东西其实和其中某一条是同一件事——哪怕 ta 换了完全不同的说法——那要接得上，别当成第一次听说。',
  ].join('\n');
}
