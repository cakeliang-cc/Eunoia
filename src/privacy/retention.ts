/**
 * Retention (spec §44).
 *
 * The spec names seven things a long-lived companion's memory design has to
 * answer for: purpose, scope, retention, deletion, privacy, sensitivity. Six of
 * them were answered somewhere — in an ADR, in a schema comment, in a rule about
 * what never reaches a log — and `retention` was answered nowhere. The concrete
 * form of that gap was recorded in `CHANGELOG.md`: every evaluation run creates
 * one throwaway user per case, with a conversation, messages and run rows
 * attached, and **nothing in the project could ever remove them**.
 *
 * So this module removes them, and the design is narrow on purpose.
 *
 * ## Only what is marked
 *
 * A sweep deletes users whose `external_id` carries the evaluation namespace.
 * A person who used the product has no `external_id` at all — the column is
 * still unwritten outside evaluation runs — so the set this can reach is exactly
 * the set that was never a person. That property is what makes it safe to run
 * without a confirmation prompt, and it is why the prefix is a constant here
 * rather than a parameter someone passes in a hurry.
 *
 * ## A window, not a schedule
 *
 * There is no scheduler in this project and inventing one for a development
 * database would be the unnecessary framework spec §0 warns about. What there is
 * instead is a margin: users younger than `RETENTION_WINDOW_HOURS` are left
 * alone. That is not a policy about how long data should live — evaluation data
 * has no reason to outlive the run that made it — it is a guard against a sweep
 * racing a run that is still going. A 30-case live run takes minutes; a user a
 * day old belongs to no run that is going to finish.
 *
 * The sweep is therefore idempotent and cheap to run often, and it is paired
 * with the other half in `src/evaluation/cli.ts`: a run cleans up the users it
 * created the moment it is done, which is when it knows exactly which ones they
 * are and needs no window at all. This module is the backstop for the runs that
 * crash before they get there.
 */

import type { Store } from '../store.ts';
import { log } from '../observability/logging.ts';

/** The namespace evaluation runs write into `users.external_id`. */
export const EVALUATION_USER_PREFIX = 'eval:';

/**
 * How old a user must be before a sweep will touch it.
 *
 * Only a race guard, not a data policy — see the module comment.
 */
export const RETENTION_WINDOW_HOURS = 24;

export interface SweepResult {
  /** How many marked users the sweep found inside the window. */
  readonly scanned: number;
  readonly deleted: number;
  /** True when the sweep only reported what it would have done. */
  readonly dryRun: boolean;
}

export interface SweepOptions {
  /** Defaults to the evaluation namespace. Passed only by tests. */
  readonly prefix?: string;
  /** Defaults to `RETENTION_WINDOW_HOURS` before `now`. */
  readonly olderThan?: Date;
  readonly dryRun?: boolean;
  /** Injected so a test can age a user without waiting a day. */
  readonly now?: Date;
  readonly limit?: number;
}

/**
 * Delete every user handed an identity by `prefix` that is past the window.
 *
 * Returns counts rather than a boolean because the number is the point: "0
 * deleted" and "the sweep did not run" look identical from the outside, and
 * that is the shape of failure this project has already been bitten by twice
 * (a check that could not fire, a replay that quietly called the model).
 */
export async function sweepUsers(store: Store, options: SweepOptions = {}): Promise<SweepResult> {
  const prefix = options.prefix ?? EVALUATION_USER_PREFIX;
  const now = options.now ?? new Date();
  const olderThan =
    options.olderThan ?? new Date(now.getTime() - RETENTION_WINDOW_HOURS * 60 * 60 * 1000);
  const dryRun = options.dryRun ?? false;

  const candidates = await store.listUsersByExternalPrefix(prefix, {
    olderThan,
    limit: options.limit,
  });

  let deleted = 0;
  for (const candidate of candidates) {
    if (dryRun) continue;
    if (await store.deleteUser(candidate.id)) deleted += 1;
  }

  // Ids are not logged, only the shape of the work. A `users.id` is the whole
  // identity system (ADR 009), which makes it a credential, and spec §14's rule
  // that logs carry sizes and hashes rather than content applies to it.
  log.info('retention.sweep', {
    prefix,
    scanned: candidates.length,
    deleted,
    dry_run: dryRun,
    older_than: olderThan.toISOString(),
  });

  return { scanned: candidates.length, deleted, dryRun };
}

/** The evaluation namespace's sweep. The only call a caller normally needs. */
export function sweepEvaluationUsers(
  store: Store,
  options: Omit<SweepOptions, 'prefix'> = {},
): Promise<SweepResult> {
  return sweepUsers(store, options);
}
