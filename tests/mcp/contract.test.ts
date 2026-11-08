/**
 * The unified contract.
 *
 * These are the properties the MCP adapter depends on: the schema the model sees
 * and the validator that runs are one pair, local references resolve, remote
 * references are refused, and a name that had to be shortened keeps a digest so
 * two servers cannot collide.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  canonicalJson,
  contractHashOf,
  createJsonSchemaValidator,
  MAX_TOOL_NAME_LENGTH,
  mcpContract,
  mcpModelToolName,
  normalizeJsonSchema,
  serverSlug,
  sha256,
  ToolContractError,
  zodContract,
} from '../../src/tools/contract.ts';

const origin = {
  serverId: '11111111-1111-4111-8111-111111111111',
  serverName: 'Fixture Server',
  originalName: 'echo',
  catalogRevision: 'rev-1',
  classification: 'external_read' as const,
};

describe('JSON Schema validation', () => {
  it('keeps nested objects, arrays, required, enum and numeric constraints', () => {
    const contract = mcpContract({
      name: 'mcp__f__echo',
      description: 'echo',
      origin,
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 5 },
          tags: { type: 'array', items: { type: 'string' }, minItems: 1 },
          mode: { type: 'string', enum: ['a', 'b'] },
          nested: {
            type: 'object',
            properties: { count: { type: 'number', minimum: 1 } },
            required: ['count'],
          },
          either: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        },
        required: ['name'],
        additionalProperties: false,
      },
    });

    expect(contract.validate({ name: 'ok', tags: ['x'], mode: 'a', nested: { count: 2 }, either: 3 }).ok).toBe(true);
    for (const bad of [
      {},
      { name: 'way-too-long' },
      { name: 'ok', tags: [] },
      { name: 'ok', mode: 'c' },
      { name: 'ok', nested: {} },
      { name: 'ok', nested: { count: 0 } },
      { name: 'ok', either: true },
      { name: 'ok', extra: true },
    ]) {
      const check = contract.validate(bad);
      expect(check.ok, JSON.stringify(bad)).toBe(false);
      if (!check.ok) expect(check.issues.length).toBeGreaterThan(0);
    }
  });

  it('resolves a local $ref and rejects a remote one without fetching', () => {
    const local = mcpContract({
      name: 'mcp__f__local',
      description: '',
      origin,
      inputSchema: {
        type: 'object',
        properties: { item: { $ref: '#/$defs/item' } },
        required: ['item'],
        $defs: { item: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      },
    });
    expect(local.validate({ item: { id: 'x' } }).ok).toBe(true);
    expect(local.validate({ item: {} }).ok).toBe(false);

    expect(() =>
      mcpContract({
        name: 'mcp__f__remote',
        description: '',
        origin,
        inputSchema: {
          type: 'object',
          properties: { a: { $ref: 'https://example.invalid/schema.json' } },
        },
      }),
    ).toThrow(/remote \$ref/);
  });

  it('diagnoses a keyword it cannot enforce instead of ignoring it', () => {
    expect(() =>
      normalizeJsonSchema({
        type: 'object',
        unevaluatedProperties: false,
      }),
    ).toThrow(ToolContractError);
  });

  it('normalizes 2020-12 prefixItems without losing positional constraints', () => {
    const { schema, notes } = normalizeJsonSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        pair: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }] },
      },
    });
    expect(notes.length).toBeGreaterThan(0);
    const validate = createJsonSchemaValidator(schema);
    expect(validate({ pair: ['a', 1] }).ok).toBe(true);
    expect(validate({ pair: [1, 'a'] }).ok).toBe(false);
  });

  it('accepts an empty object for a tool with no parameters', () => {
    const contract = mcpContract({
      name: 'mcp__f__noargs',
      description: '',
      origin,
      inputSchema: { type: 'object', properties: {} },
    });
    expect(contract.validate({}).ok).toBe(true);
  });

  it('produces a stable digest and changes it when the schema changes', () => {
    const a = contractHashOf({ name: 't', description: 'd', source: 'mcp', inputSchema: { type: 'object' } });
    const b = contractHashOf({ name: 't', description: 'd', source: 'mcp', inputSchema: { type: 'object' } });
    const c = contractHashOf({
      name: 't',
      description: 'd',
      source: 'mcp',
      inputSchema: { type: 'object', required: ['x'] },
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(sha256('x')).toHaveLength(64);
  });
});

describe('builtin contracts', () => {
  it('derives the model schema from the same Zod parser', () => {
    const contract = zodContract({
      name: 'read_file',
      description: 'read',
      parameters: z.object({ path: z.string().min(1) }),
    });
    expect(contract.source).toBe('builtin');
    expect(contract.inputSchema).toMatchObject({ type: 'object', required: ['path'] });
    expect(contract.validate({ path: 'a.ts' }).ok).toBe(true);
    expect(contract.validate({ path: '' }).ok).toBe(false);
  });
});

describe('tool naming', () => {
  it('namespaces by a stable server slug, not by a self-reported name alone', () => {
    const name = mcpModelToolName({ serverId: origin.serverId, serverName: 'GitHub', originalName: 'create_issue' });
    expect(name.startsWith('mcp__GitHub_')).toBe(true);
    expect(name.endsWith('__create_issue')).toBe(true);
    expect(serverSlug(origin.serverId, 'GitHub')).toBe(serverSlug(origin.serverId, 'GitHub'));
    expect(serverSlug('other-id', 'GitHub')).not.toBe(serverSlug(origin.serverId, 'GitHub'));
  });

  it('keeps a digest suffix when truncation is required', () => {
    const long = mcpModelToolName({
      serverId: origin.serverId,
      serverName: 'Server',
      originalName: 'x'.repeat(120),
    });
    expect(long.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
    expect(long).toMatch(/__[0-9a-f]{8}$/);
    const other = mcpModelToolName({
      serverId: origin.serverId,
      serverName: 'Server',
      originalName: `${'x'.repeat(119)}y`,
    });
    expect(other).not.toBe(long);
  });

  it('sanitises characters a provider may reject', () => {
    const name = mcpModelToolName({
      serverId: origin.serverId,
      serverName: 'My 服务',
      originalName: 'do/thing',
    });
    expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
