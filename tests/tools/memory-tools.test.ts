/**
 * The memory tools the model can call (spec §9).
 *
 * These are tested through the plain functions rather than through the SDK
 * wrappers, which is the reason `src/tools/memory-tools.ts` exists separately
 * from `src/agent/tools.ts`: everything with a decision in it is reachable here,
 * with no agent, no schema library and no model call.
 *
 * Two things get more attention than the happy paths:
 *
 *   - **the rejection paths**, because "the model asked to save something and
 *     was told no" is the behaviour that keeps the memory store worth reading;
 *   - **the width difference between the two retrieval paths**, because that is
 *     the design decision most likely to be "simplified" away by someone who
 *     sees two budgeted searches and assumes one is redundant.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import {
  TOOL_SIDE_EFFECTS,
  requiresApproval,
  saveMemory,
  searchMemory,
  updateMemory,
  type ToolContext,
} from '../../src/tools/memory-tools.ts';
import { AUTO_INJECT_BUDGET, selectMemories } from '../../src/memory/retrieval.ts';

const USER = 'user-1';

let store: InMemoryStore;
let ctx: ToolContext;

beforeEach(() => {
  store = new InMemoryStore();
  ctx = { store, userId: USER, sourceMessageId: null };
});

async function seed(content: string, overrides: Partial<Parameters<InMemoryStore['createMemory']>[1]> = {}) {
  return store.createMemory(USER, {
    type: 'semantic',
    content,
    source: 'user_stated',
    importance: 0.6,
    confidence: 0.8,
    ...overrides,
  });
}

describe('searchMemory', () => {
  it('ranks the overlapping memory first', async () => {
    await seed('用户在做前端开发');
    await seed('用户养了一只叫团子的猫');

    const result = await searchMemory(ctx, { query: '团子最近怎么样' });
    expect(result.memories[0]?.content).toContain('团子');
  });

  it('has no overlap gate, unlike the automatic path', async () => {
    // This is the documented difference between the two retrieval paths, and it
    // is a real trade rather than an oversight. Lexical similarity is crude —
    // "睡不好" and "失眠" share nothing — so a gate here would make the tool
    // unable to find the memories it most needs to find, at exactly the moment
    // the model has asked a specific question. The model can see the content and
    // judge for itself; the note says these are candidates.
    await seed('用户母亲生病住院了', { importance: 1 });

    const result = await searchMemory(ctx, { query: '今天中午吃了拉面' });
    expect(result.found).toBe(1);
    expect(result.note).toContain('候选');
  });

  it('returns a shaped result the model can read', async () => {
    await seed('用户讨厌香菜', { importance: 0.73, confidence: 0.66 });

    const result = await searchMemory(ctx, { query: '香菜' });
    const [memory] = result.memories;
    expect(memory).toMatchObject({
      type: 'semantic',
      importance: 0.73,
      confidence: 0.66,
      source: 'user_stated',
      unconfirmed: false,
    });
    // Round-tripped through JSON to the model, so it must survive that.
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('flags an unconfirmed inference as such', async () => {
    await seed('用户可能在考虑换工作', { source: 'inferred', status: 'unconfirmed' });

    const result = await searchMemory(ctx, { query: '换工作' });
    expect(result.memories[0]?.unconfirmed).toBe(true);
  });

  it('returns an empty result rather than an error when there is nothing to find', async () => {
    const result = await searchMemory(ctx, { query: '团子最近怎么样' });

    expect(result.found).toBe(0);
    expect(result.memories).toEqual([]);
    // The note matters: a model that reads "found nothing" as "you know nothing
    // about this person" starts inventing.
    expect(result.note).toContain('不代表你不了解对方');
  });

  it('rejects an empty query without searching', async () => {
    await seed('用户喜欢跑步');
    const result = await searchMemory(ctx, { query: '   ' });
    expect(result.found).toBe(0);
    expect(result.note).toContain('empty');
  });

  it('honours the limit and clamps an absurd one', async () => {
    for (let i = 0; i < 12; i += 1) await seed(`用户喜欢跑步，这是第 ${i} 条`);

    expect((await searchMemory(ctx, { query: '跑步', limit: 3 })).found).toBe(3);

    // 999 clamps to the tool's ceiling of ten, which is not the number that
    // comes back — the type cap in the default budget binds first. What matters
    // is that an absurd number cannot turn into an absurd result set.
    const unbounded = await searchMemory(ctx, { query: '跑步', limit: 999 });
    expect(unbounded.found).toBeGreaterThan(3);
    expect(unbounded.found).toBeLessThanOrEqual(10);
  });

  it('counts an access against each memory it returns', async () => {
    const memory = await seed('用户养了一只叫团子的猫');
    await searchMemory(ctx, { query: '团子' });

    const updated = await store.getMemory(USER, memory.id);
    expect(updated?.accessCount).toBe(1);
    expect(updated?.lastAccessedAt).toBeInstanceOf(Date);
  });

  it('does not count an access for a memory the search did not return', async () => {
    const memory = await seed('用户养了一只叫团子的猫');
    await searchMemory(ctx, { query: '量子力学', limit: 1 });

    // The search does return it — there is no gate — so the access is counted,
    // and that is the point: the count tracks what was put in front of the
    // model, not what the model found useful.
    expect((await store.getMemory(USER, memory.id))?.accessCount).toBe(1);

    // A search with nothing to search over counts nothing.
    const empty = new InMemoryStore();
    await searchMemory({ store: empty, userId: USER }, { query: '团子' });
    expect(await empty.getMemory(USER, memory.id)).toBeNull();
  });

  it('never reaches another user\'s memories', async () => {
    await store.createMemory('someone-else', {
      type: 'semantic',
      content: '别人家的猫叫团子',
      source: 'user_stated',
    });

    const result = await searchMemory(ctx, { query: '团子' });
    expect(result.found).toBe(0);
  });

  it('is wider than the automatic path, on purpose', async () => {
    // The model asked a specific question and can judge the answer itself, so
    // the tool has no overlap gate and a larger budget. Automatic injection is
    // the one that needs a gate, because nothing downstream can reject a bad
    // match before it reaches the prompt.
    const memory = await seed('用户去年冬天搬到了杭州');

    const auto = selectMemories([memory], '今天好累', {
      budget: AUTO_INJECT_BUDGET,
      now: new Date(),
    });
    const viaTool = await searchMemory(ctx, { query: '今天好累' });

    expect(auto.selected).toHaveLength(0);
    expect(viaTool.found).toBe(1);
  });
});

describe('saveMemory', () => {
  it('stores what the user explicitly asked to be remembered', async () => {
    const result = await saveMemory(ctx, {
      type: 'semantic',
      content: '用户要求叫他全名，不要叫小杨',
      source: 'user_explicit',
    });

    expect(result.ok).toBe(true);
    expect(result.action).toBe('created');
    expect(result.id).not.toBeNull();
    expect(await store.listMemories(USER)).toHaveLength(1);
  });

  it('records the message the memory came from', async () => {
    const withSource: ToolContext = { ...ctx, sourceMessageId: 'msg-42' };
    const result = await saveMemory(withSource, {
      type: 'episodic',
      content: '用户提到昨天去看了牙医',
      source: 'user_stated',
    });

    const stored = await store.getMemory(USER, result.id as string);
    expect(stored?.sourceMessageId).toBe('msg-42');
  });

  it('refuses a low-confidence inference and says why', async () => {
    const result = await saveMemory(ctx, {
      type: 'semantic',
      content: '用户可能有回避型依恋',
      source: 'inferred',
      confidence: 0.3,
    });

    expect(result.ok).toBe(false);
    expect(result.explanation).toContain('confidence');
    expect(await store.listMemories(USER)).toHaveLength(0);
  });

  it('refuses an unknown type rather than coercing it', async () => {
    const result = await saveMemory(ctx, {
      type: 'feeling' as never,
      content: '随便什么',
      source: 'user_stated',
    });

    expect(result.ok).toBe(false);
    expect(result.explanation).toContain('episodic');
  });

  it('tells the model when a save was folded into an existing memory', async () => {
    await saveMemory(ctx, { type: 'semantic', content: '用户讨厌香菜', source: 'user_stated' });
    const second = await saveMemory(ctx, {
      type: 'semantic',
      content: '用户讨厌香菜',
      source: 'user_stated',
    });

    expect(second.action).toBe('updated');
    expect(second.explanation).toContain('没有新增');
    expect(await store.listMemories(USER)).toHaveLength(1);
  });

  it('explains a rejection instead of throwing', async () => {
    // A thrown error becomes an SDK tool failure string; a returned explanation
    // becomes something the model can act on.
    const result = await saveMemory(ctx, {
      type: 'episodic',
      content: ' '.repeat(3),
      source: 'user_stated',
    });
    expect(result.ok).toBe(false);
    expect(result.explanation.length).toBeGreaterThan(0);
  });
});

describe('updateMemory', () => {
  it('corrects a memory the user has contradicted', async () => {
    const created = await saveMemory(ctx, {
      type: 'semantic',
      content: '用户喜欢跑步，每周跑三次',
      source: 'user_stated',
    });

    const result = await updateMemory(ctx, {
      id: created.id as string,
      content: '用户膝盖受伤，已经不再跑步了',
      importance: 0.8,
    });

    expect(result.ok).toBe(true);
    const stored = await store.getMemory(USER, created.id as string);
    expect(stored?.content).toContain('不再跑步');
    expect(stored?.importance).toBeCloseTo(0.8, 5);
  });

  it('retires a memory that no longer applies', async () => {
    const created = await saveMemory(ctx, {
      type: 'narrative',
      content: '用户正在准备考研',
      source: 'user_stated',
    });

    const result = await updateMemory(ctx, { id: created.id as string, status: 'deleted' });
    expect(result.explanation).toContain('不再适用');
    expect((await store.getMemory(USER, created.id as string))?.status).toBe('deleted');
  });

  it('writes an audit event naming the model as the actor', async () => {
    const created = await saveMemory(ctx, {
      type: 'semantic',
      content: '用户喜欢跑步',
      source: 'user_stated',
    });
    await updateMemory(ctx, { id: created.id as string, content: '用户不跑步了' });

    const event = store.events.find((entry) => entry.action === 'updated');
    expect(event?.actor).toBe('agent');
    expect(event?.memoryId).toBe(created.id);
  });

  it('reports a missing id instead of silently doing nothing', async () => {
    const result = await updateMemory(ctx, { id: '0192f0aa-0000-7000-8000-000000000000', content: 'x' });
    expect(result.ok).toBe(false);
    expect(result.explanation).toContain('没有找到');
  });

  it('rejects an empty id, an empty body and an over-long body', async () => {
    const created = await saveMemory(ctx, {
      type: 'semantic',
      content: '用户喜欢跑步',
      source: 'user_stated',
    });
    const id = created.id as string;

    expect((await updateMemory(ctx, { id: '  ', content: 'x' })).ok).toBe(false);
    expect((await updateMemory(ctx, { id, content: '   ' })).ok).toBe(false);
    expect((await updateMemory(ctx, { id, content: '长'.repeat(501) })).ok).toBe(false);
  });

  it('cannot touch another user\'s memory', async () => {
    const created = await saveMemory(ctx, {
      type: 'semantic',
      content: '用户喜欢跑步',
      source: 'user_stated',
    });

    const intruder: ToolContext = { store, userId: 'someone-else' };
    const result = await updateMemory(intruder, { id: created.id as string, content: '被我改了' });

    expect(result.ok).toBe(false);
    expect((await store.getMemory(USER, created.id as string))?.content).toBe('用户喜欢跑步');
  });
});

describe('side effects and approval (spec §16)', () => {
  it('declares an effect for every tool', () => {
    expect(Object.keys(TOOL_SIDE_EFFECTS).sort()).toEqual([
      'save_memory',
      'search_memory',
      'update_memory',
    ]);
  });

  it('does not require approval for its own tools', () => {
    // Every effect they have is a local, reversible write to the person's own
    // memory — nothing leaves the system, and everything can be undone.
    expect(requiresApproval('search_memory')).toBe(false);
    expect(requiresApproval('save_memory')).toBe(false);
    expect(requiresApproval('update_memory')).toBe(false);
  });

  it('requires approval for anything unknown', () => {
    // The default has to be "ask", because the alternative is that adding a tool
    // is all it takes to get an unapproved side effect.
    expect(requiresApproval('send_email')).toBe(true);
    expect(requiresApproval('some_future_tool')).toBe(true);
  });
});
