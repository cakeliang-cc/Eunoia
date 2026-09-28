/**
 * Assembling what the model sees for one turn.
 *
 * Two things happen here, and both are decided before a single token is
 * generated:
 *
 *   1. **Memory is retrieved and rendered.** Automatic, not left to the model's
 *      discretion. The alternative — trusting the model to call `search_memory`
 *      when it should — fails silently and invisibly: nothing errors, the reply
 *      just does not know something it should have. Retrieval here is
 *      deterministic, budgeted, and testable without a model call, which is what
 *      makes spec §18's memory requirements into assertions rather than hopes.
 *   2. **Risk is assessed.** A high-risk message changes the instruction set for
 *      the turn (spec §10). Assessing it here rather than after the reply means
 *      the safety directive shapes generation instead of trying to patch it
 *      afterwards.
 *
 * The cost of automatic retrieval is real and stated in `AUTO_INJECT_BUDGET`:
 * four loosely-related memories volunteered every turn would be worse than none.
 * The overlap gate is what keeps that from happening.
 */

import type { MemoryStore } from '../memory/store.ts';
import { AUTO_INJECT_BUDGET, selectMemories } from '../memory/retrieval.ts';
import { renderMemories } from '../memory/render.ts';
import { assessRisk, type RiskAssessment } from '../safety/risk.ts';

export interface TurnContext {
  /** Ready to append to the system prompt. Empty string when nothing matched. */
  readonly memoryBlock: string;
  readonly memoryCount: number;
  /** How many memories existed to choose from — for the "considered N" display. */
  readonly memoryConsidered: number;
  readonly risk: RiskAssessment;
}

export interface BuildContextOptions {
  readonly now?: Date;
  /** Disable retrieval, for turns where it would be noise (evaluation cases). */
  readonly retrieve?: boolean;
}

export async function buildTurnContext(
  store: MemoryStore,
  userId: string,
  message: string,
  options: BuildContextOptions = {},
): Promise<TurnContext> {
  const risk = assessRisk(message);

  if (options.retrieve === false) {
    return { memoryBlock: '', memoryCount: 0, memoryConsidered: 0, risk };
  }

  const candidates = await store.listMemories(userId, { limit: 200 });
  const { selected } = selectMemories(candidates, message, {
    budget: AUTO_INJECT_BUDGET,
    now: options.now,
  });

  if (selected.length > 0) {
    // Access accounting is fire-and-forget: it feeds the Phase 5 memory panel
    // ("recalled 4 times"), not ranking, so a failure here must not cost a turn.
    await store
      .markAccessed(
        userId,
        selected.map((entry) => entry.memory.id),
      )
      .catch(() => undefined);

    await store
      .logMemoryEvent({
        memoryId: null,
        userId,
        action: 'retrieved',
        actor: 'system',
        detail: { count: selected.length, ids: selected.map((entry) => entry.memory.id) },
      })
      .catch(() => undefined);
  }

  return {
    memoryBlock: renderMemories(selected, { maxChars: AUTO_INJECT_BUDGET.maxChars }),
    memoryCount: selected.length,
    memoryConsidered: candidates.length,
    risk,
  };
}
