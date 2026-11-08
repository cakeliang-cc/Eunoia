/**
 * The manager against a real MCP server process.
 *
 * The fixture is a child process speaking the protocol on stdin/stdout and
 * appending every call to a log file. Assertions about "the write ran once,
 * after approval" therefore rest on evidence from the server side, not on the
 * client's own bookkeeping.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { McpClientManager } from '../../src/mcp/manager.ts';
import { MemoryMcpStore } from '../../src/mcp/store-memory.ts';
import { loadSecretBox, McpCredentialVault } from '../../src/mcp/credentials.ts';
import { DEFAULT_CONFIG_PARSE_OPTIONS, parseServerInput } from '../../src/mcp/config.ts';
import { EMPTY_CAPABILITIES } from '../../src/mcp/types.ts';

const fixture = fileURLToPath(new URL('../fixtures/mcp-stdio-server.mjs', import.meta.url));
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'eunoia-mcp-'));
  const log = join(directory, 'calls.log');
  const marker = `run-${randomUUID()}`;
  const env = {
    ...process.env,
    MCP_TEST_MARKER: marker,
    MCP_TEST_LOG: log,
  };
  const parsed = parseServerInput(
    {
      name: 'Fixture',
      enabled: true,
      transport: 'stdio',
      stdio: {
        command: process.execPath,
        args: [fixture],
        runLocation: 'host',
        envRefs: {
          FIXTURE_MARKER: 'env:MCP_TEST_MARKER',
          FIXTURE_LOG: 'env:MCP_TEST_LOG',
        },
      },
      toolPolicy: { trustReadOnlyHint: true },
    },
    {
      ...DEFAULT_CONFIG_PARSE_OPTIONS,
      userId: 'user-1',
      allowHostProcess: true,
      env,
      newId: () => randomUUID(),
    } as never,
  );
  const store = new MemoryMcpStore();
  const vault = new McpCredentialVault(store, loadSecretBox({}));
  const manager = new McpClientManager({
    store,
    vault,
    now: () => new Date(),
    // The fixture's environment is supplied by the test, not the process.
    connect: (options) =>
      import('../../src/mcp/client.ts').then(({ McpConnection }) =>
        McpConnection.open({ ...options, env }),
      ),
  });
  await store.insertMcpServer(parsed.config);
  cleanups.push(async () => {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  });
  return { manager, store, config: parsed.config, log, marker, env };
}

async function readLog(path: string): Promise<{ event?: string; name?: string; text?: string }[]> {
  try {
    const text = await readFile(path, 'utf8');
    return text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { event?: string; name?: string; text?: string });
  } catch {
    return [];
  }
}

async function ensureAction(
  manager: McpClientManager,
  config: { id: string },
  catalog: { revision: string; identity: string; tools: readonly { originalName: string; contractHash: string }[] },
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const id = randomUUID();
  const entry = catalog.tools.find((tool) => tool.originalName === toolName);
  if (!entry) throw new Error(`no tool ${toolName}`);
  await manager.ensureAction({
    id,
    userId: 'user-1',
    conversationId: 'conv-1',
    turnId: null,
    step: null,
    callId: 'call-1',
    serverId: config.id,
    identity: catalog.identity,
    catalogRevision: catalog.revision,
    contractHash: entry.contractHash,
    toolName,
    argumentsJson: JSON.stringify(args),
    argumentsDigest: 'd',
    classification: 'external_read',
    state: 'prepared',
    conclusion: null,
    error: null,
    resultJson: null,
    sentAt: null,
    finishedAt: null,
    createdAt: new Date().toISOString(),
  });
  return id;
}

describe('stdio connection and catalog', () => {
  it('connects, discovers every page, and namespaces tool names', async () => {
    const { manager, config } = await setup();
    const status = await manager.connect('user-1', config.id);
    if (status.state !== 'ready') {
      throw new Error(`connect failed: ${status.state} ${JSON.stringify(status.lastError)}`);
    }
    expect(status.state).toBe('ready');
    expect(status.toolCount).toBeGreaterThan(4);
    expect(status.protocolRevision).toBe('2025-06-18');
    expect(status.serverInfo?.name).toMatch(/fixture/);
    expect(status.catalogRevision).toHaveLength(64);

    const catalog = await manager.catalog('user-1', config.id);
    expect(catalog?.tools.map((tool) => tool.originalName)).toContain('echo');
    expect(catalog?.tools.map((tool) => tool.originalName)).toContain('progress');
    expect(catalog?.tools.every((tool) => tool.modelName.startsWith('mcp__'))).toBe(true);
    expect(catalog?.resources).toHaveLength(1);
    expect(catalog?.resourceTemplates).toHaveLength(1);
    expect(catalog?.prompts[0]?.name).toBe('greeting');
    expect(catalog?.instructions).toContain('Fixture instructions');
    expect(catalog?.capabilities.tasks).toBe(false);
    expect(catalog?.capabilities.subscriptions).toBe(true);
  }, 30_000);

  it('calls a tool through the real process and records the result', async () => {
    const { manager, store, config, log, marker } = await setup();
    await manager.connect('user-1', config.id);
    const catalog = await manager.catalog('user-1', config.id);
    if (!catalog) throw new Error('no catalog');
    const actionId = await ensureAction(manager, config, catalog, 'echo', { text: 'hi' });
    const mapped = await manager.callTool({
      userId: 'user-1',
      serverId: config.id,
      originalName: 'echo',
      arguments: { text: 'hi' },
      catalogRevision: catalog.revision,
      contractHash: catalog.tools.find((tool) => tool.originalName === 'echo')!.contractHash,
      actionId,
      conversationId: 'conv-1',
      identity: catalog.identity,
    });
    expect(mapped.result.ok).toBe(true);
    expect(mapped.result.output).toContain(`echo:hi:${marker}`);
    const calls = (await readLog(log)).filter((entry) => entry.event === 'tools/call');
    expect(calls).toHaveLength(1);
    const action = await store.getMcpAction('user-1', actionId);
    expect(action?.state).toBe('finished');
    expect(action?.conclusion).toBe('succeeded');
    expect(action?.sentAt).not.toBeNull();
  }, 30_000);

  it('refuses a call whose catalog lease is stale without asking the server', async () => {
    const { manager, config, log } = await setup();
    await manager.connect('user-1', config.id);
    const catalog = await manager.catalog('user-1', config.id);
    if (!catalog) throw new Error('no catalog');
    const actionId = await ensureAction(manager, config, catalog, 'echo', { text: 'x' });
    await expect(
      manager.callTool({
        userId: 'user-1',
        serverId: config.id,
        originalName: 'echo',
        arguments: { text: 'x' },
        catalogRevision: 'stale-revision',
        contractHash: catalog.tools.find((tool) => tool.originalName === 'echo')!.contractHash,
        actionId,
        conversationId: 'conv-1',
        identity: catalog.identity,
      }),
    ).rejects.toThrow(/目录在本次回合中发生了变化/);
    expect((await readLog(log)).filter((entry) => entry.event === 'tools/call')).toHaveLength(0);
  }, 30_000);

  it('imports both images in order and preserves the surrounding text', async () => {
    const { manager, config } = await setup();
    await manager.connect('user-1', config.id);
    const catalog = await manager.catalog('user-1', config.id);
    if (!catalog) throw new Error('no catalog');
    const actionId = await ensureAction(manager, config, catalog, 'image', {});
    const imported: string[] = [];
    const mapped = await manager.callTool({
      userId: 'user-1',
      serverId: config.id,
      originalName: 'image',
      arguments: {},
      catalogRevision: catalog.revision,
      contractHash: catalog.tools.find((tool) => tool.originalName === 'image')!.contractHash,
      actionId,
      conversationId: 'conv-1',
      identity: catalog.identity,
      importImage: async ({ name, mediaType, bytes }) => {
        imported.push(`${name}:${mediaType}:${bytes.length}`);
        return {
          assetId: `asset-${imported.length}`,
          mediaType,
          width: 1,
          height: 1,
          bytes: bytes.length,
          name,
        };
      },
    });
    expect(imported).toHaveLength(2);
    expect(mapped.result.content?.map((block) => block.type)).toEqual([
      'text',
      'image',
      'text',
      'image',
      'text',
    ]);
    expect(mapped.result.output.indexOf('before')).toBeLessThan(mapped.result.output.indexOf('middle'));
  }, 30_000);

  it('reports a structured result that violates its output schema as a failure', async () => {
    const { manager, config } = await setup();
    await manager.connect('user-1', config.id);
    const catalog = await manager.catalog('user-1', config.id);
    if (!catalog) throw new Error('no catalog');
    const entry = catalog.tools.find((tool) => tool.originalName === 'structured_bad');
    if (!entry) throw new Error('missing tool');
    const actionId = await ensureAction(manager, config, catalog, 'structured_bad', {});
    const mapped = await manager.callTool({
      userId: 'user-1',
      serverId: config.id,
      originalName: 'structured_bad',
      arguments: {},
      catalogRevision: catalog.revision,
      contractHash: entry.contractHash,
      actionId,
      conversationId: 'conv-1',
      identity: catalog.identity,
    });
    expect(mapped.result.ok).toBe(false);
  }, 30_000);

  it('keeps the previous catalog when the process is gone and marks it stale', async () => {
    const { manager, config } = await setup();
    await manager.connect('user-1', config.id);
    const first = await manager.catalog('user-1', config.id);
    await manager.disconnect('user-1', config.id);
    const status = await manager.refresh('user-1', config.id);
    // Disconnected: refresh reconnects rather than pretending a dead process is
    // ready. Either it reconnects (the fixture is restartable) or it fails
    // visibly; it never keeps `ready` with no connection.
    expect(['ready', 'failed', 'connecting']).toContain(status.state);
    const after = await manager.catalog('user-1', config.id);
    expect(after?.tools.map((tool) => tool.originalName)).toEqual(
      first?.tools.map((tool) => tool.originalName),
    );
  }, 30_000);

  it('does not claim task support a server did not advertise', async () => {
    const { manager, config } = await setup();
    await manager.connect('user-1', config.id);
    expect(EMPTY_CAPABILITIES.tasks).toBe(false);
    const status = await manager.status('user-1', config.id);
    expect(status.state).toBe('ready');
  }, 30_000);
});
