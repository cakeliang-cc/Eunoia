/**
 * The request layout that makes prefix reuse possible.
 *
 * The stable instructions must not contain a clock, a memory, or a safety
 * directive. Those are appended after the current user message, where they are
 * new tail instead of a changed head.
 */

import { describe, expect, it } from 'vitest';
import {
  buildRunInput,
  cacheUsageOf,
  type RunInputItem,
} from '../../src/agent/infp-agent.ts';
import { buildInstructions, STABLE_INSTRUCTIONS } from '../../src/agent/instructions.ts';
import { buildRuntimeContext } from '../../src/agent/runtime-context.ts';

describe('buildRuntimeContext', () => {
  it('returns nothing when there is no per-turn context', () => {
    expect(buildRuntimeContext()).toBe('');
    expect(buildRuntimeContext({ memoryBlock: '   ' })).toBe('');
  });

  it('wraps background blocks and keeps the safety directive last', () => {
    const context = buildRuntimeContext({
      relationshipBlock: '关系块',
      narrativeBlock: '叙事块',
      archivedSummaryBlock: '摘要块',
      situationBlock: '时间块',
      memoryBlock: '记忆块',
      safetyDirective: '安全指令',
    });

    expect(context).toContain('# 本轮背景');
    expect(context).toContain('不是用户本轮发言');
    expect(context.indexOf('关系块')).toBeLessThan(context.indexOf('叙事块'));
    expect(context.indexOf('叙事块')).toBeLessThan(context.indexOf('摘要块'));
    expect(context.indexOf('摘要块')).toBeLessThan(context.indexOf('时间块'));
    expect(context.indexOf('时间块')).toBeLessThan(context.indexOf('记忆块'));
    expect(context.indexOf('记忆块')).toBeLessThan(context.indexOf('安全指令'));
  });

  it('does not put the safety directive inside the background wrapper', () => {
    const context = buildRuntimeContext({ safetyDirective: '安全指令' });
    expect(context).toBe('安全指令');
  });
});

describe('buildRunInput', () => {
  it('appends the current context after the user message', () => {
    const input = buildRunInput(
      '现在这句话',
      [
        { role: 'user', content: '之前的话' },
        { role: 'assistant', content: '之前的回复' },
      ],
      '本轮背景',
    );

    expect(Array.isArray(input)).toBe(true);
    const items = input as RunInputItem[];
    expect(items.map((item) => item.role)).toEqual([
      'user',
      'assistant',
      'user',
      'system',
    ]);
    expect(items.at(-1)).toEqual({
      role: 'system',
      content: '本轮背景',
      type: 'message',
    });
  });

  it('sends context even on the first message', () => {
    const input = buildRunInput('第一句', [], '关系块');
    expect(input).toEqual([
      { role: 'user', content: '第一句', type: 'message' },
      { role: 'system', content: '关系块', type: 'message' },
    ]);
  });

  it('keeps the bare-string fast path when there is no history or context', () => {
    expect(buildRunInput('只有这一句')).toBe('只有这一句');
  });
});

describe('stable instructions', () => {
  it('do not include per-turn context', () => {
    const context = buildRuntimeContext({
      relationshipBlock: '关系块',
      situationBlock: '时间块',
      memoryBlock: '记忆块',
      safetyDirective: '安全指令',
    });

    expect(buildInstructions()).toBe(STABLE_INSTRUCTIONS);
    expect(buildInstructions()).not.toContain('关系块');
    expect(buildInstructions()).not.toContain('时间块');
    expect(buildInstructions()).not.toContain('记忆块');
    expect(buildInstructions()).not.toContain('安全指令');
    expect(context).not.toBe('');
  });
});

describe('cacheUsageOf', () => {
  it('reports server-measured cache tokens from Responses usage details', () => {
    expect(
      cacheUsageOf({
        inputTokens: 1_000,
        inputTokensDetails: [{ cached_tokens: 800 }],
      }),
    ).toEqual({ input_tokens: 1_000, cached_tokens: 800, cache_hit_rate: 0.8 });
  });

  it('reports nothing when the provider gives no measurement', () => {
    expect(cacheUsageOf(undefined)).toBeNull();
    expect(cacheUsageOf({ inputTokens: 0 })).toBeNull();
  });
});
