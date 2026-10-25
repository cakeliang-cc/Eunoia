/**
 * The SDK adapter, driven by a fake model.
 *
 * This does not prove the provider accepts the request — only a live call can.
 * It does prove the three things that are ours: that the port's input items are
 * translated into the SDK's shapes, that tool schemas are serialised without a
 * dialect header, and that the two event namings the SDK has used are both read.
 * The live counterpart is in `tests/smoke/live-tools.test.ts`, gated behind
 * `RUN_SMOKE=1`.
 */

import { describe, expect, it } from 'vitest';
import type { Model, StreamEvent } from '@openai/agents';
import { createSdkModelTurn } from '../../src/agent/model-turn.ts';
import { createCompanionAgent, streamReply } from '../../src/agent/infp-agent.ts';
import type { ModelTurnEvent } from '../../src/agent/model-port.ts';

function fakeModel(events: readonly StreamEvent[], seen: { request?: unknown } = {}): Model {
  return {
    getResponse: async () => {
      throw new Error('getResponse is not used by the streaming adapter');
    },
    getStreamedResponse: (request) => {
      seen.request = request;
      return (async function* stream() {
        for (const event of events) yield event;
      })();
    },
  } as Model;
}

async function collect(events: AsyncIterable<ModelTurnEvent>): Promise<ModelTurnEvent[]> {
  const out: ModelTurnEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const doneEvent = {
  type: 'response_done',
  response: {
    id: 'resp_1',
    usage: { inputTokens: 1_000, outputTokens: 20, totalTokens: 1_020, inputTokensDetails: [{ cached_tokens: 800 }] },
    output: [
      { type: 'reasoning', id: 'rs_1', content: [{ type: 'input_text', text: '想一下' }], rawContent: [{ type: 'reasoning_text', text: '想一下' }] },
      { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '好。' }] },
      { type: 'function_call', callId: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' },
    ],
  },
} as unknown as StreamEvent;

describe('the SDK model adapter', () => {
  it('forwards text and reasoning, then reports output and usage', async () => {
    const seen: { request?: unknown } = {};
    const model = fakeModel(
      [
        { type: 'output_text_delta', delta: '好' } as StreamEvent,
        { type: 'model', event: { type: 'response.reasoning_text.delta', delta: '想' } } as StreamEvent,
        doneEvent,
      ],
      seen,
    );

    const events = await collect(
      createSdkModelTurn(model)({
        instructions: 'stable',
        input: [
          { type: 'message', role: 'user', content: '看一下' },
          { type: 'message', role: 'system', content: '本轮背景' },
        ],
        tools: [
          {
            name: 'read_file',
            description: 'read',
            parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          },
        ],
      }),
    );

    expect(events.slice(0, 2)).toEqual([
      { type: 'text_delta', text: '好' },
      { type: 'reasoning_delta', text: '想' },
    ]);
    const done = events.at(-1);
    expect(done).toMatchObject({ type: 'done', responseId: 'resp_1' });
    if (done?.type !== 'done') throw new Error('no done event');
    expect(done.usage).toEqual({ inputTokens: 1_000, outputTokens: 20, totalTokens: 1_020, cachedTokens: 800 });
    expect(done.output).toEqual([
      { type: 'reasoning', text: '想一下', id: 'rs_1', raw: expect.objectContaining({ type: 'reasoning' }) },
      { type: 'message', role: 'assistant', content: '好。' },
      { type: 'function_call', callId: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' },
    ]);

    const request = seen.request as {
      systemInstructions: string;
      input: unknown[];
      tools: { parameters: Record<string, unknown> }[];
    };
    expect(request.systemInstructions).toBe('stable');
    expect(request.input).toHaveLength(2);
    expect(request.input[1]).toEqual({ type: 'message', role: 'system', content: '本轮背景' });
    expect(request.tools[0]?.parameters).not.toHaveProperty('$schema');
  });

  it('accepts the flat reasoning shape too', async () => {
    const model = fakeModel([
      { type: 'model', event: { type: 'response.reasoning_text.done' } } as StreamEvent,
      {
        type: 'response_done',
        response: {
          id: 'r',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] }],
        },
      } as unknown as StreamEvent,
    ]);

    const events = await collect(
      createSdkModelTurn(model)({
        instructions: 'stable',
        input: [{ type: 'message', role: 'user', content: 'go' }],
        tools: [],
      }),
    );

    expect(events[0]).toEqual({ type: 'reasoning_done' });
  });

  it('falls back to the streamed text if a response never arrives', async () => {
    // Some proxies close the stream without a terminal event. Losing a reply
    // that was already shown is worse than reporting it as a completed turn.
    const model = fakeModel([{ type: 'output_text_delta', delta: 'partial' } as StreamEvent]);
    const events = await collect(
      createSdkModelTurn(model)({
        instructions: 'stable',
        input: [{ type: 'message', role: 'user', content: 'go' }],
        tools: [],
      }),
    );

    expect(events.at(-1)).toEqual({
      type: 'done',
      output: [{ type: 'message', role: 'assistant', content: 'partial' }],
    });
  });
});

describe('the companion run', () => {
  it(
    'reports a provider failure as an SSE error, not an exception',
    async () => {
    const agent = createCompanionAgent({
      modelProvider: {
        getModel: () => {
          throw new Error('no credential');
        },
      } as never,
    });

    const events: unknown[] = [];
    for await (const event of streamReply(agent, '在吗')) events.push(event);

    expect(events[0]).toMatchObject({ type: 'error', message: 'no credential' });
    },
    30_000,
  );
});
