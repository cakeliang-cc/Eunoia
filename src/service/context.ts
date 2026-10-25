/**
 * Assembling what the model sees for one turn.
 *
 * Five things happen here, and all of them are decided before a single token is
 * generated:
 *
 *   1. **When this turn is happening** is stated: date, weekday, clock, zone.
 *      There is always a now, so this block is never empty and never gated.
 *   2. **How long we have known each other** is derived and stated (spec §25).
 *   3. **The themes they are living through** are carried (spec §43).
 *   4. **Memory is retrieved and rendered.** Automatic, not left to the model's
 *      discretion. The alternative — trusting the model to call `search_memory`
 *      when it should — fails silently and invisibly: nothing errors, the reply
 *      just does not know something it should have. Retrieval here is
 *      deterministic, budgeted, and testable without a model call, which is what
 *      makes spec §18's memory requirements into assertions rather than hopes.
 *   5. **Risk is assessed.** A high-risk message changes the instruction set for
 *      the turn (spec §10). Assessing it here rather than after the reply means
 *      the safety directive shapes generation instead of trying to patch it
 *      afterwards.
 *
 * The clock and the relationship are unconditional. A theme is not
 * relevance-gated either — it is phrased differently every time it comes up,
 * so a similarity gate would drop it on exactly the turns it was written for —
 * but it is switched off with `retrieve: false`, because it is memory. See
 * `src/session/relationship.ts` and `src/memory/narrative.ts`. Retrieval is
 * the step that is gated.
 *
 * The cost of automatic retrieval, by contrast, is real and stated in
 * `AUTO_INJECT_BUDGET`: four loosely-related memories volunteered every turn
 * would be worse than none. The overlap gate is what keeps that from happening.
 */

import type { MemoryStore } from '../memory/store.ts';
import type { SessionStore } from '../session/store.ts';
import { AUTO_INJECT_BUDGET, selectMemories } from '../memory/retrieval.ts';
import { renderMemories } from '../memory/render.ts';
import { renderSituation } from '../agent/situation.ts';
import { describeRelationship, renderRelationship } from '../session/relationship.ts';
import { selectNarratives, renderNarratives } from '../memory/narrative.ts';
import { assessRisk, type RiskAssessment } from '../safety/risk.ts';

export interface TurnContext {
  /**
   * When this turn is happening. Never empty: a turn always has a now.
   *
   * Not relevance-gated, for the same reason as the relationship block. "What
   * day is it" is true of every turn, and a clock that appeared only when the
   * message mentioned time would be absent on "这周末想出去".
   */
  readonly situationBlock: string;
  /** Ready to append to the system prompt. Empty string when nothing matched. */
  readonly memoryBlock: string;
  readonly memoryCount: number;
  /** How many memories existed to choose from — for the "considered N" display. */
  readonly memoryConsidered: number;
  /**
   * How long we have known each other. Empty string on a store that cannot
   * answer, and on a first meeting that is too new to have anything to report.
   *
   * Unlike `memoryBlock` this is *not* relevance-gated, and the asymmetry is the
   * point: "is this the first time we have spoken" is not a question about this
   * turn. It is true of every turn.
   */
  readonly relationshipBlock: string;
  /**
   * The themes this person is living through. Empty when there are none.
   *
   * Also not relevance-gated, and for a reason that is the opposite of the
   * relationship block's: a theme is *always* lexically distant from any single
   * message about it, so the similarity gate would drop it on precisely the
   * turns it was written for. See `src/memory/narrative.ts`.
   *
   * It *is* switched off with `retrieve: false`, unlike the relationship block.
   * These are memories, and that switch is the person's memory switch — a
   * companion that stopped citing facts but kept narrating someone's life back to
   * them would have ignored the request in the way that matters most.
   */
  readonly narrativeBlock: string;
  readonly risk: RiskAssessment;
}

export interface BuildContextOptions {
  readonly now?: Date;
  /**
   * IANA zone for the situation block. Omitted, the process zone is used,
   * which is the person's zone on the single-user machine this runs on.
   */
  readonly timeZone?: string;
  /** Disable retrieval, for turns where it would be noise (evaluation cases). */
  readonly retrieve?: boolean;
}

/**
 * What this assembly needs from storage, stated rather than assumed.
 *
 * Narrower than `Store` on purpose: composing context reads memory and history,
 * and a wider type would let this file start writing. It is wider than
 * `MemoryStore` because relationship state is not a memory — it is a count over
 * conversations, which is a different table and a different question.
 */
export type ContextStore = MemoryStore & Pick<SessionStore, 'historyStats'>;

export async function buildTurnContext(
  store: ContextStore,
  userId: string,
  message: string,
  options: BuildContextOptions = {},
): Promise<TurnContext> {
  const risk = assessRisk(message);
  const relationshipBlock = await relationshipFor(store, userId, options.now);
  const situationBlock = renderSituation({
    ...(options.now ? { now: options.now } : {}),
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  });

  if (options.retrieve === false) {
    return {
      situationBlock,
      memoryBlock: '',
      memoryCount: 0,
      memoryConsidered: 0,
      relationshipBlock,
      narrativeBlock: '',
      risk,
    };
  }

  const candidates = await store.listMemories(userId, { limit: 200 });

  // Chosen before retrieval, and taken *out* of it. A narrative that passes the
  // similarity gate would otherwise be rendered twice — once as a theme and once
  // as a retrieved fragment — and a prompt that says the same thing in two voices
  // reads as two things.
  const narratives = selectNarratives(candidates, { now: options.now });
  const claimed = new Set(narratives.map((memory) => memory.id));
  const narrativeBlock = renderNarratives(narratives);
  const { selected } = selectMemories(
    candidates.filter((memory) => !claimed.has(memory.id)),
    message,
    { budget: AUTO_INJECT_BUDGET, now: options.now },
  );

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
    situationBlock,
    memoryBlock: renderMemories(selected, { maxChars: AUTO_INJECT_BUDGET.maxChars }),
    memoryCount: selected.length,
    memoryConsidered: candidates.length,
    relationshipBlock,
    narrativeBlock,
    risk,
  };
}

/**
 * Relationship state, or nothing.
 *
 * A store that cannot answer loses the block rather than the turn. The same
 * reasoning as the fire-and-forget access accounting in `buildTurnContext`: this
 * is context, and context is the thing a reply can do without. A count query is
 * not worth failing a person's message over.
 */
async function relationshipFor(
  store: ContextStore,
  userId: string,
  now?: Date,
): Promise<string> {
  try {
    const stats = await store.historyStats(userId);
    return renderRelationship(describeRelationship(stats, now ? { now } : {}));
  } catch {
    return '';
  }
}
