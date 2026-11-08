/**
 * R02 — a member's MCP ceiling is enforced before a byte leaves the process.
 *
 * The fixture is a real stdio MCP server; every call it receives is appended to
 * a log. A refusal that merely returns a string while the server still ran the
 * command would fail these assertions, because the count would not be zero.
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
import { McpPermissionPort } from '../../src/mcp/permissions.ts';
import { InteractionBroker } from '../../src/mcp/interactions.ts';
import {
  guardToolForScope,
  memberExecutionScope,
  rootExecutionScope,
  scopeFingerprint,
} from '../../src/tools/scope.ts';
import type { ExecutionScope } from '../../src/tools/scope.ts';
import { defineTool } from '../../src/tools/types.ts';
import { z } from 'zod';

const fixture = fileURLToPath(new URL('../fixtures/mcp-stdio-server.mjs', import.meta.url));
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'eunoia-scope-'));
  const log = join(directory, 'calls.log');
  const marker = `scope-${randomUUID()}`;
  const env = { ...process.env, MCP_TEST_MARKER: marker, MCP_TEST_LOG: log };
  const parsed = parseServerInput(
    {
      name: 'ScopeFixture',
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
      toolPolicy: {
        trustReadOnlyHint: true,
        tools: {
          write_note: { classification: 'external_write' },
          remote_exec: { classification: 'external_unknown' },
          fetch_url: { classification: 'external_read' },
          read_path: { classification: 'external_read' },
        },
      },
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
    connect: (options) =>
      import('../../src/mcp/client.ts').then(({ McpConnection }) =>
        McpConnection.open({ ...options, env }),
      ),
  });
  await store.insertMcpServer(parsed.config);
  const broker = new InteractionBroker({ store, now: () => new Date() });
  const port = new McpPermissionPort({ store, broker });
  await manager.connect('user-1', parsed.config.id);
  const catalog = await manager.catalog('user-1', parsed.config.id);
  if (!catalog) throw new Error('no catalog');
  cleanups.push(async () => {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  });
  return { manager, store, broker, port, config: parsed.config, catalog, log };
}

async function calls(path: string): Promise<Array<Record<string, unknown>>> {
  try {
    const text = await readFile(path, 'utf8');
    return text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry['event'] === 'side-effect' || entry['event'] === 'tools/call');
  } catch {
    return [];
  }
}

function member(overrides: {
  permissions?: Record<string, unknown>;
  parent?: ExecutionScope['capabilities'];
} = {}): ExecutionScope {
  const root = rootExecutionScope({ userId: 'user-1', conversationId: 'conv-1' });
  return memberExecutionScope({
    userId: 'user-1',
    conversationId: 'conv-1',
    teamId: 'team-1',
    runId: 'run-1',
    memberId: 'member-1',
    activationId: 'activation-1',
    generation: 1,
    permissions: {
      allowWorkspaceWrites: false,
      allowCommands: false,
      allowedTools: null,
      ...(overrides.permissions ?? {}),
    },
    ...(overrides.parent ? { parent: overrides.parent } : { parent: root.capabilities }),
  });
}

function request(
  scope: ExecutionScope,
  config: { id: string },
  catalog: { tools: readonly { originalName: string; contractHash: string }[] },
  name: string,
  args: Record<string, unknown>,
) {
  const entry = catalog.tools.find((tool) => tool.originalName === name);
  if (!entry) throw new Error(`no tool ${name}`);
  return {
    tool: defineTool({
      name: `mcp__fixture__${name}`,
      description: 'fixture',
      parameters: z.object({}),
      sideEffect: 'external_read',
      readOnly: true,
      async execute() {
        return { ok: true, output: 'unused' };
      },
    }),
    contract: {
      name: `mcp__fixture__${name}`,
      description: 'fixture',
      inputSchema: {},
      source: 'mcp' as const,
      contractHash: entry.contractHash,
      origin: {
        kind: 'mcp' as const,
        serverId: config.id,
        originalName: name,
        classification:
          name === 'write_note'
            ? ('external_write' as const)
            : name === 'remote_exec'
              ? ('external_unknown' as const)
              : ('external_read' as const),
        catalogRevision: 'rev',
      },
    },
    args,
    callId: `call-${name}`,
    userId: 'user-1',
    conversationId: 'conv-1',
    summary: name,
    scope,
  } as never;
}

describe('R02 — member MCP ceiling', () => {
  it('refuses a remote command for a member without external-unknown permission, with zero server calls', async () => {
    const h = await setup();
    const scope = member({ permissions: { mcp: { servers: [h.config.id], tools: null } } });
    const decision = await h.port.decide(
      request(scope, h.config, h.catalog, 'remote_exec', { command: 'rm -rf /workspace' }),
    );
    expect(decision.kind).toBe('deny');
    if (decision.kind === 'deny') expect(decision.reason).toContain('无法被本地约束');
    expect(await calls(h.log)).toHaveLength(0);
  }, 30_000);

  it('refuses an external write for a read-only member, with zero server calls', async () => {
    const h = await setup();
    const scope = member({ permissions: { mcp: { servers: [h.config.id], tools: null } } });
    const decision = await h.port.decide(
      request(scope, h.config, h.catalog, 'write_note', { text: 'x' }),
    );
    expect(decision.kind).toBe('deny');
    expect(await calls(h.log)).toHaveLength(0);
  }, 30_000);

  it('refuses a URL outside the member allowlist and a path outside /workspace', async () => {
    const h = await setup();
    const scope = member({
      permissions: {
        mcp: {
          servers: [h.config.id],
          tools: ['fetch_url', 'read_path'],
          externalWrite: true,
        },
      },
      parent: {
        ...rootExecutionScope({ userId: 'user-1', conversationId: 'conv-1' }).capabilities,
        network: { mode: 'allowlist', domains: ['api.example.com'], ports: [443] },
      },
    });
    const badUrl = await h.port.decide(
      request(scope, h.config, h.catalog, 'fetch_url', { url: 'https://evil.example/x' }),
    );
    expect(badUrl.kind).toBe('deny');
    const badPath = await h.port.decide(
      request(scope, h.config, h.catalog, 'read_path', { path: '/etc/passwd' }),
    );
    expect(badPath.kind).toBe('deny');
    expect(await calls(h.log)).toHaveLength(0);
  }, 30_000);

  it('allows an authorised read once, records member/generation on the approval, and calls the server once', async () => {
    const h = await setup();
    const scope = member({
      permissions: {
        mcp: {
          servers: [h.config.id],
          tools: ['fetch_url'],
          externalWrite: false,
        },
      },
    });
    const decision = await h.port.decide(
      request(scope, h.config, h.catalog, 'fetch_url', { url: 'https://api.example.com/data' }),
    );
    expect(decision.kind).toBe('wait');
    if (decision.kind !== 'wait') return;
    const interaction = await h.store.getMcpInteraction('user-1', decision.interactionId);
    const payload = interaction?.payload as Record<string, unknown> | undefined;
    expect(payload?.['execution']).toMatchObject({
      role: 'member',
      memberId: 'member-1',
      generation: 1,
      scopeFingerprint: scopeFingerprint(scope),
    });
    await h.broker.resolve({
      userId: 'user-1',
      interactionId: decision.interactionId,
      status: 'accepted',
    });
    const entry = h.catalog.tools.find((tool) => tool.originalName === 'fetch_url');
    const mapped = await h.manager.callTool({
      userId: 'user-1',
      serverId: h.config.id,
      originalName: 'fetch_url',
      arguments: { url: 'https://api.example.com/data' },
      catalogRevision: h.catalog.revision,
      contractHash: entry?.contractHash ?? '',
      actionId: decision.actionId ?? '',
      conversationId: 'conv-1',
      identity: h.catalog.identity,
    });
    expect(mapped.result.ok).toBe(true);
    const recorded = await calls(h.log);
    expect(recorded.filter((call) => call['event'] === 'side-effect')).toHaveLength(1);
  }, 30_000);

  it('a tool handle whose generation changed cannot execute', async () => {
    const h = await setup();
    const scope = member({ permissions: { mcp: { servers: [h.config.id] } } });
    const guarded = guardToolForScope(
      defineTool({
        name: 'remote_exec',
        description: 'x',
        parameters: z.object({ command: z.string() }),
        sideEffect: 'external_unknown',
        readOnly: false,
        async execute() {
          return { ok: true, output: 'ran' };
        },
      }),
      scope,
      async () => {
        const next = member({ permissions: { mcp: { servers: [h.config.id] } } });
        return { ...next, identity: { ...next.identity, generation: 2 } };
      },
    );
    const result = await guarded.execute({ command: 'echo' }, {} as never);
    expect(result.ok).toBe(false);
    expect(result.meta?.['code']).toBe('EXECUTION_SCOPE_CHANGED');
    expect(await calls(h.log)).toHaveLength(0);
  }, 30_000);
});
