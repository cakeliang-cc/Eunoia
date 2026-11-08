/**
 * Catalog assembly: atomic publication, bounded paging, deterministic naming and
 * policy classification. A half-built catalog must never be published.
 */

import { describe, expect, it } from 'vitest';
import {
  buildCatalog,
  CatalogBuildError,
  classifyTool,
  collectPages,
  enabledToolCount,
  invalidateCatalog,
} from '../../src/mcp/catalog.ts';
import { DEFAULT_CONFIG_PARSE_OPTIONS, parseServerInput } from '../../src/mcp/config.ts';
import { DEFAULT_MCP_LIMITS, EMPTY_CAPABILITIES } from '../../src/mcp/types.ts';

function config(overrides: Record<string, unknown> = {}) {
  return parseServerInput(
    {
      name: 'Fixture',
      transport: 'stdio',
      stdio: { command: 'node', args: [], runLocation: 'host' },
      ...overrides,
    },
    {
      ...DEFAULT_CONFIG_PARSE_OPTIONS,
      userId: 'user-1',
      allowHostProcess: true,
      newId: () => '11111111-1111-4111-8111-111111111111',
    },
  ).config;
}

function rawTool(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    ...extra,
  };
}

describe('paging', () => {
  it('rejects a repeated cursor instead of looping forever', async () => {
    await expect(
      collectPages({
        maxPages: 10,
        maxItems: 100,
        label: 'tools/list',
        fetchPage: async () => ({ items: [], nextCursor: 'same' }),
      }),
    ).rejects.toThrow(/repeated a pagination cursor/);
  });

  it('stops at the page bound and reports truncation', async () => {
    let page = 0;
    const result = await collectPages({
      maxPages: 3,
      maxItems: 100,
      label: 'tools/list',
      fetchPage: async () => {
        page += 1;
        return { items: [page], nextCursor: `c${page}` };
      },
    });
    expect(result.pages).toBe(3);
    expect(result.truncated).toBe(true);
  });
});

describe('buildCatalog', () => {
  it('namespaces model names and freezes a revision', () => {
    const catalog = buildCatalog({
      config: config(),
      identity: 'stdio|host',
      fetchedAt: new Date('2026-01-01T00:00:00Z'),
      raw: {
        tools: [rawTool('echo')],
        resources: [{ uri: 'fixture://note', name: 'note' }],
        resourceTemplates: [{ uriTemplate: 'fixture://user/{id}', name: 'user' }],
        prompts: [{ name: 'greeting', arguments: [{ name: 'who', required: true }] }],
        instructions: 'external instructions',
        capabilities: { ...EMPTY_CAPABILITIES, tools: true, resources: true, prompts: true },
        protocolRevision: '2025-06-18',
        serverInfo: { name: 'fixture', version: '1' },
      },
    });
    expect(catalog.tools[0]?.modelName.startsWith('mcp__Fixture_')).toBe(true);
    expect(catalog.tools[0]?.contractHash).toHaveLength(64);
    expect(catalog.revision).toHaveLength(64);
    expect(enabledToolCount(catalog)).toBe(1);
    expect(catalog.resources[0]?.uri).toBe('fixture://note');
    expect(catalog.prompts[0]?.arguments[0]?.required).toBe(true);
  });

  it('refuses duplicate original names and oversized schemas', () => {
    expect(() =>
      buildCatalog({
        config: config(),
        identity: 'x',
        fetchedAt: new Date(),
        raw: {
          tools: [rawTool('dup'), rawTool('dup')],
          resources: [],
          resourceTemplates: [],
          prompts: [],
          instructions: null,
          capabilities: EMPTY_CAPABILITIES,
          protocolRevision: null,
          serverInfo: null,
        },
      }),
    ).toThrow(/duplicate tool name/);

    expect(() =>
      buildCatalog({
        config: config({ limits: { maxSchemaBytes: 1024 } }),
        identity: 'x',
        fetchedAt: new Date(),
        raw: {
          tools: [
            rawTool('big', {
              inputSchema: {
                type: 'object',
                properties: { blob: { type: 'string', description: 'x'.repeat(2000) } },
              },
            }),
          ],
          resources: [],
          resourceTemplates: [],
          prompts: [],
          instructions: null,
          capabilities: EMPTY_CAPABILITIES,
          protocolRevision: null,
          serverInfo: null,
        },
      }),
    ).toThrow(/above the 1024 byte limit/);
  });

  it('applies deny before allow and per-tool classification', () => {
    const cfg = config({
      toolPolicy: {
        deny: ['forbidden'],
        allow: ['echo', 'forbidden'],
        tools: { write: { classification: 'external_write' }, echo: { classification: 'external_read' } },
      },
    });
    const catalog = buildCatalog({
      config: cfg,
      identity: 'x',
      fetchedAt: new Date(),
      raw: {
        tools: [rawTool('echo'), rawTool('forbidden'), rawTool('other'), rawTool('write')],
        resources: [],
        resourceTemplates: [],
        prompts: [],
        instructions: null,
        capabilities: EMPTY_CAPABILITIES,
        protocolRevision: null,
        serverInfo: null,
      },
    });
    const byName = Object.fromEntries(catalog.tools.map((tool) => [tool.originalName, tool]));
    expect(byName.echo?.enabled).toBe(true);
    expect(byName.forbidden?.enabled).toBe(false);
    expect(byName.other?.enabled).toBe(false);
    expect(byName.write?.enabled).toBe(false);
  });

  it('never lets a server self-describe into an auto-approval', () => {
    expect(
      classifyTool({}, { name: 'x', annotations: { readOnlyHint: true } }),
    ).toBe('external_unknown');
    expect(
      classifyTool({ trustReadOnlyHint: true }, { name: 'x', annotations: { readOnlyHint: true } }),
    ).toBe('external_read');
    expect(
      classifyTool(
        { trustReadOnlyHint: true },
        { name: 'x', annotations: { readOnlyHint: true, destructiveHint: true } },
      ),
    ).toBe('external_write');
  });

  it('marks a snapshot stale without replacing its tools', () => {
    const catalog = buildCatalog({
      config: config(),
      identity: 'x',
      fetchedAt: new Date(),
      raw: {
        tools: [rawTool('echo')],
        resources: [],
        resourceTemplates: [],
        prompts: [],
        instructions: null,
        capabilities: EMPTY_CAPABILITIES,
        protocolRevision: null,
        serverInfo: null,
      },
    });
    const stale = invalidateCatalog(catalog, 'tools changed', new Date('2026-02-02T00:00:00Z'));
    expect(stale.tools).toEqual(catalog.tools);
    expect(stale.invalidReason).toBe('tools changed');
    expect(stale.invalidatedAt).toBe('2026-02-02T00:00:00.000Z');
  });

  it('has a hard bound on enabled tools', () => {
    const cfg = config({ limits: { maxTools: 1 } });
    expect(() =>
      buildCatalog({
        config: cfg,
        identity: 'x',
        fetchedAt: new Date(),
        raw: {
          tools: [rawTool('a'), rawTool('b')],
          resources: [],
          resourceTemplates: [],
          prompts: [],
          instructions: null,
          capabilities: EMPTY_CAPABILITIES,
          protocolRevision: null,
          serverInfo: null,
        },
      }),
    ).toThrow(CatalogBuildError);
    expect(DEFAULT_MCP_LIMITS.maxTools).toBeGreaterThan(0);
  });
});
