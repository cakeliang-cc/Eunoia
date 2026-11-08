/**
 * Fitting one model request into the window (ADR 030).
 *
 * The session layer already budgets the history before a turn; these tests are
 * about the part it cannot see — the model's own output, its tool calls and the
 * results of those calls, which keep appending while the loop runs.
 *
 * `chars4` is used throughout so the arithmetic is exact: one token is four
 * characters, and a test can state the window it means.
 */

import { describe, expect, it } from 'vitest';
import {
  estimateItemTokens,
  estimateSystemTokens,
  fitContext,
  type ContextBudget,
} from '../../src/agent/context-budget.ts';
import type { LoopInputItem } from '../../src/agent/model-port.ts';
import type { ToolSchema } from '../../src/tools/types.ts';

function budget(overrides: Partial<ContextBudget> = {}): ContextBudget {
  return {
    windowTokens: 1_000,
    outputReserveTokens: 100,
    safetyBufferTokens: 50,
    estimator: 'chars4',
    ...overrides,
  };
}

function message(role: 'user' | 'assistant' | 'system', content: string): LoopInputItem {
  return { type: 'message', role, content };
}

function call(callId: string, name = 'read_thing', args = '{}'): LoopInputItem {
  return { type: 'function_call', callId, name, arguments: args };
}

function result(callId: string, output: string): LoopInputItem {
  return { type: 'function_call_result', callId, name: 'read_thing', output };
}

function totalTokens(items: readonly LoopInputItem[]): number {
  return items.reduce((sum, item) => sum + estimateItemTokens(item, 'chars4'), 0);
}

describe('a request that fits', () => {
  it('is left untouched', () => {
    const items = [message('user', '你好'), message('assistant', '在。'), message('user', '继续')];
    const fit = fitContext({
      instructions: '你是小芽。',
      tools: [],
      items,
      budget: budget(),
    });

    expect(fit.items).toEqual(items);
    expect(fit).toMatchObject({ compressedResults: 0, droppedItems: 0, exhausted: false });
    expect(fit.tokens).toBeLessThanOrEqual(1_000 - 150);
  });
});

describe('compression comes before dropping', () => {
  it('cuts the oldest tool result, keeps its call, and leaves the newest result alone', () => {
    const items = [
      message('user', '读两个文件'),
      call('c1'),
      result('c1', 'a'.repeat(6_000)),
      call('c2'),
      result('c2', 'b'.repeat(200)),
      message('user', '接着说'),
    ];

    const fit = fitContext({ instructions: '', tools: [], items, budget: budget() });

    expect(fit).toMatchObject({ compressedResults: 1, droppedItems: 0, exhausted: false });
    const compressed = fit.items.find(
      (item) => item.type === 'function_call_result' && item.callId === 'c1',
    );
    const untouched = fit.items.find(
      (item) => item.type === 'function_call_result' && item.callId === 'c2',
    );
    expect(compressed?.type === 'function_call_result' && compressed.output).toContain('压缩');
    expect(untouched?.type === 'function_call_result' && untouched.output).toBe('b'.repeat(200));
    // The call and its result are still a pair: a lone half is a malformed request.
    expect(fit.items.some((item) => item.type === 'function_call' && item.callId === 'c1')).toBe(true);
    expect(fit.items.some((item) => item.type === 'function_call_result' && item.callId === 'c1')).toBe(true);
  });

  it('does not compress a result that is already small', () => {
    const items = [
      message('user', 'u'),
      call('c1'),
      result('c1', 'a'.repeat(400)),
      call('c2'),
      result('c2', 'b'.repeat(100)),
      message('user', 'current'),
    ];
    const fit = fitContext({ instructions: '', tools: [], items, budget: budget({ windowTokens: 400 }) });

    expect(fit.compressedResults).toBe(0);
  });
});

describe('dropping old history', () => {
  it('removes an old call and its result together, and never the current turn', () => {
    const items = [
      message('user', '旧的'),
      call('c1'),
      result('c1', 'x'.repeat(2_000)),
      message('user', '现在的'),
    ];

    const fit = fitContext({
      instructions: '',
      tools: [],
      items,
      budget: budget({ windowTokens: 400, outputReserveTokens: 100, safetyBufferTokens: 50 }),
    });

    expect(fit.exhausted).toBe(false);
    expect(fit.droppedItems).toBe(3);
    expect(fit.items.some((item) => item.type === 'function_call')).toBe(false);
    expect(fit.items.some((item) => item.type === 'function_call_result')).toBe(false);
    expect(fit.items).toContainEqual(message('user', '现在的'));
  });

  it('leaves a call that has no result rather than sending half a pair', () => {
    // The only removable item before the current turn is an orphan call. Dropping
    // it alone would produce a request whose ids do not pair, so nothing is
    // dropped and the turn is reported as out of room.
    const items = [call('c1'), message('user', 'x'.repeat(200))];

    const fit = fitContext({
      instructions: '',
      tools: [],
      items,
      budget: budget({ windowTokens: 60, outputReserveTokens: 0, safetyBufferTokens: 0 }),
    });

    expect(fit.exhausted).toBe(true);
    expect(fit.items.some((item) => item.type === 'function_call' && item.callId === 'c1')).toBe(true);
  });
});

describe('when it cannot fit', () => {
  it('reports exhausted instead of trimming the work in progress', () => {
    const items = [
      message('user', '当前任务'),
      call('c1'),
      result('c1', 'y'.repeat(8_000)),
    ];

    const fit = fitContext({ instructions: '', tools: [], items, budget: budget() });

    expect(fit.exhausted).toBe(true);
    expect(fit.droppedItems).toBe(0);
    expect(fit.reason).toContain('tokens');
    expect(fit.items.some((item) => item.type === 'function_call_result')).toBe(true);
  });

  it('counts the system prompt and the tool schemas against the window', () => {
    const tools: ToolSchema[] = [
      {
        name: 'read_thing',
        description: 'read',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ];
    const instructions = 'x'.repeat(4_000); // ~1000 tokens at chars4
    const systemTokens = estimateSystemTokens(instructions, tools, 'chars4');
    expect(systemTokens).toBeGreaterThan(1_000);

    const fit = fitContext({
      instructions,
      tools,
      items: [message('user', 'hi')],
      budget: budget({ windowTokens: 1_000 }),
    });

    expect(fit.exhausted).toBe(true);
    expect(fit.systemTokens).toBe(systemTokens);
    expect(fit.reason).toContain('prompt');
  });
});

describe('the accounting', () => {
  it('counts every item shape, not just messages', () => {
    expect(estimateItemTokens(message('user', 'abcd'), 'chars4')).toBe(5);
    expect(estimateItemTokens(call('c1', 'read', '{}'), 'chars4')).toBe(6);
    expect(estimateItemTokens(result('c1', 'abcd'), 'chars4')).toBe(5);
    expect(estimateItemTokens({ type: 'reasoning', text: 'abcd' }, 'chars4')).toBe(5);
  });

  it('reports the total it would send, system prompt included', () => {
    const items = [message('user', 'abcd')];
    const fit = fitContext({ instructions: 'abcd', tools: [], items, budget: budget() });
    expect(fit.tokens).toBe(fit.systemTokens + totalTokens(items));
  });
});
