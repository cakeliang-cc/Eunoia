/**
 * The loop, without a model.
 *
 * A scripted `ModelTurn` is enough to pin the properties that a live run cannot
 * make cheap or deterministic: ordering, the step cap, policy refusal, malformed
 * tool arguments, parallel reads and sequential writes. The provider adapter is
 * a separate file with its own tests; this file is about the decisions between a
 * model step and a tool result.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runAgentLoop } from '../../src/agent/loop.ts';
import type {
  LoopInputItem,
  LoopOutputItem,
  ModelTurn,
} from '../../src/agent/model-port.ts';
import type { AgentEvent } from '../../src/agent/events.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';
import { TurnReadLedger } from '../../src/tools/ledger.ts';
import { DEFAULT_TOOL_POLICY, defineTool, toolOk } from '../../src/tools/types.ts';
import type { ToolContext, ToolPolicy } from '../../src/tools/types.ts';

interface Step {
  readonly text?: string;
  readonly reasoning?: string;
  readonly calls?: readonly { readonly id: string; readonly name: string; readonly args: unknown }[];
  readonly rawCalls?: readonly { readonly id: string; readonly name: string; readonly arguments: string }[];
}

/**
 * A model that plays a fixed script.
 *
 * It records the input it was given, so a test can assert that a tool result
 * actually reached the next step rather than being executed and dropped.
 */
function scripted(steps: readonly Step[]): { turn: ModelTurn; requests: LoopInputItem[][]; calls: () => number } {
  const requests: LoopInputItem[][] = [];
  let index = 0;
  const turn: ModelTurn = async function* (request) {
    requests.push([...request.input]);
    const step = steps[index];
    index += 1;
    if (!step) throw new Error(`script exhausted after ${index - 1} steps`);

    if (step.reasoning) yield { type: 'reasoning_delta', text: step.reasoning };
    if (step.text) yield { type: 'text_delta', text: step.text };

    const output: LoopOutputItem[] = [];
    if (step.text) output.push({ type: 'message', role: 'assistant', content: step.text });
    if (step.reasoning) output.push({ type: 'reasoning', text: step.reasoning });
    for (const call of step.calls ?? []) {
      output.push({
        type: 'function_call',
        callId: call.id,
        name: call.name,
        arguments: JSON.stringify(call.args),
      });
    }
    for (const call of step.rawCalls ?? []) {
      output.push({
        type: 'function_call',
        callId: call.id,
        name: call.name,
        arguments: call.arguments,
      });
    }
    yield { type: 'done', output };
  };
  return { turn, requests, calls: () => index };
}

function registry(...definitions: ReturnType<typeof defineTool>[]): ToolRegistry {
  return new ToolRegistry(definitions);
}

