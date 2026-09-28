/**
 * What the model sees before it says anything.
 *
 * The design decision under test is that memory retrieval is *automatic* rather
 * than left to the model's discretion. That choice fails silently when it is
 * wrong — nothing errors, the reply just does not know something it should — so
 * the properties here are asserted directly rather than hoped for.
 *
 * The counterweight is the budget. Four loosely-related memories volunteered
 * into every turn would be worse than none, which is why `AUTO_INJECT_BUDGET` is
 * tighter than the tool's budget and carries an overlap gate. Both halves are
 * tested: that relevant memory arrives, and that irrelevant memory does not.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { AUTO_INJECT_BUDGET } from '../../src/memory/retrieval.ts';
import { buildTurnContext } from '../../src/service/context.ts';
import type { MemoryType } from '../../src/memory/types.ts';

const USER = 'user-1';

let store: InMemoryStore;

beforeEach(() => {
  store = new InMemoryStore();
});

async function seed(
  content: string,
  options: { type?: MemoryType; importance?: number; status?: 'active' | 'unconfirmed' } = {},
) {
  return store.createMemory(USER, {
    type: options.type ?? 'semantic',
    content,
    source: 'user_stated',
    importance: options.importance ?? 0.6,
    confidence: 0.8,
    status: options.status,
  });
}

describe('buildTurnContext', () => {
  it('returns an empty block when there is nothing to retrieve', async () => {
    const context = await buildTurnContext(store, USER, '在吗');

    expect(context.memoryBlock).toBe('');
    expect(context.memoryCount).toBe(0);
    expect(context.memoryConsidered).toBe(0);
  });

  it('retrieves a memory relevant to the message and renders it', async () => {
    await seed('用户养了一只叫团子的猫');

    const context = await buildTurnContext(store, USER, '团子最近有点不吃饭');
    expect(context.memoryCount).toBe(1);
    expect(context.memoryBlock).toContain('团子');
    expect(context.memoryBlock).toContain('你说过的');
  });

  it('reports how many memories existed to choose from', async () => {
    await seed('用户养了一只叫团子的猫');
    await seed('用户在做前端开发');
    await seed('用户讨厌香菜');

    const context = await buildTurnContext(store, USER, '团子最近有点不吃饭');
    expect(context.memoryConsidered).toBe(3);
    expect(context.memoryCount).toBe(1);
  });

  it('excludes a deleted memory', async () => {
    const memory = await seed('用户养了一只叫团子的猫');
    await store.deleteMemory(USER, memory.id);

    const context = await buildTurnContext(store, USER, '团子最近有点不吃饭');
    expect(context.memoryCount).toBe(0);
  });

  it('still offers an unconfirmed inference, marked as one', async () => {
    // Retrieval does not treat a guess as a second-class citizen — dropping it
    // would make the companion quietly forget everything it had worked out. What
    // changes is the label, not the ranking.
    await seed('用户可能想换工作', { type: 'narrative', status: 'unconfirmed' });

    const context = await buildTurnContext(store, USER, '我最近在想要不要换工作');
    expect(context.memoryCount).toBe(1);
    expect(context.memoryBlock).toContain('我的推测');
    expect(context.memoryBlock).toContain('不要说成事实');
  });
});

describe('the automatic budget', () => {
  it('caps the number of memories injected', async () => {
    for (let i = 0; i < 10; i += 1) await seed(`用户喜欢跑步，这是关于跑步的第 ${i} 条`);

    const context = await buildTurnContext(store, USER, '我最近又开始跑步了');
    expect(context.memoryCount).toBeLessThanOrEqual(AUTO_INJECT_BUDGET.maxItems);
  });

  it('caps how many come from any one type', async () => {
    for (let i = 0; i < 5; i += 1) {
      await seed(`用户跑步时发生的一件具体的事，第 ${i} 件`, { type: 'episodic', importance: 0.9 });
    }
    await seed('用户喜欢跑步', { type: 'semantic', importance: 0.9 });

    const context = await buildTurnContext(store, USER, '我最近又开始跑步了');
    const episodic = context.memoryBlock.split('发生的一件具体的事').length - 1;
    expect(episodic).toBeLessThanOrEqual(AUTO_INJECT_BUDGET.maxPerType);
  });

  it('keeps the rendered block within its character cap', async () => {
    for (let i = 0; i < 8; i += 1) {
      await seed(`关于跑步的一段很长的记忆，第 ${i} 条，`.repeat(4), { importance: 0.9 });
    }

    const context = await buildTurnContext(store, USER, '我最近又开始跑步了');
    expect(context.memoryBlock.length).toBeLessThanOrEqual(AUTO_INJECT_BUDGET.maxChars + 200);
  });

  it('excludes an irrelevant memory even when it is important and recent', async () => {
    // The gate that does this is `minSimilarity`, and it exists only on this
    // path: nothing downstream can reject a bad match before it reaches the
    // prompt, so the rejection has to happen here.
    await seed('用户母亲生病住院了', { importance: 1, type: 'narrative' });

    const context = await buildTurnContext(store, USER, '我今天中午吃了拉面');
    expect(context.memoryCount).toBe(0);
    expect(context.memoryBlock).toBe('');
  });

  it('still injects a relevant memory that is neither important nor recent', async () => {
    // The other direction of the same gate. Both of the terms that would
    // normally carry a weak memory — importance and recency — are near zero
    // here, and it is still injected, because relevance is what the gate is
    // about and a stale unimportant fact that bears on this sentence is exactly
    // what a companion should remember.
    await seed('用户养了一只叫团子的猫', { importance: 0.2 });

    const context = await buildTurnContext(store, USER, '团子今天吐了', {
      now: new Date(Date.now() + 400 * 86_400_000),
    });

    expect(context.memoryCount).toBe(1);
    expect(context.memoryBlock).toContain('团子');
  });
});

describe('access accounting and the audit trail', () => {
  it('counts an access for each memory it injects', async () => {
    const memory = await seed('用户养了一只叫团子的猫');

    await buildTurnContext(store, USER, '团子最近有点不吃饭');

    const updated = await store.getMemory(USER, memory.id);
    expect(updated?.accessCount).toBe(1);
  });

  it('records what was retrieved, as the system rather than the model', async () => {
    await seed('用户养了一只叫团子的猫');

    await buildTurnContext(store, USER, '团子最近有点不吃饭');

    const event = store.events.find((entry) => entry.action === 'retrieved');
    expect(event?.actor).toBe('system');
    expect(event?.detail?.count).toBe(1);
  });

  it('records nothing when nothing was retrieved', async () => {
    await seed('用户养了一只叫团子的猫');
    await buildTurnContext(store, USER, '我今天中午吃了拉面');
    expect(store.events).toEqual([]);
  });

  it('does not fail the turn when access accounting fails', async () => {
    // Access counts feed the memory panel, not ranking. A bookkeeping failure
    // must not cost the person their reply.
    class NoAccountingStore extends InMemoryStore {
      override async markAccessed(): Promise<void> {
        throw new Error('accounting is down');
      }
      override async logMemoryEvent(): Promise<void> {
        throw new Error('audit is down');
      }
    }
    const broken = new NoAccountingStore();
    await broken.createMemory(USER, {
      type: 'semantic',
      content: '用户养了一只叫团子的猫',
      source: 'user_stated',
    });

    const context = await buildTurnContext(broken, USER, '团子最近有点不吃饭');
    expect(context.memoryCount).toBe(1);
    expect(context.memoryBlock).toContain('团子');
  });
});

describe('retrieve: false', () => {
  it('short-circuits the whole retrieval path', async () => {
    await seed('用户养了一只叫团子的猫', { importance: 1 });

    const context = await buildTurnContext(store, USER, '团子最近有点不吃饭', { retrieve: false });

    expect(context.memoryBlock).toBe('');
    expect(context.memoryCount).toBe(0);
    expect(context.memoryConsidered).toBe(0);
    expect(store.events).toEqual([]);
  });

  it('still assesses risk — switching memory off is not switching safety off', async () => {
    const context = await buildTurnContext(store, USER, '我不想活了', { retrieve: false });
    expect(context.risk.level).toBe('crisis');
  });
});

describe('risk assessment', () => {
  it('carries the assessment for the turn', async () => {
    expect((await buildTurnContext(store, USER, '今天什么都不想做')).risk.level).toBe('none');
    expect((await buildTurnContext(store, USER, '我快崩溃了')).risk.level).toBe('elevated');
    expect((await buildTurnContext(store, USER, '我不想活了')).risk.level).toBe('crisis');
  });

  it('assesses risk from the message alone, not from what was retrieved', async () => {
    // A crisis message that also mentions something remembered still has to be
    // a crisis turn: the safety directive is chosen from the person's words, and
    // a well-populated memory store must not be able to dilute it.
    await seed('用户养了一只叫团子的猫', { importance: 1 });

    const context = await buildTurnContext(store, USER, '团子死了，我也不想活了');
    expect(context.risk.level).toBe('crisis');
  });
});
