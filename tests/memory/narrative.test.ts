/**
 * The narrative block: which themes get carried, and what the model is told to do
 * with them.
 *
 * The module exists because of a measurement rather than an intuition, and the
 * test that matters most is the first one: the memory that provoked it is dropped
 * by the similarity gate, so a block selected *by* similarity would drop it too.
 * Everything else here is the budget and the honesty rules.
 */

import { describe, expect, it } from 'vitest';
import { NARRATIVE_BUDGET, selectNarratives, renderNarratives } from '../../src/memory/narrative.ts';
import { AUTO_INJECT_BUDGET, selectMemories } from '../../src/memory/retrieval.ts';
import { makeMemory, type MemoryOverrides } from '../helpers/fixtures.ts';

const THEME = '用户正在纠结要不要离开现在的城市、回老家生活，这件事反复出现过好几次，一直没有结论';
const MESSAGE = '最近老是梦见小时候住的那个院子。';

function narrative(overrides: Partial<MemoryOverrides> = {}) {
  return makeMemory({ type: 'narrative', content: THEME, importance: 0.9, ...overrides });
}

describe('why the block exists', () => {
  it('carries a theme that the similarity gate provably drops', () => {
    // The measurement, pinned. If this ever starts passing on the retrieval
    // path, the block has become redundant and that is worth being told.
    const memory = narrative();
    const retrieved = selectMemories([memory], MESSAGE, { budget: AUTO_INJECT_BUDGET });

    expect(retrieved.selected).toHaveLength(0);
    expect(retrieved.droppedReasons.below_min_similarity).toBe(1);

    // The same memory, selected without a query at all.
    expect(selectNarratives([memory])).toHaveLength(1);
  });
});

describe('selectNarratives', () => {
  it('carries only narrative memories', () => {
    const chosen = selectNarratives([
      narrative(),
      makeMemory({ type: 'semantic', content: '用户住在杭州' }),
      makeMemory({ type: 'episodic', content: '上周去看了海' }),
    ]);

    expect(chosen).toHaveLength(1);
    expect(chosen[0]?.type).toBe('narrative');
  });

  it('leaves out a theme the model guessed rather than was told', () => {
    // The block is headed "这是 ta 正在经历的事". A guess about someone's life
    // cannot be stated in that voice — the same reason the source labels exist.
    const chosen = selectNarratives([
      narrative({ status: 'unconfirmed', content: '用户可能想辞职' }),
      narrative({ content: THEME }),
    ]);

    expect(chosen.map((memory) => memory.content)).toEqual([THEME]);
  });

  it('ranks by importance and recency, since similarity is unavailable', () => {
    const now = new Date('2026-09-29T12:00:00Z');
    const day = 86_400_000;

    // A narrative's half-life is 120 days, so a two-year-old theme has decayed
    // to about 2% and loses to a trivial new one. That is the intended shape:
    // "what you are living through" is a claim about now, and a theme nothing
    // has been said about in two years is history rather than a current story.
    const chosen = selectNarratives(
      [
        narrative({ content: '不重要的新事', importance: 0.2, updatedAt: now }),
        narrative({
          content: '重要但两年前',
          importance: 1,
          updatedAt: new Date(now.getTime() - 730 * day),
        }),
        narrative({ content: '重要且新近', importance: 0.9, updatedAt: now }),
      ],
      { now },
    );

    expect(chosen.map((memory) => memory.content)).toEqual(['重要且新近', '不重要的新事', '重要但两年前']);
  });

  it('does not let a stale theme outrank a current one of the same importance', () => {
    const now = new Date('2026-09-29T12:00:00Z');
    const day = 86_400_000;

    const chosen = selectNarratives(
      [
        narrative({ content: '上个月说的', importance: 0.7, updatedAt: new Date(now.getTime() - 30 * day) }),
        narrative({ content: '昨天说的', importance: 0.7, updatedAt: new Date(now.getTime() - day) }),
      ],
      { now },
    );

    expect(chosen.map((memory) => memory.content)).toEqual(['昨天说的', '上个月说的']);
  });

  it('caps how many themes are carried', () => {
    const many = Array.from({ length: 10 }, (_, i) => narrative({ content: `主题 ${i}` }));
    expect(selectNarratives(many)).toHaveLength(NARRATIVE_BUDGET.maxItems);
  });

  it('stays inside its character cap', () => {
    const long = Array.from({ length: 10 }, (_, i) =>
      narrative({ content: `${i}：${'很长的主题描述，'.repeat(20)}` }),
    );
    const block = renderNarratives(selectNarratives(long));

    // The header and the rules are constant overhead; the cap applies to the
    // items, so the assertion allows for the frame around them.
    expect(block.length).toBeLessThan(1200);
    expect(block.split('\n- ').length - 1).toBeLessThanOrEqual(NARRATIVE_BUDGET.maxItems);
  });
});

describe('renderNarratives', () => {
  it('returns nothing when there are no themes', () => {
    // No header announcing an absence: prompt text spent on nothing, every turn.
    expect(renderNarratives([])).toBe('');
  });

  it('says the themes are background rather than a topic', () => {
    const block = renderNarratives([narrative()]);
    expect(block).toContain('背景');
    expect(block).toContain('不是话题');
  });

  it('asks the model to connect a theme even when the words differ', () => {
    // The behaviour all four measured failures were missing. Without this line
    // the block is a fact the model may or may not think to use; with it, the
    // instruction names the exact move narrative continuity is.
    const block = renderNarratives([narrative()]);
    expect(block).toContain('换了完全不同的说法');
  });

  it('forbids reciting the list and claiming a record', () => {
    const block = renderNarratives([narrative()]);
    expect(block).toContain('不要罗列');
    expect(block).toContain('根据我的记录');
  });
});
