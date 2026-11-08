/**
 * A real turn with an external tool.
 *
 * This is the vertical the acceptance matrix keeps asking for: a scripted model
 * produces a tool call, the host asks the server's real child process, the
 * result is mapped, and — for a call that needs a person — the turn pauses on a
 * persisted approval and resumes the *original* call, not a new model guess.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { SessionService } from '../../src/session/service.ts';
import { MediaService } from '../../src/media/service.ts';
import { MemoryMediaBlobStore } from '../../src/media/blob-store.ts';
import { DEFAULT_MEDIA_LIMITS } from '../../src/media/limits.ts';
import { defaultImagePolicies } from '../../src/provider/image-policy-registry.ts';
import { createMcpRuntime } from '../../src/mcp/runtime.ts';
import { runTurn } from '../../src/service/chat.ts';
import { modelProfile } from '../../src/models/registry.ts';
import type { AgentEvent } from '../../src/agent/events.ts';
import type { LoopInputItem, ModelTurn, ModelTurnEvent } from '../../src/agent/model-port.ts';

const fixture = fileURLToPath(new URL('../fixtures/mcp-stdio-server.mjs', import.meta.url));
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

interface Captured {
  readonly input: readonly LoopInputItem[];
  readonly imageAssetIds: readonly string[];
}

function scripted(steps: readonly { output: ModelTurnEvent[] }[]): {
  turn: ModelTurn;
  captured: Captured[];
} {
  const captured: Captured[] = [];
  let index = 0;
  const turn: ModelTurn = async function* (request) {
    const imageIds: string[] = [];
    for (const item of request.input) {
      if (item.type === 'function_call_result' && item.images) {
        for (const image of item.images) imageIds.push(image.assetId);
      }
      if (item.type === 'message' && typeof item.content !== 'string') {
        for (const part of item.content) if (part.type === 'image') imageIds.push(part.assetId);
      }
    }
    captured.push({ input: request.input, imageAssetIds: imageIds });
    const step = steps[index];
    index += 1;
    if (!step) throw new Error('script ran out of steps');
    for (const event of step.output) yield event;
  };
  return { turn, captured };
}

async function setup(marker: string) {
  const directory = await mkdtemp(join(tmpdir(), 'eunoia-mcp-turn-'));
  const log = join(directory, 'calls.log');
  const store = new InMemoryStore();
  const blobStore = new MemoryMediaBlobStore();
  const media = new MediaService({
    store,
    blobs: blobStore,
    limits: DEFAULT_MEDIA_LIMITS,
  });
  const runtime = createMcpRuntime({
    store,
    media,
    blobs: blobStore,
    parseOptions: (userId) => ({
      userId,
      allowHostProcess: true,
      allowPrivateNetwork: false,
      allowInsecureLoopback: true,
    }),
  });
  cleanups.push(async () => {
    await runtime.shutdown();
    await rm(directory, { recursive: true, force: true });
  });
  process.env.MCP_TEST_MARKER = marker;
  process.env.MCP_TEST_LOG = log;
  const created = await runtime.service.createServer('user-1', {
    name: 'Fixture',
    enabled: true,
    transport: 'stdio',
    stdio: {
      command: process.execPath,
      args: [fixture],
      runLocation: 'host',
      envRefs: { FIXTURE_MARKER: 'env:MCP_TEST_MARKER', FIXTURE_LOG: 'env:MCP_TEST_LOG' },
    },
    toolPolicy: { trustReadOnlyHint: true },
  });
  return { runtime, store, media, log, marker, serverId: created.id };
}

async function* eventsWithApproval(
  events: AsyncIterable<AgentEvent>,
  onApproval: (interactionId: string) => Promise<void>,
): AsyncIterable<AgentEvent> {
  for await (const event of events) {
    if (event.type === 'approval_required') {
      await onApproval(event.interactionId);
    }
    yield event;
  }
}

describe('a turn with an MCP tool', () => {
  it('runs the external call and feeds its result back to the model', async () => {
    const setupResult = await setup('direct');
    const { runtime, media, serverId } = setupResult;
    // Reads are still approved by default; this test is about the call path, so
    // the person's policy auto-approves reads.
    const current = await runtime.service.getServer('user-1', serverId);
    await runtime.service.updateServer('user-1', serverId, {
      name: current.name,
      enabled: true,
      transport: 'stdio',
      stdio: {
        command: process.execPath,
        args: [fixture],
        runLocation: 'host',
        envRefs: { FIXTURE_MARKER: 'env:MCP_TEST_MARKER', FIXTURE_LOG: 'env:MCP_TEST_LOG' },
      },
      toolPolicy: { trustReadOnlyHint: true, autoApproveReads: true },
      configRevision: current.configRevision,
    });
    const status = await runtime.service.connect('user-1', serverId);
    if (status.state !== 'ready') throw new Error(`connect failed: ${JSON.stringify(status)}`);
    const view = await runtime.service.getServer('user-1', serverId);
    const echo = view.tools.find((tool) => tool.originalName === 'echo');
    if (!echo) throw new Error('echo tool missing');

    const { turn, captured } = scripted([
      {
        output: [
          {
            type: 'done',
            output: [
              {
                type: 'function_call',
                callId: 'call-echo',
                name: echo.modelName,
                arguments: JSON.stringify({ text: 'hello' }),
              },
            ],
          },
        ],
      },
      { output: [{ type: 'done', output: [{ type: 'message', role: 'assistant', content: 'done' }] }] },
    ]);

    const base = new InMemoryStore();
    const session = new SessionService(base);
    const turnEvents: AgentEvent[] = [];
    for await (const event of runTurn(
      {
        store: base,
        session,
        media,
        imagePolicies: defaultImagePolicies(),
        mediaLimits: DEFAULT_MEDIA_LIMITS,
        modelTurn: turn,
        modelProfileFor: () => modelProfile('deepseek-flash'),
        mcp: runtime.service,
        toolPolicy: { allowWorkspaceWrites: false, allowCommands: false, maxOutputChars: 20_000 },
        sessionConfig: { promptReserveTokens: 400 } as never,
      },
      {
        userId: 'user-1',
        message: 'go',
        persist: false,
      },
    )) {
      turnEvents.push(event);
    }
    const result = turnEvents.find((event) => event.type === 'tool_result');
    expect(result?.type).toBe('tool_result');
    if (result?.type === 'tool_result') {
      expect(result.ok).toBe(true);
      expect(result.source).toBe('mcp');
      expect(result.originLabel).toContain('Fixture');
    }
    const completed = turnEvents.find((event) => event.type === 'completed');
    expect(completed?.type).toBe('completed');
    // The second model step really saw the tool's output.
    expect(captured).toHaveLength(2);
    const toolResult = captured[1]?.input.find((item) => item.type === 'function_call_result');
    expect(toolResult && 'output' in toolResult ? toolResult.output : '').toContain('echo:hello');
  }, 40_000);

  it('pauses for approval and runs the same action exactly once', async () => {
    const { runtime, media, serverId } = await setup('approval');
    const status = await runtime.service.connect('user-1', serverId);
    if (status.state !== 'ready') throw new Error(`connect failed: ${JSON.stringify(status)}`);
    const view = await runtime.service.getServer('user-1', serverId);
    const write = view.tools.find((tool) => tool.originalName === 'write_note');
    if (!write) throw new Error('write tool missing');
    // Without a policy or a destructive hint the host cannot classify the
    // effect, so it asks rather than trusting the description.
    expect(write.classification).toBe('external_unknown');

    const { turn, captured } = scripted([
      {
        output: [
          {
            type: 'done',
            output: [
              {
                type: 'function_call',
                callId: 'call-write',
                name: write.modelName,
                arguments: JSON.stringify({ text: 'note' }),
              },
            ],
          },
        ],
      },
      { output: [{ type: 'done', output: [{ type: 'message', role: 'assistant', content: 'ok' }] }] },
    ]);

    const base = new InMemoryStore();
    const session = new SessionService(base);
    const seen: AgentEvent[] = [];
    let interactions = 0;
    const stream = eventsWithApproval(
      runTurn(
        {
          store: base,
          session,
          media,
          imagePolicies: defaultImagePolicies(),
          mediaLimits: DEFAULT_MEDIA_LIMITS,
          modelTurn: turn,
          modelProfileFor: () => modelProfile('deepseek-flash'),
          mcp: runtime.service,
          toolPolicy: { allowWorkspaceWrites: false, allowCommands: false, maxOutputChars: 20_000 },
          sessionConfig: { promptReserveTokens: 400 } as never,
        },
        { userId: 'user-1', message: 'write it', persist: false },
      ),
      async (interactionId) => {
        interactions += 1;
        await runtime.service.resolveInteraction({
          userId: 'user-1',
          interactionId,
          action: 'accept',
        });
      },
    );
    for await (const event of stream) seen.push(event);

    expect(interactions).toBe(1);
    expect(seen.some((event) => event.type === 'approval_required')).toBe(true);
    const result = seen.find((event) => event.type === 'tool_result');
    expect(result?.type).toBe('tool_result');
    if (result?.type === 'tool_result') expect(result.ok).toBe(true);
    expect(captured).toHaveLength(2);
    const callLog = await readFile(process.env.MCP_TEST_LOG ?? '', 'utf8').catch(() => '');
    expect(callLog.split('\n').filter((line) => line.includes('write_note'))).toHaveLength(1);
  }, 40_000);

  it('maps tool images to private assets and re-plans media for the next step', async () => {
    const { runtime, media, serverId } = await setup('images');
    const current = await runtime.service.getServer('user-1', serverId);
    await runtime.service.updateServer('user-1', serverId, {
      name: current.name,
      enabled: true,
      transport: 'stdio',
      stdio: {
        command: process.execPath,
        args: [fixture],
        runLocation: 'host',
        envRefs: { FIXTURE_MARKER: 'env:MCP_TEST_MARKER', FIXTURE_LOG: 'env:MCP_TEST_LOG' },
      },
      toolPolicy: { trustReadOnlyHint: true, autoApproveReads: true },
      configRevision: current.configRevision,
    });
    const status = await runtime.service.connect('user-1', serverId);
    if (status.state !== 'ready') throw new Error(`connect failed: ${JSON.stringify(status)}`);
    const view = await runtime.service.getServer('user-1', serverId);
    const imageTool = view.tools.find((tool) => tool.originalName === 'image');
    if (!imageTool) throw new Error('image tool missing');

    const { turn, captured } = scripted([
      {
        output: [
          {
            type: 'done',
            output: [
              {
                type: 'function_call',
                callId: 'call-image',
                name: imageTool.modelName,
                arguments: '{}',
              },
            ],
          },
        ],
      },
      { output: [{ type: 'done', output: [{ type: 'message', role: 'assistant', content: 'saw it' }] }] },
    ]);

    const base = new InMemoryStore();
    const session = new SessionService(base);
    const events: AgentEvent[] = [];
    for await (const event of runTurn(
      {
        store: base,
        session,
        media,
        imagePolicies: defaultImagePolicies(),
        mediaLimits: DEFAULT_MEDIA_LIMITS,
        modelTurn: turn,
        modelProfileFor: () => modelProfile('deepseek-flash'),
        mcp: runtime.service,
        toolPolicy: { allowWorkspaceWrites: false, allowCommands: false, maxOutputChars: 20_000 },
        sessionConfig: { promptReserveTokens: 400 } as never,
      },
      { userId: 'user-1', message: 'show me', persist: false },
    )) {
      events.push(event);
    }
    const result = events.find((event) => event.type === 'tool_result');
    expect(result?.type).toBe('tool_result');
    if (result?.type === 'tool_result') expect(result.images).toBe(2);
    // The second request carries the imported assets, not filenames.
    expect(captured).toHaveLength(2);
    expect(captured[1]?.imageAssetIds).toHaveLength(2);
    const assetId = captured[1]?.imageAssetIds[0];
    expect(assetId).toBeTruthy();
    const preview = await media.readPreview('user-1', assetId as string);
    expect(preview.asset.status).toBe('bound');
  }, 40_000);
});