function context(policy: ToolPolicy = { ...DEFAULT_TOOL_POLICY, allowWorkspaceWrites: true, allowCommands: true }): Omit<ToolContext, 'signal'> {
  return {
    workspace: null,
    policy,
    ledger: new TurnReadLedger(),
    now: new Date('2026-10-25T12:00:00Z'),
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const echoTool = defineTool({
  name: 'read_thing',
  description: 'read a thing',
  parameters: z.object({ name: z.string() }),
  sideEffect: 'none',
  readOnly: true,
  execute: async ({ name }) => toolOk(`content of ${name}`),
});

describe('the loop', () => {
  it('runs a tool, feeds the result back, and returns the final text', async () => {
    const model = scripted([
      {
        text: '我先读一下。',
        calls: [{ id: 'c1', name: 'read_thing', args: { name: 'a.ts' } }],
      },
      { text: '读完了，可以改。' },
    ]);

    const events = await collect(
      runAgentLoop({
        modelTurn: model.turn,
        instructions: 'stable',
        input: [{ type: 'message', role: 'user', content: '看一下 a.ts' }],
        tools: registry(echoTool),
        toolContext: context(),
      }),
    );

    expect(events.filter((event) => event.type === 'tool_call')).toHaveLength(1);
    const result = events.find((event) => event.type === 'tool_result');
    expect(result).toMatchObject({ name: 'read_thing', ok: true, durationMs: expect.any(Number) });
    const completed = events.at(-1);
    expect(completed).toMatchObject({
      type: 'completed',
      text: '我先读一下。读完了，可以改。',
    });

    // The second model step must see its own call *and* the result, in order.
    const second = model.requests[1] ?? [];
    const callIndex = second.findIndex((item) => item.type === 'function_call');
    const resultIndex = second.findIndex((item) => item.type === 'function_call_result');
    expect(callIndex).toBeGreaterThan(-1);
    expect(resultIndex).toBeGreaterThan(callIndex);
    expect(second[resultIndex]).toMatchObject({
      type: 'function_call_result',
      callId: 'c1',
      name: 'read_thing',
      output: 'content of a.ts',
    });
  });

  it('runs consecutive read-only calls concurrently, but writes sequentially', async () => {
    let activeReads = 0;
    let peakReads = 0;
    let activeWrites = 0;
    let peakWrites = 0;
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const probe = (name: string, readOnly: boolean) =>
      defineTool({
        name,
        description: name,
        parameters: z.object({}),
        sideEffect: readOnly ? 'none' : 'workspace_write',
        readOnly,
        execute: async () => {
          if (readOnly) {
            activeReads += 1;
            peakReads = Math.max(peakReads, activeReads);
            await sleep(30);
            activeReads -= 1;
          } else {
            activeWrites += 1;
            peakWrites = Math.max(peakWrites, activeWrites);
            await sleep(30);
            activeWrites -= 1;
          }
          return toolOk('ok');
        },
      });

    const model = scripted([
      {
        calls: [
          { id: 'r1', name: 'read_a', args: {} },
          { id: 'r2', name: 'read_b', args: {} },
          { id: 'w1', name: 'write_a', args: {} },
          { id: 'w2', name: 'write_b', args: {} },
        ],
      },
      { text: 'done' },
    ]);

    await collect(
      runAgentLoop({
        modelTurn: model.turn,
        instructions: 'stable',
        input: [{ type: 'message', role: 'user', content: 'go' }],
        tools: registry(probe('read_a', true), probe('read_b', true), probe('write_a', false), probe('write_b', false)),
        toolContext: context(),
      }),
    );

    // Two reads overlap; two writes never do. Counting overlap is stable under
    // a loaded CI box, where comparing wall-clock start times is not.
    expect(peakReads).toBe(2);
    expect(peakWrites).toBe(1);
  });

  it('refuses a write before the tool runs when the policy says no', async () => {
    let executed = false;
    const guarded = defineTool({
      name: 'guarded_write',
      description: 'guarded',
      parameters: z.object({}),
      sideEffect: 'workspace_write',
      readOnly: false,
      execute: async () => {
        executed = true;
        return toolOk('should not happen');
      },
    });

    const model = scripted([
      { calls: [{ id: 'w1', name: 'guarded_write', args: {} }] },
      { text: '好，我不写。' },
    ]);

    const events = await collect(
      runAgentLoop({
        modelTurn: model.turn,
        instructions: 'stable',
        input: [{ type: 'message', role: 'user', content: 'go' }],
        tools: registry(guarded),
        toolContext: context(DEFAULT_TOOL_POLICY),
      }),
    );

    expect(executed).toBe(false);
    const result = events.find((event) => event.type === 'tool_result');
    expect(result).toMatchObject({ ok: false });
    expect(result?.type === 'tool_result' ? result.error : '').toContain('WORKSPACE_WRITES');
  });

  it('reports malformed arguments as malformed JSON, not as a missing file', async () => {
    const model = scripted([
      {
        rawCalls: [{ id: 'c1', name: 'read_thing', arguments: '{"name": ' }],
      },
      { text: 'JSON 坏了。' },
    ]);

    const events = await collect(
      runAgentLoop({
        modelTurn: model.turn,
        instructions: 'stable',
        input: [{ type: 'message', role: 'user', content: 'go' }],
        tools: registry(echoTool),
        toolContext: context(),
      }),
    );

    const result = events.find((event) => event.type === 'tool_result');
    expect(result).toMatchObject({ ok: false });
    expect(result?.type === 'tool_result' ? result.error : '').toContain('not valid JSON');
  });

  it('reports an unknown tool and lists what is available', async () => {
    const model = scripted([
      { calls: [{ id: 'c1', name: 'does_not_exist', args: {} }] },
      { text: '哦。' },
    ]);

    const events = await collect(
      runAgentLoop({
        modelTurn: model.turn,
        instructions: 'stable',
        input: [{ type: 'message', role: 'user', content: 'go' }],
        tools: registry(echoTool),
        toolContext: context(),
      }),
    );

    const result = events.find((event) => event.type === 'tool_result');
    expect(result?.type === 'tool_result' ? result.error : '').toContain('read_thing');
  });

  it('stops at the step cap with a partial answer instead of failing', async () => {
    const steps: Step[] = Array.from({ length: 5 }, (_, index) => ({
      text: `step ${index} `,
      calls: [{ id: `c${index}`, name: 'read_thing', args: { name: 'a' } }],
    }));
    const model = scripted(steps);

    const events = await collect(
      runAgentLoop({
        modelTurn: model.turn,
        instructions: 'stable',
        input: [{ type: 'message', role: 'user', content: 'go' }],
        tools: registry(echoTool),
        toolContext: context(),
        maxSteps: 2,
      }),
    );

    expect(events.some((event) => event.type === 'loop_exhausted')).toBe(true);
    const completed = events.at(-1);
    expect(completed?.type).toBe('completed');
    const text = completed?.type === 'completed' ? completed.text : '';
    expect(text).toContain('step 0');
    expect(text).toContain('step 1');
    expect(text).toContain('上限');
    expect(model.calls()).toBe(2);
  });

  it('closes the reasoning block before the first reply delta', async () => {
    const model = scripted([{ reasoning: '想一想。', text: '好。' }]);
    const events = await collect(
      runAgentLoop({
        modelTurn: model.turn,
        instructions: 'stable',
        input: [{ type: 'message', role: 'user', content: 'go' }],
        tools: registry(),
        toolContext: context(),
      }),
    );

    const types = events.map((event) => event.type);
    expect(types.indexOf('thinking_delta')).toBeGreaterThan(-1);
    expect(types.indexOf('thinking_done')).toBeGreaterThan(types.indexOf('thinking_delta'));
    expect(types.indexOf('thinking_done')).toBeLessThan(types.indexOf('text_delta'));
  });

  it('turns a pre-aborted signal into a cancellation error', async () => {
    const controller = new AbortController();
    controller.abort();
    const model = scripted([{ text: 'never' }]);
    const events = await collect(
      runAgentLoop({
        modelTurn: model.turn,
        instructions: 'stable',
        input: [{ type: 'message', role: 'user', content: 'go' }],
        tools: registry(),
        toolContext: context(),
        signal: controller.signal,
      }),
    );

    expect(events.at(-1)).toMatchObject({ type: 'error', message: 'cancelled', retryable: false });
  });

  it('caps a tool output at the policy limit', async () => {
    const big = defineTool({
      name: 'big',
      description: 'big',
      parameters: z.object({}),
      sideEffect: 'none',
      readOnly: true,
      execute: async () => toolOk('x'.repeat(200)),
    });
    const model = scripted([
      { calls: [{ id: 'c1', name: 'big', args: {} }] },
      { text: 'ok' },
    ]);
    const events = await collect(
      runAgentLoop({
        modelTurn: model.turn,
        instructions: 'stable',
        input: [{ type: 'message', role: 'user', content: 'go' }],
        tools: registry(big),
        toolContext: context({ ...DEFAULT_TOOL_POLICY, maxOutputChars: 60 }),
      }),
    );

    const result = events.find((event) => event.type === 'tool_result');
    expect(result).toMatchObject({ ok: true });
    const fedBack = model.requests[1]?.find((item) => item.type === 'function_call_result');
    expect(fedBack?.type === 'function_call_result' ? fedBack.output.length : 999).toBeLessThan(200);
  });
});
