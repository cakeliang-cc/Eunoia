/**
 * Build a checkpoint's work evidence from the persisted turn trace.
 *
 * The session layer must not learn how a turn store queries rows, and the turn
 * store must not learn what a checkpoint is. This adapter is the join: it reads
 * the trace through `TurnStore` and hands the pure `buildWorkLedger` function
 * the events. `buildWorkLedger` stays in the session layer because its output is
 * part of the checkpoint contract.
 *
 * A source that cannot read the trace is not a reason to fail compaction. The
 * caller treats a thrown collection as "no evidence" (see `SessionService`), and
 * the checkpoint falls back to the narrative rather than skipping the boundary:
 * losing context is worse than losing the appendix.
 */

import { buildWorkLedger, type CheckpointEvidenceSource, type WorkLedger } from '../session/checkpoint.ts';
import type { TurnStore } from '../session/turn-store.ts';

export type { CheckpointEvidenceSource, WorkLedger };

export interface TurnEvidenceSourceOptions {
  /**
   * Event cap for one compaction.
   *
   * The newest events win. A cap is not a correctness bound — the appendix is
   * capped separately — it keeps a very long conversation from reading every row
   * it ever wrote on every compaction.
   */
  readonly limit?: number;
}

export function createTurnEvidenceSource(
  store: Pick<TurnStore, 'listConversationTurnEvents'>,
  options: TurnEvidenceSourceOptions = {},
): CheckpointEvidenceSource {
  const limit = options.limit ?? 4_000;
  return {
    async collect(conversationId, collectOptions = {}) {
      const events = await store.listConversationTurnEvents(conversationId, {
        ...(collectOptions.before ? { before: collectOptions.before } : {}),
        limit,
      });
      return buildWorkLedger(events);
    },
  };
}
