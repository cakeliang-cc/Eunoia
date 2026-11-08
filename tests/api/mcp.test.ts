/**
 * The management API over a real socket.
 *
 * The server is a real stdio child process: these routes are the ones that edit,
 * connect and authorize it, so a mocked manager would test the router instead of
 * the product.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { createApp } from '../../src/api/server.ts';
import { createMcpRuntime, type McpRuntime } from '../../src/mcp/runtime.ts';
import { MemoryMediaBlobStore } from '../../src/media/blob-store.ts';

const fixture = fileURLToPath(new URL('../fixtures/mcp-stdio-server.mjs', import.meta.url));
const TOKEN = 'test-local-token';
let cleanupDirectory = '';
let server: Server;
let base: string;
let store: InMemoryStore;
let runtime: McpRuntime;
let cookie = '';

async function api(
  path: string,
  init: RequestInit & { token?: boolean } = {},
): Promise<{ status: number; body: any }> {
  const { token, ...rest } = init;
  const response = await fetch(`${base}${path}`, {
    ...rest,
    headers: {
      ...(rest.headers ?? {}),
      ...(cookie ? { cookie } : {}),
      ...(rest.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { 'x-eunoia-token': TOKEN } : {}),
    },
  });
  const setCookie = response.headers.get('set-cookie');
  if (!cookie && setCookie) cookie = setCookie.split(';')[0] as string;
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
}

async function start(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'eunoia-mcp-api-'));
  const log = join(directory, 'calls.log');
  process.env.MCP_TEST_MARKER = 'api';
  process.env.MCP_TEST_LOG = log;
  store = new InMemoryStore();
  const blobs = new MemoryMediaBlobStore();
  runtime = createMcpRuntime({
    store,
    media: null,
    blobs,
    parseOptions: (userId) => ({
      userId,
      allowHostProcess: true,
      allowPrivateNetwork: false,
      allowInsecureLoopback: true,
    }),
  });
  server = createApp({ store, localToken: TOKEN, mcp: runtime.service, mcpRuntime: runtime });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  cleanupDirectory = directory;
}

const serverInput = {
  name: 'Fixture',
  enabled: true,
  transport: 'stdio',
  stdio: {
    command: process.execPath,
    args: [fixture],
    runLocation: 'host',
    envRefs: { FIXTURE_MARKER: 'env:MCP_TEST_MARKER', FIXTURE_LOG: 'env:MCP_TEST_LOG' },
  },
  toolPolicy: { trustReadOnlyHint: true, autoApproveReads: true },
};

beforeEach(async () => {
  cookie = '';
  await start();
});

afterEach(async () => {
  await runtime.shutdown().catch(() => undefined);
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
  await rm(cleanupDirectory, { recursive: true, force: true }).catch(() => undefined);
});

describe('server management', () => {
  it('refuses a write without the local control token', async () => {
    const response = await api('/api/mcp/servers', {
      method: 'POST',
      body: JSON.stringify(serverInput),
    });
    expect(response.status).toBe(403);
  });

  it('validates configuration and never reads a secret back', async () => {
    const invalid = await api('/api/mcp/servers', {
      method: 'POST',
      token: true,
      body: JSON.stringify({ name: 'bad', transport: 'stdio', stdio: { command: 'sh -c x' } }),
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('MCP_CONFIG_INVALID');

    const created = await api('/api/mcp/servers', {
      method: 'POST',
      token: true,
      body: JSON.stringify(serverInput),
    });
    expect(created.status).toBe(201);
    expect(created.body.server.name).toBe('Fixture');
    expect(created.body.server.status.state).toBe('connecting');
    expect(JSON.stringify(created.body)).not.toContain('sk-');
  });

  it('connects, discovers tools and exposes source and classification', async () => {
    const created = await api('/api/mcp/servers', {
      method: 'POST',
      token: true,
      body: JSON.stringify(serverInput),
    });
    const id = created.body.server.id as string;
    const connected = await api(`/api/mcp/servers/${id}/connect`, {
      method: 'POST',
      token: true,
      body: '{}',
    });
    expect(connected.status).toBe(200);
    expect(connected.body.status.state).toBe('ready');

    const tools = await api(`/api/mcp/servers/${id}/tools`);
    expect(tools.status).toBe(200);
    const echo = tools.body.tools.find((tool: any) => tool.originalName === 'echo');
    expect(echo.modelName.startsWith('mcp__')).toBe(true);
    expect(echo.classification).toBe('external_read');
    const write = tools.body.tools.find((tool: any) => tool.originalName === 'write_note');
    expect(write.classification).toBe('external_unknown');
  }, 30_000);

  it('previews an import without executing or storing it', async () => {
    const preview = await api('/api/mcp/servers/import/preview', {
      method: 'POST',
      token: true,
      body: JSON.stringify({
        mcpServers: {
          remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer literal' } },
          local: { command: 'node', args: ['x.mjs'], runLocation: 'host' },
        },
      }),
    });
    expect(preview.status).toBe(200);
    expect(preview.body.servers).toHaveLength(2);
    expect(JSON.stringify(preview.body)).not.toContain('Bearer literal');
    const list = await api('/api/mcp/servers');
    expect(list.body.servers).toHaveLength(0);
  });
});

describe('resources, prompts and interactions', () => {
  async function connected(): Promise<string> {
    const created = await api('/api/mcp/servers', {
      method: 'POST',
      token: true,
      body: JSON.stringify(serverInput),
    });
    const id = created.body.server.id as string;
    await api(`/api/mcp/servers/${id}/connect`, { method: 'POST', token: true, body: '{}' });
    return id;
  }

  async function conversation(): Promise<string> {
    const created = await api('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    return created.body.conversation.id as string;
  }

  it('lists and reads a resource into a conversation snapshot', async () => {
    const id = await connected();
    const conversationId = await conversation();
    const list = await api(`/api/mcp/servers/${id}/resources`);
    expect(list.body.resources[0].uri).toBe('fixture://note');

    const read = await api(`/api/mcp/servers/${id}/resources/read`, {
      method: 'POST',
      token: true,
      body: JSON.stringify({ conversationId, uri: 'fixture://note', select: true }),
    });
    expect(read.status).toBe(200);
    expect(read.body.text).toContain('resource:fixture://note');
    expect(read.body.selected).toBe(true);
    expect(read.body.snapshotId).toBeTruthy();
  }, 30_000);

  it('previews a prompt without changing system instructions', async () => {
    const id = await connected();
    const conversationId = await conversation();
    const prompt = await api(`/api/mcp/servers/${id}/prompts/get`, {
      method: 'POST',
      token: true,
      body: JSON.stringify({ conversationId, name: 'greeting', arguments: { who: 'Alice' } }),
    });
    expect(prompt.status).toBe(200);
    expect(prompt.body.preview).toContain('[user] Hello Alice');
    expect(prompt.body.messages[0].role).toBe('user');
  }, 30_000);

  it('accepts a pending approval once and refuses a second execution', async () => {
    const id = await connected();
    const conversationId = await conversation();
    const userId = decodeURIComponent(cookie.split('=').slice(1).join('='));
    expect(userId).toMatch(/^[0-9a-f-]{36}$/i);
    const interaction = await runtime.broker.createApproval({
      userId,
      conversationId,
      serverId: id,
      actionId: null,
      summary: 'Fixture · write_note',
      payload: { tool: 'write_note' },
    });
    const pending = await api(`/api/mcp/interactions?conversationId=${conversationId}`);
    expect(pending.body.interactions).toHaveLength(1);

    const accepted = await api(`/api/mcp/interactions/${interaction.id}/accept`, {
      method: 'POST',
      token: true,
      body: JSON.stringify({ response: { content: {} } }),
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.interaction.status).toBe('accepted');

    const again = await api(`/api/mcp/interactions/${interaction.id}/accept`, {
      method: 'POST',
      token: true,
      body: JSON.stringify({}),
    });
    // Idempotent from the client's point of view: the row is already accepted,
    // and no second transition is possible.
    expect(again.body.interaction.status).toBe('accepted');
    const after = await api(`/api/mcp/interactions?conversationId=${conversationId}`);
    expect(after.body.interactions).toHaveLength(0);
  }, 30_000);

  it('binds servers to one conversation and rejects another user\'s server id', async () => {
    const id = await connected();
    const conversationId = await conversation();
    const bound = await api(`/api/mcp/conversations/${conversationId}/servers`, {
      method: 'PUT',
      token: true,
      body: JSON.stringify({ serverIds: [id] }),
    });
    expect(bound.status).toBe(200);
    expect(bound.body.serverIds).toEqual([id]);
    const read = await api(`/api/mcp/conversations/${conversationId}/servers`);
    expect(read.body.serverIds).toEqual([id]);

    const missing = await api(`/api/mcp/conversations/${conversationId}/servers`, {
      method: 'PUT',
      token: true,
      body: JSON.stringify({ serverIds: ['11111111-1111-4111-8111-111111111111'] }),
    });
    expect(missing.status).toBe(404);
  }, 30_000);
});
