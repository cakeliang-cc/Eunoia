/**
 * The retention sweep (spec §44).
 *
 * What is worth testing here is not that a delete deletes. It is the two
 * conditions that decide *which* rows a delete reaches, because both fail
 * silently in the direction that matters:
 *
 *   - too wide, and it removes someone who was never the sweep's to remove;
 *   - too narrow, and it reports `deleted: 0` forever while the rows pile up,
 *     which is indistinguishable from a database that was already clean — the
 *     exact shape of the bug this module was written to close.
 *
 * So these are boundary tests: marked versus unmarked, old versus recent. The
 * ageing is done by moving the *cutoff* rather than the user, so nothing waits
 * a day and no clock is faked.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import {
  EVALUATION_USER_PREFIX,
  RETENTION_WINDOW_HOURS,
  sweepEvaluationUsers,
} from '../../src/privacy/retention.ts';

let store: InMemoryStore;

beforeEach(() => {
  store = new InMemoryStore();
});

const HOUR = 3600 * 1000;

/** A moment far enough ahead that a window starting from it is long elapsed. */
const wellPastTheWindow = (): Date => new Date(Date.now() + 365 * 24 * HOUR);

let counter = 0;
/** A distinct, well-formed user id per call — `users.id` is a uuid everywhere. */
function nextId(): string {
  counter += 1;
  return `0192f0aa-0000-7000-8000-${String(counter).padStart(12, '0')}`;
}

/** Seed a user marked the way an evaluation run marks one. */
async function anEvaluationUser(caseId = 'case-01'): Promise<string> {
  const id = nextId();
  await store.ensureUser(id, `${EVALUATION_USER_PREFIX}run:${caseId}`);
  return id;
}

describe('the sweep', () => {
  it('deletes an evaluation user that is past the window', async () => {
    await anEvaluationUser();

    const result = await sweepEvaluationUsers(store, { now: wellPastTheWindow() });

    expect(result).toMatchObject({ scanned: 1, deleted: 1, dryRun: false });
    expect(await store.listUsersByExternalPrefix(EVALUATION_USER_PREFIX)).toEqual([]);
  });

  it('leaves a user inside the window alone', async () => {
    // The race guard. A run that is still going must not have its users pulled
    // out from under it by a sweep that started a second earlier.
    await anEvaluationUser();

    const result = await sweepEvaluationUsers(store);

    expect(result).toMatchObject({ scanned: 0, deleted: 0 });
    expect(await store.listUsersByExternalPrefix(EVALUATION_USER_PREFIX)).toHaveLength(1);
  });

  it('honours an explicit window rather than the default', async () => {
    // The knob the run's own cleanup would have used had it swept by prefix,
    // and the reason it does not: nothing here is precise enough to be safe
    // next to a run that has not finished.
    await anEvaluationUser();

    const result = await sweepEvaluationUsers(store, {
      olderThan: new Date(Date.now() - RETENTION_WINDOW_HOURS * HOUR),
    });

    expect(result.deleted).toBe(0);
  });

  it('never touches a user who was not handed an external identity', async () => {
    // The property that makes this safe to run without a confirmation prompt.
    // A real person has no `external_id` — the column is written by nothing but
    // the evaluation runner — so the set a sweep can reach is exactly the set
    // that was never a person. If that stops being true, this is the test that
    // should have gone red first.
    const person = nextId();
    await store.ensureUser(person);

    const result = await sweepEvaluationUsers(store, { now: wellPastTheWindow() });

    expect(result.scanned).toBe(0);
    expect(await store.deleteUser(person), 'the person was already gone').toBe(true);
  });

  it('does not reach a user marked with a different namespace', async () => {
    // `evalx:` is one character from the real prefix and is exactly the value a
    // sloppy `LIKE` widens to match. `starts_with` does not.
    const other = nextId();
    await store.ensureUser(other, 'evalx:run:case-04');

    const result = await sweepEvaluationUsers(store, { now: wellPastTheWindow() });

    expect(result.deleted).toBe(0);
    expect(await store.listUsersByExternalPrefix('evalx:')).toHaveLength(1);
  });

  it('counts what it would delete without deleting it in a dry run', async () => {
    await anEvaluationUser();

    const result = await sweepEvaluationUsers(store, {
      dryRun: true,
      now: wellPastTheWindow(),
    });

    expect(result).toMatchObject({ scanned: 1, deleted: 0, dryRun: true });
    // Still there. A dry run that deleted would be the worst of both.
    expect(await store.listUsersByExternalPrefix(EVALUATION_USER_PREFIX)).toHaveLength(1);
  });

  it('is idempotent — a second sweep finds nothing', async () => {
    await anEvaluationUser();
    const later = wellPastTheWindow();

    expect((await sweepEvaluationUsers(store, { now: later })).deleted).toBe(1);
    expect((await sweepEvaluationUsers(store, { now: later })).deleted).toBe(0);
  });

  it('takes only the marked users when marked and unmarked are mixed', async () => {
    // The realistic database: a developer's own account next to a pile of
    // evaluation leftovers. Getting this backwards is unrecoverable.
    const mine = nextId();
    const theirs = nextId();
    await store.ensureUser(mine);
    await anEvaluationUser();
    await store.ensureUser(theirs);

    const result = await sweepEvaluationUsers(store, { now: wellPastTheWindow() });

    expect(result.deleted).toBe(1);
    expect(await store.deleteUser(mine), 'the sweep took an unmarked user').toBe(true);
    expect(await store.deleteUser(theirs), 'the sweep took an unmarked user').toBe(true);
  });

  it('reports counts even when there is nothing to do', async () => {
    // `0 deleted` and `the sweep never ran` look identical from outside, which
    // is why the result is a pair of numbers rather than a boolean.
    expect(await sweepEvaluationUsers(store)).toEqual({ scanned: 0, deleted: 0, dryRun: false });
  });
});

describe('deleting a person', () => {
  it('takes their memories, conversations and messages with them', async () => {
    const id = await anEvaluationUser('case-11');
    const conversation = await store.ensureConversation(id);
    await store.appendMessage({
      conversationId: conversation.id,
      userId: id,
      role: 'user',
      content: '在吗',
    });
    await store.createMemory(id, {
      type: 'semantic',
      content: '用户养了一只猫',
      source: 'user_stated',
    });
    await store.setPreference(id, 'tone.directness', 0.8);

    expect(await store.deleteUser(id)).toBe(true);

    expect(await store.listMemories(id)).toEqual([]);
    expect(await store.listConversations(id)).toEqual([]);
    expect(await store.listMessages(id, conversation.id)).toEqual([]);
    expect(await store.listPreferences(id)).toEqual({});
  });

  it('leaves another person untouched', async () => {
    const alice = nextId();
    const bob = nextId();
    await store.ensureUser(alice);
    await store.ensureUser(bob);
    await store.createMemory(bob, { type: 'semantic', content: '鲍勃的私事', source: 'user_stated' });

    await store.deleteUser(alice);

    expect(await store.listMemories(bob)).toHaveLength(1);
  });

  it('reports false for someone who was never there', async () => {
    expect(await store.deleteUser(nextId())).toBe(false);
  });

  it('does not let a later ensureUser resurrect a deleted person\'s memories', async () => {
    const id = await anEvaluationUser('case-12');
    await store.createMemory(id, { type: 'semantic', content: '会被删掉的事', source: 'user_stated' });
    await store.deleteUser(id);

    // Same uuid, fresh row — the shape a stale cookie produces. The memory must
    // not come back with it.
    await store.ensureUser(id);
    expect(await store.listMemories(id)).toEqual([]);
  });
});
