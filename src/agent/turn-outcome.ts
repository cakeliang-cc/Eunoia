/**
 * Did the turn succeed? — a question deliberately separate from "how did it end".
 *
 * The reproduction that motivated this: the model streams a few sentences, the
 * connection closes without a completion event, the adapter still reports
 * "done", and the reply is stored as a normal completion. The person keeps the
 * text, which is right; the system calls it finished, which is not.
 *
 * So two verdicts are computed independently:
 *
 *   - **finish reason** — what ended the turn (ADR 029's vocabulary);
 *   - **acceptance** — whether what arrived meets the conditions for success.
 *
 * Keeping them apart is what lets a reply be *kept* and still be *incomplete*,
 * and what lets a turn end abnormally while the part that arrived is accepted.
 * Collapsing them into one boolean is how "the connection closed" became "the
 * task succeeded".
 *
 * The checks are data, not prose: they are persisted with the turn and sent on
 * the `completed` event, so a later evaluation can ask *which* condition failed
 * without re-running the turn.
 */

import type { FinishReason } from '../finish-reason.ts';
import type { AcceptanceCheck } from '../session/turn-types.ts';

export interface TurnOutcomeInput {
  readonly finishReason: FinishReason;
  /** The visible reply, as it was persisted. */
  readonly reply: string;
  /** Tool calls that returned an error. */
  readonly failedTools?: number;
  /**
   * Tool calls that never got a result.
   *
   * The loop pairs every call with a result, so this is 0 on a normal turn; it
   * exists so recovery and an interrupted turn can say the work is unresolved.
   */
  readonly unresolvedTools?: number;
}

export interface TurnOutcome {
  readonly finishReason: FinishReason;
  /** Something was said, whatever the reason. */
  readonly hasOutput: boolean;
  /** The model reached its own end signal. */
  readonly completedNormally: boolean;
  /** Every acceptance condition passed. */
  readonly succeeded: boolean;
  readonly acceptance: readonly AcceptanceCheck[];
}

export function evaluateTurnOutcome(input: TurnOutcomeInput): TurnOutcome {
  const hasOutput = input.reply.trim().length > 0;
  const completedNormally = input.finishReason === 'completed';
  const failedTools = input.failedTools ?? 0;
  const unresolvedTools = input.unresolvedTools ?? 0;

  const acceptance: AcceptanceCheck[] = [
    {
      id: 'finished',
      ok: completedNormally,
      detail: completedNormally ? undefined : `finish reason was ${input.finishReason}`,
    },
    {
      id: 'has_output',
      ok: hasOutput,
      detail: hasOutput ? undefined : 'the model produced no visible reply',
    },
    {
      id: 'tools_ok',
      ok: failedTools === 0,
      detail: failedTools === 0 ? undefined : `${failedTools} tool call(s) returned an error`,
    },
    {
      id: 'tools_resolved',
      ok: unresolvedTools === 0,
      detail: unresolvedTools === 0 ? undefined : `${unresolvedTools} tool call(s) never completed`,
    },
  ];

  return {
    finishReason: input.finishReason,
    hasOutput,
    completedNormally,
    succeeded: acceptance.every((check) => check.ok),
    acceptance,
  };
}
