/**
 * The write policy, tested against spec §18's five memory requirements.
 *
 * Three of the five are here, stated in the test names the spec uses so the
 * mapping is not something a reader has to reconstruct:
 *
 *   1. an explicit preference is remembered
 *   2. an inference below the confidence bar is **not** stored
 *   3. a memory can be updated
 *
 * (The other two — relevant memory retrieved, irrelevant memory not injected —
 * are in `retrieval.test.ts`, where ranking lives.)
 *
 * These run against the in-memory store. That is deliberate: they are assertions
 * about the policy, and requiring Postgres to check them would mean they get
 * skipped on the machine where someone is actually changing the policy.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import {
  DUPLICATE_THRESHOLD,
  MAX_CONTENT_CHARS,
  MIN_CONFIDENCE,
  writeMemory,
} from '../../src/memory/writer.ts';

const USER = 'user-1';

let store: InMemoryStore;

beforeEach(() => {
  store = new InMemoryStore();
});

describe('writeMemory — admission', () => {
  /** §18 requirement 1. */
  it('remembers an explicit preference', async () => {
    const decision = await writeMemory(store, {
      userId: USER,
      type: 'semantic',
      content: '用户不喜欢别人叫他小杨，要叫全名',
      source: 'user_explicit',
      importance: 0.8,
    });

    expect(decision.action).toBe('created');
    expect(decision.memory?.source).toBe('user_explicit');
    expect(decision.memory?.status).toBe('active');
    expect(decision.memory?.confidence).toBe(1);

    const stored = await store.listMemories(USER);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.content).toContain('不喜欢别人叫他小杨');
  });

  /** §18 requirement 2: speculation is not stored. */
  it('rejects a low-confidence inference', async () => {
    const decision = await writeMemory(store, {
      userId: USER,
      type: 'semantic',
      content: '用户可能有回避型依恋',
      source: 'inferred',
      confidence: 0.4,
    });

    expect(decision.action).toBe('rejected');
    expect(decision.reason).toContain('confidence');
    expect(await store.listMemories(USER)).toHaveLength(0);
  });

  it('records the rejection, so "why doesn\'t it remember?" is answerable', async () => {
    await writeMemory(store, {
      userId: USER,
      type: 'semantic',
      content: '用户可能有回避型依恋',
      source: 'inferred',
      confidence: 0.4,
    });

    const rejections = store.events.filter((event) => event.action === 'rejected');
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.actor).toBe('agent');
  });

  it('admits a high-confidence inference, but marks it unconfirmed', async () => {
    const decision = await writeMemory(store, {
      userId: USER,
      type: 'narrative',
      content: '用户正在考虑换一份更有意义的工作',
      source: 'inferred',
      confidence: 0.9,
    });

    expect(decision.action).toBe('created');
    // Admissible, but never presented as settled fact. This is the distinction
    // the whole confidence column exists for.
    expect(decision.memory?.status).toBe('unconfirmed');
  });

  it('admits an inference at exactly the threshold', async () => {
    const decision = await writeMemory(store, {
      userId: USER,
      type: 'narrative',
      content: '用户最近在重新想工作的意义',
      source: 'inferred',
      confidence: MIN_CONFIDENCE.inferred,
    });
    expect(decision.action).toBe('created');
  });

  it('rejects empty content', async () => {
    const decision = await writeMemory(store, {
      userId: USER,
      type: 'semantic',
      content: '   ',
      source: 'user_stated',
    });
    expect(decision.action).toBe('rejected');
  });

  it('rejects content long enough to be a transcript rather than a memory', async () => {
    const decision = await writeMemory(store, {
      userId: USER,
      type: 'episodic',
      content: '很长的一段'.repeat(MAX_CONTENT_CHARS),
      source: 'user_stated',
    });
    expect(decision.action).toBe('rejected');
    expect(decision.reason).toContain(String(MAX_CONTENT_CHARS));
  });

  it('rejects an out-of-range confidence', async () => {
    const decision = await writeMemory(store, {
      userId: USER,
      type: 'semantic',
      content: '随便什么',
      source: 'user_stated',
      confidence: 1.5,
    });
    expect(decision.action).toBe('rejected');
  });

  it('does not second-guess an explicit request', async () => {
    // MIN_CONFIDENCE for user_explicit is 0. A person asking to be remembered
    // should not have to clear a bar.
    const decision = await writeMemory(store, {
      userId: USER,
      type: 'semantic',
      content: '用户要求记住他讨厌香菜',
      source: 'user_explicit',
      confidence: 0,
    });
    expect(decision.action).toBe('created');
  });
});

