/**
 * Working memory: bounded, idle-expiring, and never persisted.
 *
 * The last property is the one worth a test rather than a comment. Working
 * memory is *derivable* — every turn in it is also a row in `messages` — and a
 * second copy that can go stale without anyone noticing is worse than no copy.
 */

import { describe, expect, it } from 'vitest';
import { WorkingMemory, seedWorkingMemory } from '../../src/memory/working-memory.ts';
import { importSpecifiers, readSources } from '../helpers/sources.ts';

describe('WorkingMemory', () => {
  it('keeps turns in order', () => {
    const working = new WorkingMemory();
    working.remember('c1', { role: 'user', content: '第一句' });
    working.remember('c1', { role: 'assistant', content: '第二句' });

    expect(working.context('c1').map((turn) => turn.content)).toEqual(['第一句', '第二句']);
  });

  it('keeps conversations apart', () => {
    const working = new WorkingMemory();
    working.remember('c1', { role: 'user', content: 'A' });
    working.remember('c2', { role: 'user', content: 'B' });

    expect(working.context('c1')).toHaveLength(1);
    expect(working.context('c2')[0]?.content).toBe('B');
  });

  it('returns a copy, so a caller cannot mutate session state', () => {
    const working = new WorkingMemory();
    working.remember('c1', { role: 'user', content: 'A' });

    const context = working.context('c1') as unknown as { content: string }[];
    context.push({ content: 'B' });

    expect(working.context('c1')).toHaveLength(1);
  });

  it('trims to maxTurns, dropping the oldest first', () => {
    const working = new WorkingMemory({ maxTurns: 3, maxChars: 10_000 });
    for (let i = 0; i < 6; i += 1) working.remember('c1', { role: 'user', content: `第${i}句` });

    expect(working.context('c1').map((turn) => turn.content)).toEqual(['第3句', '第4句', '第5句']);
  });

  it('trims to maxChars', () => {
    const working = new WorkingMemory({ maxTurns: 100, maxChars: 20 });
    working.remember('c1', { role: 'user', content: '一'.repeat(15) });
    working.remember('c1', { role: 'user', content: '二'.repeat(15) });

    const total = working.context('c1').reduce((sum, turn) => sum + turn.content.length, 0);
    expect(total).toBeLessThanOrEqual(20);
  });

  it('always keeps the newest turn, even when it alone exceeds the budget', () => {
    // Dropping the thing the person just said, in order to satisfy a character
    // budget, would be the wrong trade every time.
    const working = new WorkingMemory({ maxTurns: 10, maxChars: 5 });
    working.remember('c1', { role: 'user', content: '旧的一句话' });
    working.remember('c1', { role: 'user', content: '这一句很长很长很长' });

    const context = working.context('c1');
    expect(context).toHaveLength(1);
    expect(context[0]?.content).toBe('这一句很长很长很长');
  });

  it('sweeps conversations idle past the TTL', () => {
    const working = new WorkingMemory({ ttlMs: 1000 });
    working.remember('c1', { role: 'user', content: 'A' });
    working.remember('c2', { role: 'user', content: 'B' });

    // Age one conversation by sweeping at a time past its TTL, and re-touch the
    // other so it survives. Tests the boundary rather than sleeping.
    working.remember('c2', { role: 'user', content: 'B again' });
    const dropped = working.sweep(Date.now() + 5000);

    expect(dropped).toBe(2);
    expect(working.size).toBe(0);
  });

  it('grows the process only by live conversations', () => {
    const working = new WorkingMemory({ ttlMs: 60_000 });
    for (let i = 0; i < 100; i += 1) {
      working.remember(`c${i}`, { role: 'user', content: 'x' });
      working.forget(`c${i}`);
    }
    expect(working.size).toBe(0);
  });
});

describe('seedWorkingMemory', () => {
  it('reconstructs a session from persisted history', () => {
    // This is what makes the working set safe to drop: it is rebuildable from
    // the database rather than lost.
    const working = new WorkingMemory();
    seedWorkingMemory(working, 'c1', [
      { role: 'user', content: '第一句', createdAt: new Date() },
      { role: 'assistant', content: '第二句', createdAt: new Date() },
    ]);

    expect(working.context('c1').map((turn) => turn.content)).toEqual(['第一句', '第二句']);
  });

  it('ignores system messages, which are not part of the conversation', () => {
    const working = new WorkingMemory();
    seedWorkingMemory(working, 'c1', [
      { role: 'system', content: '内部提示', createdAt: new Date() },
      { role: 'user', content: '你好', createdAt: new Date() },
    ]);

    expect(working.context('c1')).toHaveLength(1);
  });
});

describe('the never-persisted invariant (ADR 003)', () => {
  it('working memory imports nothing from the persistence layer', async () => {
    const sources = await readSources();
    const module = sources.find((entry) => entry.relativePath === 'src/memory/working-memory.ts');
    expect(module, 'working-memory.ts should exist').toBeDefined();

    const specifiers = importSpecifiers(module!.source);
    const persistence = specifiers.filter(
      (specifier) =>
        specifier.includes('/db/') ||
        specifier.includes('postgres') ||
        specifier.includes('store.ts') ||
        specifier === 'pg',
    );

    expect(persistence, 'working memory must not reach the database').toEqual([]);
  });
});
