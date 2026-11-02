/**
 * The permission request and human-approval state machines.
 *
 * Like `src/sandbox/state.ts`, this module has no I/O: the transition tables are
 * values so a store can enforce them with a compare-and-set and a test can prove
 * that `PENDING` cannot become `APPROVED` without a decision.
 *
 * The rule ADR 020 §13.3 cares about most is encoded here: there is no edge from
 * `PENDING` to `APPROVED` that a recovery sweep may take. Only
 * `approveRequest()` produces it, and only for an authenticated human.
 */

import type {
  HumanApprovalStatus,
  PermissionRequestStatus,
} from './types.ts';

const REQUEST_TRANSITIONS: Readonly<
  Record<PermissionRequestStatus, readonly PermissionRequestStatus[]>
> = {
  CREATED: ['EVALUATING', 'DENIED', 'CANCELLED', 'EXPIRED'],
  EVALUATING: ['PENDING', 'APPROVED', 'DENIED', 'CANCELLED', 'EXPIRED'],
  PENDING: ['APPROVED', 'DENIED', 'EXPIRED', 'CANCELLED'],
  APPROVED: ['GRANT_CREATED', 'DENIED', 'CANCELLED', 'EXPIRED'],
  GRANT_CREATED: ['REVALIDATING', 'DENIED', 'CANCELLED', 'EXPIRED'],
  REVALIDATING: ['EXECUTING', 'DENIED', 'CANCELLED', 'EXPIRED'],
  EXECUTING: [],
  DENIED: [],
  EXPIRED: [],
  CANCELLED: [],
};

const APPROVAL_TRANSITIONS: Readonly<
  Record<HumanApprovalStatus, readonly HumanApprovalStatus[]>
> = {
  PENDING: ['APPROVED', 'DENIED', 'EXPIRED', 'CANCELLED'],
  APPROVED: [],
  DENIED: [],
  EXPIRED: [],
  CANCELLED: [],
};

export function canTransitionPermissionRequest(
  from: PermissionRequestStatus,
  to: PermissionRequestStatus,
): boolean {
  return REQUEST_TRANSITIONS[from].includes(to);
}

export function assertPermissionRequestTransition(
  from: PermissionRequestStatus,
  to: PermissionRequestStatus,
): void {
  if (!canTransitionPermissionRequest(from, to)) {
    throw new Error(`invalid permission request transition ${from} -> ${to}`);
  }
}

export function canDecideHumanApproval(from: HumanApprovalStatus): boolean {
  return APPROVAL_TRANSITIONS[from].includes('APPROVED');
}

export function isTerminalPermissionRequest(status: PermissionRequestStatus): boolean {
  return status === 'EXECUTING' || status === 'DENIED' || status === 'EXPIRED' || status === 'CANCELLED';
}

export function isPendingPermissionRequest(status: PermissionRequestStatus): boolean {
  return status === 'CREATED' || status === 'EVALUATING' || status === 'PENDING' ||
    status === 'APPROVED' || status === 'GRANT_CREATED' || status === 'REVALIDATING';
}

export const REQUEST_STATES_REQUIRING_SWEEP: readonly PermissionRequestStatus[] = [
  'CREATED',
  'EVALUATING',
  'PENDING',
  'APPROVED',
  'GRANT_CREATED',
  'REVALIDATING',
];
