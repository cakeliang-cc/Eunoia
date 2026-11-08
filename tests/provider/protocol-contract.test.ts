/**
 * Protocol contract: two provider configurations, two real wire protocols.
 *
 * Every test here starts a `node:http` fixture on an ephemeral port and drives
 * the production adapter (`createSdkModelTurn` through `providerFor`) against
 * it. The fixtures keep the exact request bodies and headers, so the assertions
 * are about what went over the wire, not about a stub's return value.
 *
 * What this proves: both protocols produce the same product-level `ModelTurn`
 * events while their captured requests differ in the way each protocol
 * requires. What it does not prove: that a real second vendor accepts these
 * frames. That is a separate, credential-gated smoke test.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runAgentLoop } from '../../src/agent/loop.ts';
import type { AgentEvent } from '../../src/agent/events.ts';
import type {
  LoopInputItem,
  ModelTurnEvent,
  ModelTurnRequest,
  ModelUsage,
} from '../../src/agent/model-port.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';
import { TurnReadLedger } from '../../src/tools/ledger.ts';
import { DEFAULT_TOOL_POLICY, defineTool, toolOk } from '../../src/tools/types.ts';
import type { ToolContext, ToolSchema } from '../../src/tools/types.ts';
import {
  arrayOf,
  bodyOf,
  closeFixtureProviders,
  fixtureTurn,
  normalizeOutput,
  registerFixtureProvider,
} from '../helpers/protocol.ts';
import {
  startProtocolFixture,
  type ProtocolFixture,
  type ReplyPlan,
} from '../fixtures/protocol-servers.ts';

const TOOLS: readonly ToolSchema[] = [
  {
    name: 'read_thing',
    description: 'read a thing',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
];

const HISTORY: readonly LoopInputItem[] = [
  { type: 'message', role: 'user', content: '看一下 a.ts' },
  { type: 'message', role: 'assistant', content: '我先读。' },
  { type: 'function_call', callId: 'call_1', name: 'read_thing', arguments: '{"name":"a.ts"}' },
  {
    type: 'function_call_result',
    callId: 'call_1',
    name: 'read_thing',
    output: 'content of a.ts',
  },
  { type: 'message', role: 'user', content: '继续' },
];

const INSTRUCTIONS = '你是验收用助手。';

async function collect(events: AsyncIterable<ModelTurnEvent>): Promise<ModelTurnEvent[]> {
  const out: ModelTurnEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function collectAgent(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function doneOf(events: readonly ModelTurnEvent[]): Extract<ModelTurnEvent, { type: 'done' }> {
  const done = events.find((event) => event.type === 'done');
  if (!done || done.type !== 'done') throw new Error('no done event');
  return done;
}

function usageOf(events: readonly ModelTurnEvent[]): ModelUsage | undefined {
  return doneOf(events).usage;
}

async function withFixture<T>(
  options: Parameters<typeof startProtocolFixture>[0],
  body: (fixture: ProtocolFixture, turn: Awaited<ReturnType<typeof fixtureTurn>>) => Promise<T>,
): Promise<T> {
  const fixture = await startProtocolFixture(options);
  const handle = registerFixtureProvider({
    protocol: options.protocol,
    baseURL: fixture.baseURL,
    apiKey: `key-for-${options.protocol}`,
  });
  try {
    return await body(fixture, await fixtureTurn(handle));
  } finally {
    await fixture.close();
  }
}

function turnRequest(overrides: Partial<ModelTurnRequest> = {}): ModelTurnRequest {
  return {
    instructions: INSTRUCTIONS,
    input: HISTORY,
    tools: TOOLS,
    ...overrides,
  };
}

const readThing = defineTool({
  name: 'read_thing',
  description: 'read a thing',
  parameters: z.object({ name: z.string() }),
  sideEffect: 'none',
  readOnly: true,
  execute: async ({ name }) => toolOk(`content of ${name}`),
});

function toolContext(): Omit<ToolContext, 'signal'> {
  return {
    workspace: null,
    policy: { ...DEFAULT_TOOL_POLICY, allowWorkspaceWrites: true, allowCommands: true },
    ledger: new TurnReadLedger(),
    now: new Date('2026-11-08T12:00:00Z'),
  };
}

function requestHasToolResult(protocol: 'responses' | 'chat-completions', body: unknown): boolean {
  const record = body as Record<string, unknown>;
  if (protocol === 'responses') {
    return arrayOf(record.input).some(
      (item) => (item as { type?: unknown }).type === 'function_call_output',
    );
  }
  return arrayOf(record.messages).some(
    (message) => (message as { role?: unknown }).role === 'tool',
  );
}

afterAll(async () => {
  await closeFixtureProviders();
});

describe('R13/T06 — two protocols through the same model port', () => {
  it('encodes the same request differently per protocol and yields equivalent output', async () => {
    const plan: ReplyPlan = {
      textChunks: ['完成了。'],
      usage: { inputTokens: 64, outputTokens: 8, cachedTokens: 32 },
    };

    const responses = await startProtocolFixture({ protocol: 'responses', plan });
    const responsesHandle = registerFixtureProvider({
      protocol: 'responses',
      baseURL: responses.baseURL,
      apiKey: 'responses-key',
    });
    const chat = await startProtocolFixture({ protocol: 'chat-completions', plan });
    const chatHandle = registerFixtureProvider({
      protocol: 'chat-completions',
      baseURL: chat.baseURL,
      apiKey: 'chat-key',
    });

    try {
      const responsesEvents = await collect((await fixtureTurn(responsesHandle))(turnRequest()));
      const chatEvents = await collect((await fixtureTurn(chatHandle))(turnRequest()));

      // --- captured Responses request -------------------------------------
      const responsesBody = bodyOf(responses.requests[0]!);
      expect(responses.requests[0]!.path).toBe('/v1/responses');
      expect(responses.requests[0]!.headers.authorization).toBe('Bearer responses-key');
      expect(responsesBody.instructions).toBe(INSTRUCTIONS);
      expect(responsesBody).not.toHaveProperty('messages');
      expect(responsesBody.stream).toBe(true);
      const responsesInput = arrayOf(responsesBody.input) as Record<string, unknown>[];
      // Responses message items carry a role but no explicit `type`; tool
      // items carry `type`. That asymmetry is part of the protocol.
      expect(responsesInput.map((item) => item.type ?? (item.role ? 'message' : null))).toEqual([
        'message',
        'message',
        'function_call',
        'function_call_output',
        'message',
      ]);
      expect((responsesInput[0]!.content as Record<string, unknown>[])[0]).toMatchObject({
        type: 'input_text',
        text: '看一下 a.ts',
      });
      expect(responsesInput[2]).toMatchObject({
        type: 'function_call',
        call_id: 'call_1',
        name: 'read_thing',
      });
      expect(responsesInput[3]).toMatchObject({
        type: 'function_call_output',
        call_id: 'call_1',
      });
      // Responses tool declarations are flat; Chat Completions nests them
      // under `function`.
      const responsesTool = (arrayOf(responsesBody.tools) as Record<string, unknown>[])[0]!;
      expect(responsesTool).toMatchObject({ type: 'function', name: 'read_thing' });
      expect(responsesTool).not.toHaveProperty('function');

      // --- captured Chat Completions request ------------------------------
      const chatBody = bodyOf(chat.requests[0]!);
      expect(chat.requests[0]!.path).toBe('/v1/chat/completions');
      expect(chat.requests[0]!.headers.authorization).toBe('Bearer chat-key');
      expect(chatBody).not.toHaveProperty('instructions');
      expect(chatBody.stream).toBe(true);
      expect(chatBody.stream_options).toEqual({ include_usage: true });
      const messages = arrayOf(chatBody.messages) as Record<string, unknown>[];
      expect(messages.map((message) => message.role)).toEqual([
        'system',
        'user',
        'assistant',
        'tool',
        'user',
      ]);
      expect(messages[0]).toMatchObject({ role: 'system', content: INSTRUCTIONS });
      expect(messages[2]!.tool_calls).toEqual([
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'read_thing', arguments: '{"name":"a.ts"}' },
        },
      ]);
      expect(messages[3]).toMatchObject({
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'content of a.ts',
      });
      const chatTool = (arrayOf(chatBody.tools) as Record<string, unknown>[])[0]!;
      expect(chatTool).toMatchObject({
        type: 'function',
        function: { name: 'read_thing', description: 'read a thing' },
      });
      expect(chatTool).not.toHaveProperty('name');

      // --- equivalent product-level output --------------------------------
      expect(normalizeOutput(doneOf(chatEvents).output)).toEqual(
        normalizeOutput(doneOf(responsesEvents).output),
      );
      expect(doneOf(chatEvents).output).toEqual([
        { type: 'message', role: 'assistant', content: '完成了。' },
      ]);
      expect(usageOf(chatEvents)).toMatchObject({
        inputTokens: 64,
        outputTokens: 8,
        totalTokens: 72,
        cachedTokens: 32,
      });
      expect(usageOf(responsesEvents)).toEqual(usageOf(chatEvents));
    } finally {
      await responses.close();
      await chat.close();
    }
  });

  it('streams text deltas and reassembles a tool call split across frames', async () => {
    const makePlan = (): ReplyPlan => ({
      textChunks: ['我', '先读。'],
      toolCalls: [
        {
          callId: 'call_split',
          name: 'read_thing',
          arguments: '{"name":"a.ts"}',
          argumentChunks: ['{"name":', '"a.ts"}'],
        },
      ],
    });

    const perProtocol: Record<string, ModelTurnEvent[]> = {};
    for (const protocol of ['responses', 'chat-completions'] as const) {
      await withFixture({ protocol, plan: makePlan() }, async (_fixture, turn) => {
        perProtocol[protocol] = await collect(turn(turnRequest()));
      });
    }

    for (const protocol of ['responses', 'chat-completions'] as const) {
      const events = perProtocol[protocol]!;
      expect(events.filter((event) => event.type === 'text_delta').map((event) => event.text)).toEqual([
        '我',
        '先读。',
      ]);
      expect(doneOf(events).output).toEqual([
        { type: 'message', role: 'assistant', content: '我先读。' },
        {
          type: 'function_call',
          callId: 'call_split',
          name: 'read_thing',
          arguments: '{"name":"a.ts"}',
        },
      ]);
    }
  });

  it('backfills a tool result in each protocol through the real loop', async () => {
    const capturedSecondRequest: Record<string, Record<string, unknown>> = {};
    for (const protocol of ['responses', 'chat-completions'] as const) {
      const plan = (request: { readonly body: unknown }): ReplyPlan =>
        requestHasToolResult(protocol, request.body)
          ? { textChunks: ['读完了。'], usage: { inputTokens: 9, outputTokens: 3 } }
          : {
              textChunks: ['我先读。'],
              toolCalls: [{ callId: 'call_loop', name: 'read_thing', arguments: '{"name":"a.ts"}' }],
              usage: { inputTokens: 8, outputTokens: 2 },
            };
      const fixture = await startProtocolFixture({ protocol, plan });
      const handle = registerFixtureProvider({
        protocol,
        baseURL: fixture.baseURL,
        apiKey: `key-for-${protocol}`,
      });
      try {
        const events = await collectAgent(
          runAgentLoop({
            modelTurn: await fixtureTurn(handle),
            instructions: INSTRUCTIONS,
            input: [{ type: 'message', role: 'user', content: '看一下 a.ts' }],
            tools: new ToolRegistry([readThing]),
            toolContext: toolContext(),
          }),
        );

        expect(events.filter((event) => event.type === 'tool_call')).toHaveLength(1);
        expect(events.find((event) => event.type === 'tool_result')).toMatchObject({
          name: 'read_thing',
          ok: true,
        });
        expect(events.at(-1)).toMatchObject({ type: 'completed', text: '我先读。读完了。' });
        expect(fixture.requests).toHaveLength(2);
        capturedSecondRequest[protocol] = bodyOf(fixture.requests[1]!);
      } finally {
        await fixture.close();
      }
    }

    const responsesSecond = capturedSecondRequest.responses!;
    const responsesInput = arrayOf(responsesSecond.input) as Record<string, unknown>[];
    expect(responsesInput.find((item) => item.type === 'function_call')).toMatchObject({
      type: 'function_call',
      call_id: 'call_loop',
      name: 'read_thing',
      arguments: '{"name":"a.ts"}',
    });
    expect(responsesInput.find((item) => item.type === 'function_call_output')).toMatchObject({
      type: 'function_call_output',
      call_id: 'call_loop',
      output: 'content of a.ts',
    });

    const chatSecond = capturedSecondRequest['chat-completions']!;
    const chatMessages = arrayOf(chatSecond.messages) as Record<string, unknown>[];
    const assistant = chatMessages.find((message) => message.role === 'assistant');
    expect(assistant).toMatchObject({
      content: [{ type: 'text', text: '我先读。' }],
      tool_calls: [
        {
          id: 'call_loop',
          type: 'function',
          function: { name: 'read_thing', arguments: '{"name":"a.ts"}' },
        },
      ],
    });
    expect(chatMessages.find((message) => message.role === 'tool')).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_loop',
      content: 'content of a.ts',
    });
  });

  it('reports cached input tokens from each protocol’s usage shape', async () => {
    for (const protocol of ['responses', 'chat-completions'] as const) {
      await withFixture(
        {
          protocol,
          plan: {
            textChunks: ['ok'],
            usage: { inputTokens: 1_200, outputTokens: 30, cachedTokens: 1_024 },
          },
        },
        async (_fixture, turn) => {
          const usage = usageOf(await collect(turn(turnRequest())));
          expect(usage).toMatchObject({
            inputTokens: 1_200,
            outputTokens: 30,
            totalTokens: 1_230,
            cachedTokens: 1_024,
          });
          expect(usage?.reported).not.toBe(false);
          expect(usage?.cacheReported).not.toBe(false);
        },
      );
    }
  });
});

describe('R13 — protocol failures, timeout and cancellation', () => {
  it('maps an HTTP protocol error to a failed turn and a loop error event', async () => {
    for (const protocol of ['responses', 'chat-completions'] as const) {
      const fixture = await startProtocolFixture({
        protocol,
        httpError: {
          status: 400,
          body: {
            error: {
              message: 'tool schema rejected by the fixture',
              type: 'invalid_request_error',
              code: 'invalid_tool_schema',
            },
          },
        },
      });
      const handle = registerFixtureProvider({
        protocol,
        baseURL: fixture.baseURL,
        apiKey: `key-for-${protocol}`,
      });
      try {
        const turn = await fixtureTurn(handle);
        await expect(collect(turn(turnRequest()))).rejects.toThrow(
          /tool schema rejected by the fixture/,
        );

        const events = await collectAgent(
          runAgentLoop({
            modelTurn: turn,
            instructions: INSTRUCTIONS,
            input: [{ type: 'message', role: 'user', content: 'go' }],
            tools: new ToolRegistry([]),
            toolContext: toolContext(),
          }),
        );
        const error = events.at(-1);
        expect(error).toMatchObject({ type: 'error', retryable: true });
        if (error?.type === 'error') {
          expect(error.message).toContain('tool schema rejected by the fixture');
        }
      } finally {
        await fixture.close();
      }
    }
  });

  it('maps an in-band stream error to a rejected turn for both protocols', async () => {
    for (const protocol of ['responses', 'chat-completions'] as const) {
      await withFixture(
        {
          protocol,
          plan: {
            textChunks: ['半'],
            streamError: { code: 'server_overloaded', message: 'stream exploded mid-flight' },
          },
        },
        async (_fixture, turn) => {
          await expect(collect(turn(turnRequest()))).rejects.toThrow(/exploded|unsuccessful/i);
        },
      );
    }
  });

  it('times out a provider that never sends headers', async () => {
    const fixture = await startProtocolFixture({
      protocol: 'responses',
      hangBeforeHeaders: true,
    });
    const handle = registerFixtureProvider({
      protocol: 'responses',
      baseURL: fixture.baseURL,
      apiKey: 'timeout-key',
      requestTimeoutMs: 120,
    });
    try {
      const turn = await fixtureTurn(handle);
      const started = Date.now();
      await expect(collect(turn(turnRequest()))).rejects.toThrow(/timed out/i);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0]!.completed).toBe(false);
    } finally {
      await fixture.close();
    }
  });

  it('disconnects the HTTP request when the AbortSignal fires, for both protocols', async () => {
    for (const protocol of ['responses', 'chat-completions'] as const) {
      const fixture = await startProtocolFixture({
        protocol,
        plan: { textChunks: ['部分', '结果'] },
        frameDelayMs: 10,
        hangAfterFrames: true,
      });
      const handle = registerFixtureProvider({
        protocol,
        baseURL: fixture.baseURL,
        apiKey: `abort-key-${protocol}`,
      });
      try {
        const controller = new AbortController();
        const turn = await fixtureTurn(handle);
        const iterator = turn(turnRequest({ signal: controller.signal }))[Symbol.asyncIterator]();
        const first = await iterator.next();
        expect(first.value).toMatchObject({ type: 'text_delta' });
        controller.abort();
        // The client may surface the abort as a thrown error or as an ended
        // stream. Neither is the evidence; the fixture observing the socket
        // close is.
        try {
          for (;;) {
            const next = await iterator.next();
            if (next.done) break;
          }
        } catch {
          // Expected for at least one transport implementation.
        }

        const deadline = Date.now() + 3_000;
        while (!fixture.requests[0]?.aborted && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(fixture.requests[0]?.aborted).toBe(true);
        expect(fixture.requests[0]?.completed).toBe(false);

        // The loop reports cancellation rather than a provider failure when the
        // signal it was given is already aborted.
        const events = await collectAgent(
          runAgentLoop({
            modelTurn: turn,
            instructions: INSTRUCTIONS,
            input: [{ type: 'message', role: 'user', content: 'go' }],
            tools: new ToolRegistry([]),
            toolContext: toolContext(),
            signal: AbortSignal.abort(),
          }),
        );
        expect(events.at(-1)).toMatchObject({ type: 'error', message: 'cancelled' });
      } finally {
        await fixture.close();
      }
    }
  });
});
