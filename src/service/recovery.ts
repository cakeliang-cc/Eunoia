/**
 * Turn recovery: what the process was doing when it died.
 *
 * The sandbox already recovers executions this way (ADR 017 §10.3, `recovery.ts`):
 * an outcome nobody observed stays UNKNOWN. This module is the same rule applied
 * to the conversation layer, because the sandbox knowing a command ran is not the
 * same as the conversation knowing the model asked for it and whether the result
 * reached the model.
 *
 * The scenario it exists for:
 *
 *   model asks to edit a file → the edit succeeds → the process dies before the
 *   final reply is stored.
 *
 * On restart the turn is still `running`. Recovery does four things and nothing
 * else:
 *
 *   1. reconciling each unobserved tool call against the sandbox's own execution
 *      row (status `succeeded` / `failed` / `unknown`);
 *   2. keeping whatever assistant text was already written as an interrupted
 *      message, so "continue" has something to continue from;
 *   3. marking the turn `interrupted` with finish reason `crashed`;
 *   4. recording that acceptance did not pass.
 *
 * What it never does is replay. A retry is a new decision by the model, and a
 * crash handler that re-ran a command would be making that decision with less
 * information than the model had.
 */

import { log } from '../observability/logging.ts';
import type { Store } from '../store.ts';
import type { TurnEventRecord, TurnEventStatus } from '../session/turn-types.ts';

/**
 * A read-only view of the sandbox's execution records.
 *
 * Kept as a narrow function rather than the whole `SandboxStore` so recovery can
 * run with no sandbox configured (`null`) and still be honest: without a record,
 * the answer is UNKNOWN.
 */
export interface ExecutionStatusReader {
  executionStatus(executionId: string): Promise<string | null>;
}

export interface TurnRecoveryDeps {
  readonly store: Store;
  readonly executions?: ExecutionStatusReader | null;
  readonly now?: () => Date;
}

export interface TurnRecoveryReport {
  /** Turns that were still `running` when the process started. */
  readonly checked: number;
  readonly recovered: number;
  /** Tool calls whose outcome could not be observed. */
  readonly unknownExecutions: number;
  readonly details: readonly string[];
}

/**
 * Map a sandbox execution state onto "did the tool call work?".
 *
 * `RETRYABLE` is *not* success and not failure: the sandbox is saying the
 * command may be retried, which is a decision, not an observation of this run.
 * It stays UNKNOWN here for the same reason the sandbox keeps it non-terminal.
 */
const SUCCEEDED_STATES = new Set(['SUCCEEDED']);
const FAILED_STATES = new Set(['FAILED', 'TIMEOUT', 'CANCELLED', 'INTERRUPTED']);

export function toolStatusForExecution(status: string | null): TurnEventStatus {
  if (status === null) return 'unknown';
  if (SUCCEEDED_STATES.has(status)) return 'succeeded';
  if (FAILED_STATES.has(status)) return 'failed';
  return 'unknown';
}

export async function recoverInterruptedTurns(
  deps: TurnRecoveryDeps,
): Promise<TurnRecoveryReport> {
  const now = deps.now ?? (() => new Date());
  const running = await deps.store.listRunningTurns();
  const details: string[] = [];
  let recovered = 0;
  let unknownExecutions = 0;

  for (const turn of running) {
    const events = await deps.store.listTurnEvents(turn.id);
    const resultByCall = new Map<string, TurnEventRecord>();
    for (const event of events) {
      if (event.kind === 'tool_result' && event.callId !== null) {
        resultByCall.set(event.callId, event);
      }
    }

    for (const event of events) {
      if (event.kind !== 'tool_call' || event.callId === null) continue;
      if (event.status !== 'running' && event.status !== 'requested') continue;

      // A result row means the outcome *was* observed; the call row is only
      // stale because the process died before it could be updated. Adopt the
      // recorded result rather than asking the sandbox again.
      const observed = resultByCall.get(event.callId);
      if (observed) {
        await deps.store.settleTurnEvent(turn.id, event.seq, observed.status, {
          reconciled: 'tool_result',
          reconciledAt: now().toISOString(),
        });
        continue;
      }

      const sandboxStatus = await readExecution(deps.executions, event.executionId);
      const status = toolStatusForExecution(sandboxStatus);
      if (status === 'unknown') unknownExecutions += 1;
      await deps.store.settleTurnEvent(turn.id, event.seq, status, {
        reconciled: sandboxStatus ?? 'no-record',
        reconciledAt: now().toISOString(),
      });
      details.push(
        `${turn.id}: call ${event.callId} -> ${status}` +
          (sandboxStatus ? ` (sandbox ${sandboxStatus})` : ' (no sandbox record)'),
      );
    }

    const text = assistantTextOf(events);
    let messageId = turn.messageId;
    if (text.trim().length > 0 && messageId === null) {
      messageId = await findOrStorePartial(deps.store, turn, text);
    }

    await deps.store.finishTurn(turn.id, {
      status: 'interrupted',
      finishReason: 'crashed',
      reply: text,
      messageId,
      accepted: false,
      acceptance: [
        {
          id: 'finished',
          ok: false,
          detail: 'the process ended before the turn reached an outcome',
        },
      ],
    });
    recovered += 1;
    details.push(`${turn.id}: recovered as interrupted (crashed)`);
  }

  if (running.length > 0) {
    log.warn('turn.recovery', {
      checked: running.length,
      recovered,
      unknown_executions: unknownExecutions,
    });
  }

  return { checked: running.length, recovered, unknownExecutions, details };
}

async function readExecution(
  reader: ExecutionStatusReader | null | undefined,
  executionId: string | null,
): Promise<string | null> {
  if (!reader || !executionId) return null;
  try {
    return await reader.executionStatus(executionId);
  } catch (error) {
    log.warn('turn.recovery_execution_lookup_failed', {
      execution_id: executionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * The text the model had already produced, in step order.
 *
 * Steps are the unit because that is what the recorder wrote; concatenating them
 * reconstructs the reply as far as it got, without inventing a boundary between
 * two steps.
 */
function assistantTextOf(events: readonly TurnEventRecord[]): string {
  return events
    .filter((event) => event.kind === 'assistant_text')
    .map((event) => (typeof event.payload.text === 'string' ? event.payload.text : ''))
    .join('');
}

/**
 * Store the partial reply, unless it is already in the transcript.
 *
 * A crash can land after the message insert and before the finish update, which
 * leaves a stored message with no `message_id` on the turn. Comparing against the
 * recent transcript turns that duplicate into an adoption instead of a second
 * copy of the same half-answer.
 */
async function findOrStorePartial(
  store: Store,
  turn: {
    readonly userId: string;
    readonly conversationId: string;
    readonly startedAt: Date;
  },
  text: string,
): Promise<string | null> {
  try {
    const recent = await store.listMessages(turn.userId, turn.conversationId, 20);
    const existing = recent.find(
      (message) =>
        message.role === 'assistant' &&
        message.content === text &&
        message.createdAt.getTime() >= turn.startedAt.getTime(),
    );
    if (existing) return existing.id;

    const message = await store.appendMessage({
      conversationId: turn.conversationId,
      userId: turn.userId,
      role: 'assistant',
      content: text,
      interrupted: true,
    });
    return message.id;
  } catch (error) {
    // The conversation may have been deleted while the turn was running; the
    // turn row would have cascaded, so reaching here means a narrower failure.
    log.warn('turn.recovery_partial_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
