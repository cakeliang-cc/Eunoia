/**
 * Retrieval: scoring, relevance gating, and the context budget.
 *
 * Two of spec §18's five memory requirements live here rather than in the writer
 * test, because they are properties of ranking, not of storage:
 *
 *   - **relevant memory retrieved**
 *   - **irrelevant memory not injected**
 *
 * Both are decided without a model call, which is the point of keeping scoring
 * pure. If relevance were only observable through a generated reply, neither
 * could be tested at all.
 */

import { describe, expect, it } from 'vitest';
import {
  AUTO_INJECT_BUDGET,
  DEFAULT_BUDGET,
  HALF_LIFE_DAYS,
  lexicalSimilarity,
  recencyFactor,
  scoreMemory,
  selectMemories,
  tokenize,
} from '../../src/memory/retrieval.ts';
import { makeMemory } from '../helpers/fixtures.ts';

const NOW = new Date('2026-09-28T12:00:00Z');

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 86_400_000);
}

describe('tokenize', () => {
  it('splits Latin runs into words', () => {
    expect(tokenize('Hello World')).toEqual(['hello', 'world']);
  });

  it('splits Chinese into character bigrams', () => {
    // Chinese has no spaces, so word splitting does not apply. Bigrams are the
    // cheap standard answer.
    expect(tokenize('面试焦虑')).toEqual(['面试', '试焦', '焦虑']);
  });

  it('keeps a single-character Chinese run whole', () => {
    expect(tokenize('猫')).toEqual(['猫']);
  });

  it('handles mixed scripts in one string', () => {
    expect(tokenize('跑步 5km')).toEqual(['5km', '跑步']);
  });
});

describe('lexicalSimilarity', () => {
  it('scores identical text as 1', () => {
    expect(lexicalSimilarity('面试焦虑', '面试焦虑')).toBe(1);
  });

  it('scores unrelated text as 0', () => {
    expect(lexicalSimilarity('面试焦虑', '养了一只叫豆豆的猫')).toBe(0);
  });

  it('gives partial credit for a shared clause', () => {
    // Overlap coefficient, not Jaccard: a short query matching part of a long
    // memory is a real match, and Jaccard would punish it for being long.
    const score = lexicalSimilarity('面试', '下周三有一个面试，在一家做硬件的公司');
    expect(score).toBeGreaterThan(0.1);
  });

  it('returns 0 rather than NaN for an empty query', () => {
    expect(lexicalSimilarity('', '随便什么')).toBe(0);
  });
});

describe('recencyFactor', () => {
  it('is 1 at age zero', () => {
    expect(recencyFactor(0, 30)).toBe(1);
  });

  it('is 0.5 at exactly one half-life', () => {
    expect(recencyFactor(30, 30)).toBeCloseTo(0.5, 6);
  });

  it('never goes negative for future timestamps', () => {
    expect(recencyFactor(-5, 30)).toBe(1);
  });
});

describe('scoreMemory', () => {
  it('gives a relevant memory a higher score than an irrelevant one', () => {
    const relevant = makeMemory({ content: '用户下周三有一个面试', updatedAt: daysAgo(1) });
    const irrelevant = makeMemory({ content: '用户养了一只叫豆豆的猫', updatedAt: daysAgo(1) });

    const options = { now: NOW, query: '面试的事我有点紧张' };
    expect(scoreMemory(relevant, options).score).toBeGreaterThan(
      scoreMemory(irrelevant, options).score,
    );
  });

  it('lets importance outweigh recency', () => {
    const important = makeMemory({ content: '随便一件事', importance: 1, updatedAt: daysAgo(200) });
    const trivial = makeMemory({ content: '随便一件事', importance: 0, updatedAt: daysAgo(0) });

    const options = { now: NOW, query: '随便' };
    expect(scoreMemory(important, options).score).toBeGreaterThan(
      scoreMemory(trivial, options).score,
    );
  });

  it('discounts an unconfirmed inference against a confirmed fact', () => {
    const shared = { content: '用户最近压力很大', updatedAt: daysAgo(3) };
    const confirmed = makeMemory({ ...shared, status: 'active' });
    const inferred = makeMemory({ ...shared, status: 'unconfirmed' });

    const options = { now: NOW, query: '最近好累' };
    expect(scoreMemory(confirmed, options).score).toBeGreaterThan(
      scoreMemory(inferred, options).score,
    );
  });

  it('exposes the four terms so a ranking can be explained', () => {
    const scored = scoreMemory(makeMemory({ content: '用户喜欢跑步' }), {
      now: NOW,
      query: '跑步',
    });
    expect(Object.keys(scored.terms).sort()).toEqual([
      'importance',
      'recency',
      'similarity',
      'typePrior',
    ]);
  });

  it('decays episodic memories faster than semantic ones', () => {
    // An event from two months ago is genuinely less present than a fact from
    // two months ago. Same age, different half-life.
    expect(HALF_LIFE_DAYS.episodic).toBeLessThan(HALF_LIFE_DAYS.semantic);

    const age = daysAgo(60);
    const episodic = makeMemory({ content: '一起去看了展', type: 'episodic', updatedAt: age });
    const semantic = makeMemory({ content: '一起去看了展', type: 'semantic', updatedAt: age });

    const options = { now: NOW, query: '看展' };
    expect(scoreMemory(semantic, options).terms.recency).toBeGreaterThan(
      scoreMemory(episodic, options).terms.recency,
    );
  });
});

