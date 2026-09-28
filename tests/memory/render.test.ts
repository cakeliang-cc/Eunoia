/**
 * Rendering memories into the prompt.
 *
 * The two properties that matter: provenance is always visible, and an empty
 * result costs no prompt text. Both are small, and both are the difference
 * between a companion that says "you told me your mother is ill" and one that
 * says "I have a hunch your mother might be ill" — or worse, says nothing at all
 * because a header was emitted with no items under it.
 */

import { describe, expect, it } from 'vitest';
import { renderMemories } from '../../src/memory/render.ts';
import { makeMemory } from '../helpers/fixtures.ts';

describe('renderMemories', () => {
  it('returns an empty string when there is nothing to render', () => {
    // No "no memories found" header: prompt text spent announcing an absence is
    // text not spent on anything useful.
    expect(renderMemories([])).toBe('');
  });

  it('labels what the user said and what the model inferred differently', () => {
    const block = renderMemories([
      makeMemory({ content: '用户讨厌香菜', source: 'user_stated' }),
      makeMemory({ content: '用户可能在考虑换工作', source: 'inferred', status: 'unconfirmed' }),
    ]);

    expect(block).toContain('你说过的');
    expect(block).toContain('我的推测（未经你确认）');
  });

  it('labels who asked for it to be remembered', () => {
    const block = renderMemories([
      makeMemory({ content: '用户要求叫他全名', source: 'user_explicit' }),
    ]);
    expect(block).toContain('你明确让我记住的');
  });

  it('says the list is not everything', () => {
    // Without this the model treats retrieval results as the whole of what it
    // knows, and starts behaving as though the person's history were four items
    // long.
    const block = renderMemories([makeMemory({ content: '用户喜欢跑步' })]);
    expect(block).toContain('不是全部');
  });

  it('states the rules for using the block', () => {
    const block = renderMemories([makeMemory({ content: '用户喜欢跑步' })]);
    expect(block).toContain('不要复述');
    expect(block).toContain('不要说成事实');
  });

  it('accepts scored entries as well as bare memories', () => {
    const memory = makeMemory({ content: '用户喜欢跑步' });
    const block = renderMemories([{ memory, score: 0.9, terms: {
      similarity: 1, importance: 0.5, recency: 1, typePrior: 1,
    } }]);
    expect(block).toContain('用户喜欢跑步');
  });

  it('stops at the character cap rather than emitting an unbounded block', () => {
    const memories = Array.from({ length: 40 }, (_, i) =>
      makeMemory({ content: `第 ${i} 条记忆，内容有相当的长度`.repeat(3) }),
    );
    const block = renderMemories(memories, { maxChars: 300 });
    expect(block.length).toBeLessThan(900);
  });

  it('describes importance in bands, not raw floats', () => {
    // A float like 0.73 tells the model nothing it can act on.
    const block = renderMemories([makeMemory({ content: '重要的事', importance: 0.95 })]);
    expect(block).toContain('重要');
    expect(block).not.toContain('0.95');
  });
});
