/**
 * The registry and the two pieces of schema plumbing it depends on.
 *
 * The property that matters is that the JSON Schema shown to the model and the
 * Zod schema used to validate the call are the same object. A drift test here is
 * worth more than a description test, because a model cannot see the difference
 * between a field it was not told about and a field the server will reject.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../../src/tools/registry.ts';
import { defineTool, toolOk } from '../../src/tools/types.ts';
import { parseToolArguments } from '../../src/tools/schema.ts';
import { truncateHead, truncateLine, truncateMiddle, truncateTail } from '../../src/tools/truncate.ts';

const probe = defineTool({
  name: 'probe',
  description: 'probe',
  parameters: z.object({
    path: z.string().describe('路径'),
    depth: z.number().int().optional(),
  }),
  sideEffect: 'none',
  readOnly: true,
  guidelines: 'probe: read only.',
  execute: async () => toolOk('ok'),
});

describe('the registry', () => {
  it('refuses duplicate names instead of depending on registration order', () => {
    expect(() => new ToolRegistry([probe, probe])).toThrow(/duplicate/);
  });

  it('derives a JSON Schema with the model-visible descriptions', () => {
    const [schema] = new ToolRegistry([probe]).schemas();
    expect(schema?.name).toBe('probe');
    expect(schema?.parameters).toMatchObject({
      type: 'object',
      properties: { path: { type: 'string', description: '路径' } },
      required: ['path'],
    });
    expect(schema?.parameters).not.toHaveProperty('$schema');
  });

  it('derives guidelines only from the tools on offer', () => {
    expect(new ToolRegistry([probe]).guidelines()).toContain('read only');
    expect(new ToolRegistry().guidelines()).toBe('');
  });

  it('lists names in registration order and can answer has()', () => {
    const registry = new ToolRegistry([probe]);
    expect(registry.names()).toEqual(['probe']);
    expect(registry.has('probe')).toBe(true);
    expect(registry.has('other')).toBe(false);
  });
});

describe('argument parsing', () => {
  it('treats absent arguments as an empty object', () => {
    expect(parseToolArguments(undefined)).toEqual({ ok: true, value: {} });
    expect(parseToolArguments('   ')).toEqual({ ok: true, value: {} });
  });

  it('reports malformed JSON as malformed JSON', () => {
    const result = parseToolArguments('{"path":');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not valid JSON');
  });

  it('rejects a non-object payload', () => {
    const result = parseToolArguments('[1,2]');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('JSON object');
  });
});

describe('truncation', () => {
  const lines = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);

  it('keeps the head and reports the delivered range', () => {
    const kept = truncateHead(lines, 4, 10_000);
    expect(kept.text).toContain('line 1');
    expect(kept.text).not.toContain('line 10');
    expect(kept).toMatchObject({ truncated: true, by: 'lines', first: 1, last: 4 });
  });

  it('keeps the tail, which is where failure output lives', () => {
    const kept = truncateTail(lines, 3, 10_000);
    expect(kept.text).toContain('line 10');
    expect(kept.text.startsWith('line 8')).toBe(true);
    expect(kept).toMatchObject({ first: 8, last: 10 });
  });

  it('hard-cuts a single line rather than exceeding the character budget', () => {
    const huge = ['x'.repeat(500)];
    const kept = truncateHead(huge, 10, 100);
    expect(kept.text.length).toBe(100);
    expect(kept.by).toBe('chars');
  });

  it('returns an empty truncation for an empty input', () => {
    expect(truncateHead([], 10, 100)).toMatchObject({ totalLines: 0, keptLines: 0, text: '' });
  });

  it('middle-cuts only for human-facing text and says how much was cut', () => {
    const text = 'a'.repeat(50) + 'b'.repeat(50);
    const middle = truncateMiddle(text, 40);
    expect(middle).toContain('truncated 60 chars');
    expect(middle.length).toBeLessThan(text.length);
  });

  it('bounds one long line', () => {
    const line = 'x'.repeat(20);
    expect(truncateLine(line, 5)).toBe('xxxxx… [+15 chars]');
  });
});
