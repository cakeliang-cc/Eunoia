/**
 * A10–A16, A22: exact assistant/tool replay and write-failure semantics.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { defineTool, toolOk } from '../../src/tools/types.ts';
import { DEFAULT_TOOL_POLICY } from '../../src/tools/types.ts';
import { DurableTranscript } from '../../src/service/model-transcript.ts';
import { fakeVisionProfile } from '../../src/provider/fake.ts';
import { runScenario, scriptedModel, replyOf, USER } from '../service/durable-harness.ts';

function echoTool(counter: { calls: number }): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'echo',
    description: 'echo text',
    parameters: z.object({ text: z.string() }),
    sideEffect: 'none',
    readOnly: true,
    execute: async ({ text }) => {
      counter.calls += 1;
      return toolOk(text);
    },
  });
}

function bigTool(counter: { calls: number }, tail: string): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'big',
    description: 'return a big result',
    parameters: z.object({}),
    sideEffect: 'none',
    readOnly: true,
    execute: async () => {
      counter.calls += 1;
      return toolOk(`${'x'.repeat(3_000)}${tail}`);
    },
  });
}

const usage = { inputTokens: 1_000, outputTokens: 20, totalTokens: 1_020, cachedTokens: 800 };

describe('A10: assistant text is replayed byte for byte', () => {
  it('does not replace a long reply with a placeholder or UI summary', async () => {
    const store = new InMemoryStore();
    const long = `长回复开始。${'内容'.repeat(600)}。长回复结束。`;
    const model = scriptedModel([
      { text: long, usage },
      { text: '第二轮。', usage },
    ]);
    const first = await runScenario({ store, model, message: '写一段长文' });
    expect(replyOf(first.events)).toBe(long);
    const second = await runScenario({
      store,
      model,
      message: '继续',
      conversationId: first.conversationId,
    });
    expect(second.events.at(-1)?.type).toBe('completed');
    const replay = model.requests[1];
    const assistants = replay?.input.filter(
      (item) => item.type === 'message' && item.role === 'assistant',
    );
    expect(assistants?.map((item) => item.type === 'message' && item.content)).toContain(long);
    const items = await store.listItems(first.conversationId as string);
    const stored = items.filter((item) => item.kind === 'assistant');
    expect(stored.map((item) => item.payload.type === 'message' && item.payload.content)).toContain(long);
    expect(stored.every((item) => item.status === 'complete')).toBe(true);
  });
});

describe('A11: multi-step tool order and call ids', () => {
  it('replays assistant text, call and result in order with no orphan half-group', async () => {
    const store = new InMemoryStore();
    const counter = { calls: 0 };
    const model = scriptedModel([
      {
        text: '我先看看。',
        calls: [{ name: 'echo', arguments: { text: '文件内容' } }],
        usage,
      },
      { text: '看完了。', usage },
    ]);
    const result = await runScenario({
      store,
      model,
      message: '读取文件',
      tools: [echoTool(counter)],
    });
    expect(counter.calls).toBe(1);
    expect(replyOf(result.events)).toBe('我先看看。看完了。');
    const items = await store.listItems(result.conversationId as string);
    const relevant = items.filter((item) => item.kind !== 'background');
    expect(relevant.map((item) => item.kind)).toEqual([
      'user',
      'assistant',
      'tool_call',
      'tool_result',
      'assistant',
    ]);
    const call = relevant.find((item) => item.kind === 'tool_call');
    const toolResult = relevant.find((item) => item.kind === 'tool_result');
    expect(call?.callId).toBe(toolResult?.callId);
    expect(toolResult?.payload.type === 'function_call_result' && toolResult.payload.output).toBe(
      '文件内容',
    );
    const steps = await store.listSteps(result.requestId);
    expect(steps.map((step) => step.step)).toEqual([1, 2]);
    expect(steps[0]?.outputItemIds).toHaveLength(2);
    expect(steps[1]?.inputItemIds).toContain(call?.id);
  });
});

describe('A12: the model transcript keeps the full bounded tool result', () => {
  it('keeps the tail the model received while the audit stays bounded', async () => {
    const store = new InMemoryStore();
    const counter = { calls: 0 };
    const tail = 'TAIL-MARKER-42';
    const model = scriptedModel([
      { calls: [{ name: 'big', arguments: {} }], usage },
      { text: '完成。', usage },
    ]);
    const first = await runScenario({
      store,
      model,
      message: '用大工具',
      tools: [bigTool(counter, tail)],
    });
    const conversationId = first.conversationId as string;
    const items = await store.listItems(conversationId);
    const toolResult = items.find((item) => item.kind === 'tool_result');
    expect(
      toolResult?.payload.type === 'function_call_result' && toolResult.payload.output.endsWith(tail),
    ).toBe(true);

    const events = await store.listTurnEvents(first.requestId);
    const audit = events.find((event) => event.kind === 'tool_result');
    expect(String(audit?.payload.output).length).toBe(2_000);

    const secondModel = scriptedModel([{ text: '第二轮。', usage }]);
    await runScenario({
      store,
      model: secondModel,
      message: '继续',
      conversationId,
    });
    const wire = JSON.stringify(secondModel.requests[0]?.input ?? []);
    expect(wire).toContain(tail);
  });
});

describe('A13: whitespace and tool payloads are not rewritten', () => {
  it('keeps spaces, newlines and JSON key order as sent', async () => {
    const store = new InMemoryStore();
    const counter = { calls: 0 };
    const exact = 'line 1\n  spaced   \n{"b":2,"a":1}';
    const tool = defineTool({
      name: 'exact',
      description: 'exact',
      parameters: z.object({}),
      sideEffect: 'none',
      readOnly: true,
      execute: async () => {
        counter.calls += 1;
        return toolOk(exact);
      },
    });
    const model = scriptedModel([
      { calls: [{ name: 'exact', arguments: {} }], usage },
      { text: 'ok', usage },
    ]);
    await runScenario({ store, model, message: '原样', tools: [tool] });
    const items = await store.listItems((await store.listConversations(USER))[0]!.id);
    const result = items.find((item) => item.kind === 'tool_result');
    expect(result?.payload.type === 'function_call_result' && result.payload.output).toBe(exact);
  });
});

class FailPrepareStore extends InMemoryStore {
  override async prepareStep(): Promise<never> {
    throw new Error('disk full');
  }
}

class FailToolResultStore extends InMemoryStore {
  override async appendItems(
    items: readonly import('../../src/session/model-transcript.ts').NewModelItem[],
  ) {
    if (items.some((item) => item.kind === 'tool_result' && item.source === 'tool')) {
      throw new Error('disk full on result');
    }
    return super.appendItems(items);
  }
}

class FailToolCallStore extends InMemoryStore {
  override async appendItems(
    items: readonly import('../../src/session/model-transcript.ts').NewModelItem[],
  ) {
    if (items.some((item) => item.kind === 'tool_call')) {
      throw new Error('disk full on call');
    }
    return super.appendItems(items);
  }
}

describe('A14: transcript write failure is not a silent downgrade', () => {
  it('does not call the model when the prepared input cannot be recorded', async () => {
    const store = new FailPrepareStore();
    const counter = { calls: 0 };
    const model = scriptedModel([{ calls: [{ name: 'echo', arguments: { text: 'x' } }], usage }]);
    const result = await runScenario({ store, model, message: 'hi', tools: [echoTool(counter)] });
    expect(model.requests).toHaveLength(0);
    expect(counter.calls).toBe(0);
    const error = result.events.find((event) => event.type === 'error');
    expect(error?.type === 'error' && error.code).toBe('MODEL_TRANSCRIPT_UNAVAILABLE');
  });

  it('does not execute a tool when the call fact cannot be saved', async () => {
    const store = new FailToolCallStore();
    const counter = { calls: 0 };
    const model = scriptedModel([
      { calls: [{ name: 'echo', arguments: { text: 'x' } }], usage },
      { text: 'should not happen', usage },
    ]);
    const result = await runScenario({ store, model, message: 'hi', tools: [echoTool(counter)] });
    expect(counter.calls).toBe(0);
    expect(model.requests).toHaveLength(1);
    const error = result.events.find((event) => event.type === 'error');
    expect(error?.type === 'error' && error.code).toBe('MODEL_TRANSCRIPT_UNAVAILABLE');
  });
});

describe('A15: a tool that ran but whose result cannot be saved stops the turn', () => {
  it('does not send another model request and does not rerun the tool', async () => {
    const store = new FailToolResultStore();
    const counter = { calls: 0 };
    const model = scriptedModel([
      { calls: [{ name: 'echo', arguments: { text: 'side effect' } }], usage },
      { text: 'should not happen', usage },
    ]);
    const result = await runScenario({
      store,
      model,
      message: '执行一次',
      tools: [echoTool(counter)],
    });
    expect(counter.calls).toBe(1);
    expect(model.requests).toHaveLength(1);
    const error = result.events.find((event) => event.type === 'error');
    expect(error?.type === 'error' && error.code).toBe('MODEL_TRANSCRIPT_UNAVAILABLE');
    // The text the person saw before the failure is still on the event stream.
    expect(replyOf(result.events)).toBe('');
  });
});

describe('A16: completion, incomplete stream and reasoning metadata', () => {
  it('stores the assistant text once and marks an incomplete stream', async () => {
    const store = new InMemoryStore();
    const model = scriptedModel([
      { text: '说到一半', reasoning: '思考中', usage, incomplete: true },
    ]);
    const result = await runScenario({ store, model, message: '讲个故事' });
    const completed = result.events.at(-1);
    expect(completed?.type).toBe('completed');
    if (completed?.type !== 'completed') throw new Error('no completion');
    expect(completed.finishReason).toBe('incomplete_stream');
    const items = await store.listItems(result.conversationId as string);
    expect(items.filter((item) => item.kind === 'assistant')).toHaveLength(1);
    expect(items.filter((item) => item.kind === 'reasoning')).toHaveLength(1);
    const assistant = items.find((item) => item.kind === 'assistant');
    expect(assistant?.status).toBe('incomplete');
    const step = (await store.listSteps(result.requestId))[0];
    expect(step?.status).toBe('incomplete');
    // Private reasoning is not a chat message and must not be echoed in the reply.
    expect(replyOf(result.events)).toBe('说到一半');
  });
});

describe('A22: a trimmed tool result stays trimmed across restart', () => {
  it('persists the compressed item and keeps the original auditable', async () => {
    const store = new InMemoryStore();
    await store.ensureUser(USER);
    const conversation = await store.createConversation(USER);
    const user = await store.appendMessage({
      conversationId: conversation.id,
      userId: USER,
      role: 'user',
      content: 'read the file',
    });
    const assistant = await store.appendMessage({
      conversationId: conversation.id,
      userId: USER,
      role: 'assistant',
      content: 'done',
    });
    const profile = fakeVisionProfile();
    const options = {
      store,
      userId: USER,
      conversationId: conversation.id,
      requestId: 'req-a22',
      turnId: 'req-a22',
      instructions: 'short prompt',
      promptVersion: 'p',
      tools: [],
      profile,
      replay: {
        summary: null,
        throughSeq: 0,
        messages: [user, assistant],
      },
      user: null,
      context: {},
      policy: DEFAULT_TOOL_POLICY,
      now: new Date(),
    };
    const begun = await DurableTranscript.begin(options);
    const epochId = begun.epoch.id;

    const call = await store.appendItems([
      {
        conversationId: conversation.id,
        epochId,
        idempotencyKey: 'call:1',
        kind: 'tool_call',
        source: 'assistant',
        scope: 'turn',
        callId: 'call-1',
        payload: {
          type: 'function_call',
          callId: 'call-1',
          name: 'read',
          arguments: '{}',
        },
      },
      {
        conversationId: conversation.id,
        epochId,
        idempotencyKey: 'result:1',
        kind: 'tool_result',
        source: 'tool',
        scope: 'turn',
        callId: 'call-1',
        payload: {
          type: 'function_call_result',
          callId: 'call-1',
          name: 'read',
          output: `${'A'.repeat(3_000)}TAIL`,
        },
      },
    ]);
    const callItem = call[0]!;
    const resultItem = call[1]!;
    await store.updateWindow(epochId, begun.epoch.windowRevision, [
      ...begun.epoch.windowItemIds,
      callItem.id,
      resultItem.id,
    ]);

    // Re-open the transcript on the current window, then prepare a request whose
    // tool result was compressed by the context budget.
    const reopened = await DurableTranscript.begin(options);
    const fullInput = [...reopened.input];
    const compressed = {
      type: 'function_call_result' as const,
      callId: 'call-1',
      name: 'read',
      output: '[较早的工具输出已压缩：原文 3004 字符，这里保留开头 200 字符]',
    };
    const requestInput = [...fullInput.slice(0, -1), compressed];
    await reopened.transcript.prepareStep({
      step: 1,
      attemptNo: 1,
      input: fullInput,
      requestInput,
      instructions: 'short prompt',
      tools: [],
      estimatedTokens: 100,
    });

    const after = await DurableTranscript.begin({ ...options, requestId: 'req-a22-next', turnId: 'req-a22-next' });
    const wire = JSON.stringify(after.input);
    expect(wire).toContain('较早的工具输出已压缩');
    expect(wire).not.toContain('TAIL');
    const allItems = await store.listItems(conversation.id);
    expect(
      allItems.some(
        (item) =>
          item.payload.type === 'function_call_result' && item.payload.output.endsWith('TAIL'),
      ),
    ).toBe(true);
  });
});
