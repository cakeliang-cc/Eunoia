/**
 * The two state machines, in one place and with no I/O.
 *
 * Execution state is persisted before and after every external call, so a crash
 * can always answer "what was happening?" from the database. That only works if
 * the transitions are explicit: an ad-hoc `UPDATE status = ?` somewhere in the
 * Gateway is how `RUNNING` becomes `SUCCEEDED` without an exit code, or how
 * `UNKNOWN` quietly becomes `FAILED`.
 *
 * `UNKNOWN` is not an error state that a retry loop may skip past. It means the
 * external operation's outcome is not known; the only way out is
 * `RECONCILING` (inspect the real world) or a terminal state derived from that
 * inspection. `RETRYABLE` is a reconciliation result, not a licence to replay a
 * non-idempotent command.
 */

import type { ExecutionOutcome, ExecutionState, SandboxStatus } from './types.ts';

const EXECUTION_TRANSITIONS: Readonly<Record<ExecutionState, readonly ExecutionState[]>> = {
  // `FAILED` is reachable before submission: if the runtime cannot be reached,
  // the command provably did not run. After `RUNNING` that is never knowable,
  // which is why `RUNNING` has `UNKNOWN` and not `FAILED` as a guess.
  CREATED: ['AUTHORIZED', 'FAILED', 'CANCELLED'],
  AUTHORIZED: ['SUBMITTED', 'FAILED', 'CANCELLED'],
  SUBMITTED: ['RUNNING', 'FAILED', 'INTERRUPTED', 'UNKNOWN', 'CANCELLED'],
  RUNNING: ['SUCCEEDED', 'FAILED', 'TIMEOUT', 'INTERRUPTED', 'UNKNOWN', 'CANCELLED'],
  // A crash after the command finished but before the result was persisted.
  INTERRUPTED: ['RECONCILING', 'UNKNOWN'],
  RECONCILING: ['SUCCEEDED', 'FAILED', 'TIMEOUT', 'RETRYABLE', 'UNKNOWN'],
  RETRYABLE: ['SUBMITTED', 'CANCELLED'],
  SUCCEEDED: [],
  FAILED: [],
  TIMEOUT: [],
  CANCELLED: [],
  UNKNOWN: ['RECONCILING'],
};

const SANDBOX_TRANSITIONS: Readonly<Record<SandboxStatus, readonly SandboxStatus[]>> = {
  CREATING: ['READY', 'FAILED', 'TERMINATING'],
  READY: ['RUNNING', 'INTERRUPTED', 'RECOVERING', 'EXPIRED', 'TERMINATING', 'DESTROYED'],
  RUNNING: ['READY', 'INTERRUPTED', 'RECOVERING', 'EXPIRED', 'TERMINATING', 'FAILED'],
  INTERRUPTED: ['RECOVERING', 'TERMINATING', 'FAILED', 'DESTROYED'],
  RECOVERING: ['READY', 'FAILED', 'TERMINATING'],
  EXPIRED: ['TERMINATING', 'DESTROYED'],
  TERMINATING: ['DESTROYED', 'FAILED'],
  FAILED: ['RECOVERING', 'TERMINATING', 'DESTROYED'],
  DESTROYED: [],
};

export function canTransitionExecution(from: ExecutionState, to: ExecutionState): boolean {
  return EXECUTION_TRANSITIONS[from].includes(to);
}

export function assertExecutionTransition(from: ExecutionState, to: ExecutionState): void {
  if (!canTransitionExecution(from, to)) {
    throw new Error(`invalid execution transition ${from} -> ${to}`);
  }
}

export function canTransitionSandbox(from: SandboxStatus, to: SandboxStatus): boolean {
  return SANDBOX_TRANSITIONS[from].includes(to);
}

export function assertSandboxTransition(from: SandboxStatus, to: SandboxStatus): void {
  if (!canTransitionSandbox(from, to)) {
    throw new Error(`invalid sandbox transition ${from} -> ${to}`);
  }
}

/** Executions that are not terminal: a crash may have left them unfinished. */
export const UNFINISHED_EXECUTION_STATES: readonly ExecutionState[] = [
  'CREATED',
  'AUTHORIZED',
  'SUBMITTED',
  'RUNNING',
  'INTERRUPTED',
  'UNKNOWN',
  'RECONCILING',
  'RETRYABLE',
];

export const TERMINAL_EXECUTION_STATES: readonly ExecutionState[] = [
  'SUCCEEDED',
  'FAILED',
  'TIMEOUT',
  'CANCELLED',
];

export function isTerminalExecution(status: ExecutionState): boolean {
  return TERMINAL_EXECUTION_STATES.includes(status);
}

/**
 * Collapse internal state to the five model-facing outcomes.
 *
 * An unfinished execution maps to `UNKNOWN`, never to `FAILED`: the command may
 * have completed, may still be running, or may never have started. The honest
 * answer is the one that stops the model from retrying blindly.
 */
export function executionOutcome(status: ExecutionState): ExecutionOutcome {
  switch (status) {
    case 'SUCCEEDED':
      return 'SUCCEEDED';
    case 'FAILED':
      return 'FAILED';
    case 'TIMEOUT':
      return 'TIMEOUT';
    case 'CANCELLED':
      return 'CANCELLED';
    case 'CREATED':
    case 'AUTHORIZED':
    case 'SUBMITTED':
    case 'RUNNING':
    case 'INTERRUPTED':
    case 'UNKNOWN':
    case 'RECONCILING':
    case 'RETRYABLE':
      return 'UNKNOWN';
  }
}

/** Sandboxes that the Controller still owns and must be able to recover. */
export const ACTIVE_SANDBOX_STATES: readonly SandboxStatus[] = [
  'CREATING',
  'READY',
  'RUNNING',
  'INTERRUPTED',
  'RECOVERING',
  'EXPIRED',
];