describe('writeMemory — deduplication', () => {
  it('folds a repeat into the existing memory rather than adding a copy', async () => {
    const first = await writeMemory(store, {
      userId: USER,
      type: 'semantic',
      content: '用户讨厌香菜',
      source: 'user_stated',
      importance: 0.5,
    });
    const second = await writeMemory(store, {
      userId: USER,
      type: 'semantic',
      content: '用户讨厌香菜',
      source: 'user_stated',
      importance: 0.7,
    });

    expect(second.action).toBe('updated');
    expect(second.mergedInto).toBe(first.memory?.id);
    expect(await store.listMemories(USER)).toHaveLength(1);
  });

  it('raises importance and confidence toward the higher value on merge', async () => {
    await writeMemory(store, {
      userId: USER,
      type: 'semantic',
      content: '用户讨厌香菜',
      source: 'user_stated',
      confidence: 0.6,
      importance: 0.4,
    });
    await writeMemory(store, {
      userId: USER,
      type: 'semantic',
      content: '用户讨厌香菜',
      source: 'user_stated',
      confidence: 0.95,
      importance: 0.9,
    });

    const [stored] = await store.listMemories(USER);
    // Hearing the same thing twice should never make us less sure.
    expect(stored?.confidence).toBeCloseTo(0.95, 5);
    expect(stored?.importance).toBeCloseTo(0.9, 5);
  });

  it('promotes an unconfirmed inference once the user states it outright', async () => {
    await writeMemory(store, {
      userId: USER,
      type: 'narrative',
      content: '用户想换工作',
      source: 'inferred',
      confidence: 0.9,
    });
    await writeMemory(store, {
      userId: USER,
      type: 'narrative',
      content: '用户想换工作',
      source: 'user_stated',
    });

    const [stored] = await store.listMemories(USER);
    expect(stored?.status).toBe('active');
    expect(stored?.source).toBe('inferred');
  });

  it('does not merge two memories that are merely related', async () => {
    await writeMemory(store, {
      userId: USER,
      type: 'semantic',
      content: '用户讨厌香菜',
      source: 'user_stated',
    });
    await writeMemory(store, {
      userId: USER,
      type: 'semantic',
      content: '用户喜欢跑步',
      source: 'user_stated',
    });

    // Merging distinct facts loses information the person never agreed to lose.
    // The threshold is set high for that reason.
    expect(DUPLICATE_THRESHOLD).toBeGreaterThan(0.7);
    expect(await store.listMemories(USER)).toHaveLength(2);
  });
});

describe('writeMemory — updating', () => {
  /** §18 requirement 5. */
  it('lets a memory be corrected', async () => {
    const created = await writeMemory(store, {
      userId: USER,
      type: 'semantic',
      content: '用户喜欢跑步，每周跑三次',
      source: 'user_stated',
    });

    const id = created.memory?.id as string;
    const updated = await store.updateMemory(USER, id, {
      content: '用户不跑步了，膝盖受过伤',
      importance: 0.8,
    });

    expect(updated?.content).toBe('用户不跑步了，膝盖受过伤');
    expect(updated?.importance).toBeCloseTo(0.8, 5);
    expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(created.memory!.updatedAt.getTime());
  });

  it('lets a memory be retired', async () => {
    const created = await writeMemory(store, {
      userId: USER,
      type: 'semantic',
      content: '用户喜欢跑步',
      source: 'user_stated',
    });

    await store.deleteMemory(USER, created.memory?.id as string);

    const listed = await store.listMemories(USER, { statuses: ['deleted'] });
    expect(listed).toHaveLength(1);
    // Soft delete: `memory_events` and `superseded_by` both point at this row,
    // and removing it would strand them.
    expect(listed[0]?.status).toBe('deleted');
  });

  it('refuses to update a memory belonging to someone else', async () => {
    const created = await writeMemory(store, {
      userId: USER,
      type: 'semantic',
      content: '用户喜欢跑步',
      source: 'user_stated',
    });

    const updated = await store.updateMemory('someone-else', created.memory?.id as string, {
      content: '被我改了',
    });

    expect(updated).toBeNull();
  });
});
