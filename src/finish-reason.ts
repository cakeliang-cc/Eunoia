/**
 * Why a turn ended.
 *
 * This lives in a top-level module rather than in `session/turn-types.ts`
 * because two peers need it: the session layer (a turn's lifecycle) and the
 * memory layer's run audit (`agent_runs.finish_reason`). Session and memory are
 * deliberately forbidden from importing each other (ADR 003 / boundaries guard),
 * and a type is not a reason to break that rule — nor to duplicate the union and
 * let the wire value drift away from the stored one.
 *
 * The values have distinct jobs:
 *
 *   - `completed` — the model delivered a final answer. The only reason that
 *     means "the turn ran to its intended end".
 *   - `cancelled` — a person stopped it, or the connection went away.
 *   - `incomplete_stream` — the provider's stream ended without its completion
 *     event. Text may exist and is kept, but it is not a finished answer.
 *   - `loop_exhausted` — the step cap stopped the loop.
 *   - `budget_exhausted` — the context budget could not fit another request.
 *   - `failed` — an error ended the turn.
 *   - `crashed` — recovery found the row still running and no process able to
 *     explain what happened. Not a guess: it says nobody observed the end.
 */
export type FinishReason =
  | 'completed'
  | 'cancelled'
  | 'incomplete_stream'
  | 'loop_exhausted'
  | 'budget_exhausted'
  | 'failed'
  | 'crashed';