describe('selectMemories — budget', () => {
  it('never returns more than maxItems, however many exist', () => {
    const memories = Array.from({ length: 50 }, (_, i) =>
      makeMemory({ content: `关于面试的第 ${i} 件事` }),
    );
    const { selected } = selectMemories(memories, '面试', { now: NOW });
    expect(selected.length).toBeLessThanOrEqual(DEFAULT_BUDGET.maxItems);
  });

  it('never returns more than maxChars', () => {
    const memories = Array.from({ length: 30 }, (_, i) =>
      makeMemory({ content: `面试相关的一段很长的内容 ${i} `.repeat(20) }),
    );
    const { selected } = selectMemories(memories, '面试', {
      now: NOW,
      budget: { maxItems: 50, maxChars: 300 },
    });
    const total = selected.reduce((sum, entry) => sum + entry.memory.content.length, 0);
    expect(total).toBeLessThanOrEqual(300);
  });

  it('skips an oversized memory rather than stopping, so a short one can still fit', () => {
    // Greedy-from-the-top would end the list at the first item that does not
    // fit, which wastes the remaining budget.
    const huge = makeMemory({ content: `面试${'很长的内容'.repeat(200)}`, importance: 1 });
    const small = makeMemory({ content: '面试相关的短句', importance: 0.9 });

    const { selected, droppedReasons } = selectMemories([huge, small], '面试', {
      now: NOW,
      budget: { maxItems: 5, maxChars: 60, minScore: 0, minSimilarity: null, maxPerType: 5 },
    });

    expect(selected.map((entry) => entry.memory.id)).toEqual([small.id]);
    expect(droppedReasons.budget_chars).toBe(1);
  });

  it('caps how many of one type can be selected', () => {
    const memories = Array.from({ length: 6 }, (_, i) =>
      makeMemory({ content: `面试当天发生的第 ${i} 件事`, type: 'episodic', importance: 1 }),
    );
    const { selected } = selectMemories(memories, '面试', {
      now: NOW,
      budget: { maxItems: 10, maxChars: 10_000, minScore: 0, minSimilarity: null, maxPerType: 2 },
    });
    expect(selected.length).toBe(2);
  });

  it('excludes deleted and superseded memories outright', () => {
    const memories = [
      makeMemory({ content: '面试相关 A', status: 'deleted' }),
      makeMemory({ content: '面试相关 B', status: 'superseded' }),
      makeMemory({ content: '面试相关 C', status: 'active' }),
    ];
    const { selected } = selectMemories(memories, '面试', { now: NOW });
    expect(selected).toHaveLength(1);
    expect(selected[0]?.memory.content).toBe('面试相关 C');
  });
});

describe('selectMemories — relevance', () => {
  /**
   * Spec §18: "irrelevant memory is not injected".
   *
   * The mechanism is `minSimilarity`, and the reason it is separate from
   * `minScore` is the point of this test: the irrelevant memory here is recent,
   * important and a preference, so it scores well on all three other terms.
   * Only an overlap gate excludes it.
   */
  it('excludes an irrelevant memory even when it is important and recent', () => {
    const relevant = makeMemory({ content: '用户下周三有一个面试' });
    const importantButUnrelated = makeMemory({
      content: '用户养了一只叫豆豆的猫，非常重要',
      importance: 1,
      type: 'semantic',
      updatedAt: daysAgo(0),
    });

    const { selected } = selectMemories([relevant, importantButUnrelated], '面试的事我有点紧张', {
      now: NOW,
      budget: AUTO_INJECT_BUDGET,
    });

    expect(selected.map((entry) => entry.memory.content)).toEqual(['用户下周三有一个面试']);
  });

  it('the same irrelevant memory WOULD be included without the gate', () => {
    // Proves the previous test is measuring the gate and not something else.
    // A test whose subject could pass for an unrelated reason is not evidence.
    const importantButUnrelated = makeMemory({
      content: '用户养了一只叫豆豆的猫，非常重要',
      importance: 1,
      updatedAt: daysAgo(0),
    });

    const { selected } = selectMemories([importantButUnrelated], '面试的事我有点紧张', {
      now: NOW,
      budget: { ...AUTO_INJECT_BUDGET, minSimilarity: null },
    });

    expect(selected).toHaveLength(1);
  });

  it('does not apply the overlap gate to a model-initiated search', () => {
    // The gate exists because automatic injection has no one to reject a bad
    // match. A search the model asked for does.
    const unrelated = makeMemory({ content: '用户养了一只叫豆豆的猫', importance: 1 });

    const { selected } = selectMemories([unrelated], '面试', {
      now: NOW,
      budget: { maxItems: 5, maxChars: 1000, minScore: 0, maxPerType: 5, minSimilarity: null },
    });

    expect(selected).toHaveLength(1);
  });

  it('ranks the relevant memory first', () => {
    const memories = [
      makeMemory({ content: '用户的猫叫豆豆' }),
      makeMemory({ content: '用户下周三有面试' }),
      makeMemory({ content: '用户住在杭州' }),
    ];
    const { ranked } = selectMemories(memories, '面试好紧张', { now: NOW });
    expect(ranked[0]?.memory.content).toBe('用户下周三有面试');
  });
});
