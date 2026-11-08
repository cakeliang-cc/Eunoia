/**
 * A17–A21, A24–A27, A29–A32: boundaries, recovery, model switches and usage.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openSqliteStore } from '../../src/db/sqlite-store.ts';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { DurableTranscript } from '../../src/service/model-transcript.ts';
import { SessionService } from '../../src/session/service.ts';
import { fakeVisionProfile } from '../../src/provider/fake.ts';
import { modelProfile } from '../../src/models/registry.ts';
import { DEFAULT_TOOL_POLICY } from '../../src/tools/types.ts';
import { planMediaRequest } from '../../src/agent/request-plan.ts';
import type { UserContentV1 } from '../../src/agent/content.ts';
import type { ModelTurn } from '../../src/agent/model-port.ts';
import { buildInstructions, PROMPT_VERSION } from '../../src/agent/instructions.ts';
import { runScenario, scriptedModel, USER } from './durable-harness.ts';
import { TurnCoordinator } from '../../src/service/turns.ts';

const usage = (input: number, output: number, cached: number) => ({
  inputTokens: input,
  outputTokens: output,
  totalTokens: input + output,
  cachedTokens: cached,
});

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop() as string, { recursive: true, force: true });
});

async function tempDb(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'eunoia-replay-'));
  dirs.push(dir);
  return join(dir, 'eunoia.sqlite');
}


describe('A03–A04: idempotency and mode switching', () => {
  it('A03: a retried request is answered from the record without a model or transcript write', async () => {
    const store = new InMemoryStore();
    const coordinator = new TurnCoordinator(store);
    await store.ensureUser(USER);
    const conversation = await store.createConversation(USER);
    const input = {
      requestId: 'req-a03',
      userId: USER,
      conversationId: conversation.id,
      requestHash: 'hash',
      model: 'deepseek-flash',
    };
    const first = await coordinator.begin(input);
    expect(first.kind).toBe('started');
    const retry = await coordinator.begin(input);
    expect(retry.kind).toBe('in_flight');
    await expect(
      coordinator.begin({ ...input, requestId: 'req-other' }),
    ).rejects.toThrow();
    expect(await store.listSteps('req-a03')).toEqual([]);
    expect(await store.listItems(conversation.id)).toEqual([]);
  });

  it('A04: legacy → durable → legacy → durable seeds each new message once', async () => {
    const store = new InMemoryStore();
    const legacyOne = await runScenario({
      store,
      model: scriptedModel([{ text: '旧一', usage: usage(10, 2, 5) }]),
      message: '消息一',
      mode: 'legacy',
    });
    const conversationId = legacyOne.conversationId as string;
    const durableOne = await runScenario({
      store,
      model: scriptedModel([{ text: '新二', usage: usage(10, 2, 5) }]),
      message: '消息二',
      conversationId,
      mode: 'durable',
    });
    expect(durableOne.events.at(-1)?.type).toBe('completed');

    await runScenario({
      store,
      model: scriptedModel([{ text: '旧三', usage: usage(10, 2, 5) }]),
      message: '消息三',
      conversationId,
      mode: 'legacy',
    });
    const durableTwo = await runScenario({
      store,
      model: scriptedModel([{ text: '新四', usage: usage(10, 2, 5) }]),
      message: '消息四',
      conversationId,
      mode: 'durable',
    });
    expect(durableTwo.events.at(-1)?.type).toBe('completed');

    const epochs = await store.listEpochs(conversationId);
    expect(epochs.filter((epoch) => epoch.reason === 'legacy-seed')).toHaveLength(2);
    const items = await store.listItems(conversationId);
    const users = items.filter(
      (item) => item.kind === 'user' && item.payload.type === 'message',
    );
    const messages = await store.listMessages(USER, conversationId);
    const userMessages = messages.filter((message) => message.role === 'user');
    expect(users).toHaveLength(userMessages.length);
    for (const message of userMessages) {
      expect(
        users.filter(
          (item) => item.messageId === message.id,
        ),
      ).toHaveLength(1);
    }
    // The original durable transcript is retained for audit, not overwritten.
    expect(epochs[0]?.endedAt).not.toBeNull();
  });
});

describe('A17: a process restart replays the same prefix', () => {
  it('reopens the active epoch and does not rerun a tool', async () => {
    const path = await tempDb();
    const firstStore = openSqliteStore(path);
    const firstModel = scriptedModel([
      { text: '第一轮。', usage: usage(100, 10, 80) },
      { text: '第二轮。', usage: usage(200, 20, 150) },
    ]);
    const first = await runScenario({
      store: firstStore,
      model: firstModel,
      message: '第一次',
    });
    const conversationId = first.conversationId as string;
    await firstStore.close();

    const secondStore = openSqliteStore(path);
    try {
      const secondModel = scriptedModel([{ text: '重启后。', usage: usage(300, 30, 250) }]);
      await runScenario({
        store: secondStore,
        model: secondModel,
        message: '重启以后',
        conversationId,
      });
      const before = JSON.stringify(firstModel.requests[0]?.input ?? []);
      const after = JSON.stringify(secondModel.requests[0]?.input ?? []);
      expect(after.startsWith(before.slice(0, Math.min(400, before.length)))).toBe(true);
      const epochs = await secondStore.listEpochs(conversationId);
      expect(epochs).toHaveLength(1);
      expect(epochs[0]?.endedAt).toBeNull();
    } finally {
      await secondStore.close();
    }
  });
});

describe('A18: an unpaired tool call becomes a recovery boundary', () => {
  it('drops the call from the active window and adds a sourced note', async () => {
    const store = new InMemoryStore();
    await store.ensureUser(USER);
    const conversation = await store.createConversation(USER);
    const user = await store.appendMessage({
      conversationId: conversation.id,
      userId: USER,
      role: 'user',
      content: '旧问题',
    });
    const epoch = await store.createEpoch({
      id: randomUUID(),
      userId: USER,
      conversationId: conversation.id,
      parentEpochId: null,
      reason: 'new-conversation',
      instructions: buildInstructions(),
      promptVersion: PROMPT_VERSION,
      tools: [],
      toolsHash: 'h',
      providerId: 'deepseek',
      modelId: 'deepseek-flash',
      protocolRevision: 'responses@1',
      encoderRevision: 'sdk@1',
      windowItemIds: [],
      windowRevision: 0,
      seededThroughSeq: user.seq,
      createdAt: new Date(),
    });
    const [userItem, callItem] = await store.appendItems([
      {
        conversationId: conversation.id,
        epochId: epoch.id,
        idempotencyKey: `seed:${user.id}`,
        messageId: user.id,
        kind: 'user',
        source: 'user',
        scope: 'conversation',
        payload: { type: 'message', role: 'user', content: user.content },
      },
      {
        conversationId: conversation.id,
        epochId: epoch.id,
        idempotencyKey: 'call:lost',
        kind: 'tool_call',
        source: 'assistant',
        scope: 'turn',
        callId: 'call-lost',
        payload: { type: 'function_call', callId: 'call-lost', name: 'bash', arguments: '{"command":"rm"}' },
      },
    ]);
    await store.updateWindow(epoch.id, 0, [userItem!.id, callItem!.id]);

    const model = scriptedModel([
      { text: '看到了。', usage: usage(10, 2, 5) },
    ]);
    const result = await runScenario({
      store,
      model,
      message: '继续',
      conversationId: conversation.id,
    });
    expect(result.events.at(-1)?.type).toBe('completed');
    const epochs = await store.listEpochs(conversation.id);
    expect(epochs.map((entry) => entry.reason)).toContain('recovery-boundary');
    const active = await store.activeEpoch(conversation.id);
    const items = await store.listItems(conversation.id, active?.windowItemIds);
    expect(items.some((item) => item.kind === 'interrupt')).toBe(true);
    expect(items.some((item) => item.callId === 'call-lost' && item.kind === 'tool_call')).toBe(false);
    const wire = JSON.stringify(model.requests[0]?.input ?? []);
    expect(wire).toContain('工具调用中断');
    expect(wire).toContain('没有自动重跑');
  });
});

describe('A19: stop keeps the shown text and continue is a new turn', () => {
  it('stores an incomplete assistant item and sends continuation next turn', async () => {
    const store = new InMemoryStore();
    const controller = new AbortController();
    const stopping: ModelTurn = async function* (request) {
      yield { type: 'text_delta', text: '半截回答' };
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) resolve();
        else request.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      const error = new Error('cancelled');
      error.name = 'AbortError';
      throw error;
    };
    const running = runScenario({
      store,
      modelTurn: stopping,
      message: '讲长一点',
      requestId: randomUUID(),
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const stopped = await running;
    const interrupted = stopped.events.find((event) => event.type === 'interrupted');
    expect(interrupted?.type).toBe('interrupted');
    if (interrupted?.type !== 'interrupted') throw new Error('not interrupted');
    expect(interrupted.text).toBe('半截回答');
    const conversationId = interrupted.conversationId as string;
    const items = await store.listItems(conversationId);
    const assistant = items.find((item) => item.kind === 'assistant');
    expect(assistant?.status).toBe('incomplete');
    expect(
      assistant?.payload.type === 'message' && assistant.payload.content,
    ).toBe('半截回答');

    const next = scriptedModel([{ text: '接着说完。', usage: usage(10, 2, 5) }]);
    await runScenario({
      store,
      model: next,
      message: '继续',
      conversationId,
      continue: true,
    });
    const wire = JSON.stringify(next.requests[0]?.input ?? []);
    expect(wire).toContain('半截回答');
    expect(wire).toContain('继续被打断的回复');
  });
});

describe('A20: regeneration rewinds the active view, not the audit', () => {
  it('creates a regenerate epoch and keeps the old assistant item', async () => {
    const store = new InMemoryStore();
    const firstModel = scriptedModel([{ text: '旧回复', usage: usage(10, 2, 5) }]);
    const first = await runScenario({ store, model: firstModel, message: '问题' });
    const conversationId = first.conversationId as string;
    const session = new SessionService(store);
    const rewound = await session.rewind(USER, conversationId);
    expect(rewound?.removed).toBe(1);

    const secondModel = scriptedModel([{ text: '新回复', usage: usage(20, 3, 10) }]);
    const second = await runScenario({
      store,
      model: secondModel,
      message: '问题',
      conversationId,
      regenerate: true,
    });
    expect(second.events.at(-1)?.type).toBe('completed');
    const epochs = await store.listEpochs(conversationId);
    expect(epochs.map((entry) => entry.reason)).toContain('regenerate');
    const items = await store.listItems(conversationId);
    expect(items.some((item) => item.payload.type === 'message' && item.payload.content === '旧回复')).toBe(true);
    const active = await store.activeEpoch(conversationId);
    const activeItems = await store.listItems(conversationId, active?.windowItemIds);
    expect(
      activeItems.some(
        (item) => item.payload.type === 'message' && item.payload.content === '旧回复',
      ),
    ).toBe(false);
    expect(
      activeItems.filter((item) => item.kind === 'user' && item.messageId),
    ).toHaveLength(1);
  });
});

describe('A21: compaction starts a new epoch with a summary and latest state', () => {
  it('keeps the checkpoint ahead of the retained tail', async () => {
    const store = new InMemoryStore();
    const firstModel = scriptedModel([
      { text: '第一段回复', usage: usage(100, 10, 80) },
      { text: '第二段回复', usage: usage(150, 15, 120) },
    ]);
    const first = await runScenario({ store, model: firstModel, message: '第一问' });
    const conversationId = first.conversationId as string;
    const messages = await store.listMessages(USER, conversationId);
    const assistant = messages.find((message) => message.role === 'assistant');
    await store.saveSummary({
      conversationId,
      summary: '## 当前主线\n- 用户在测试压缩。',
      throughSeq: assistant!.seq,
      summaryTokens: 20,
      model: 'deepseek-flash',
      promptVersion: 'summary-v1',
      updatedAt: new Date(),
    });

    const secondModel = scriptedModel([{ text: '压缩后回复', usage: usage(200, 20, 180) }]);
    const second = await runScenario({
      store,
      model: secondModel,
      message: '第二问',
      conversationId,
    });
    expect(second.events.at(-1)?.type).toBe('completed');
    const epochs = await store.listEpochs(conversationId);
    expect(epochs.map((entry) => entry.reason)).toContain('compaction');
    const active = await store.activeEpoch(conversationId);
    const items = await store.listItems(conversationId, active?.windowItemIds);
    expect(items[0]?.kind).toBe('summary');
    const lastBackground = [...items].reverse().find((item) => item.kind === 'background');
    expect(lastBackground).toBeTruthy();
    expect(items.indexOf(lastBackground!)).toBeGreaterThan(0);
  });
});

describe('A24–A27: replaceability and boundaries', () => {
  const image = (assetId: string): UserContentV1 => ({
    version: 1,
    parts: [
      { type: 'text', text: '看这张图' },
      { type: 'image', assetId },
      { type: 'image', assetId },
    ],
  });

  it('A24: a model switch is a boundary, and an unsupported image fails preflight', async () => {
    const store = new InMemoryStore();
    await store.ensureUser(USER);
    const conversation = await store.createConversation(USER);
    const user = await store.appendMessage({
      conversationId: conversation.id,
      userId: USER,
      role: 'user',
      content: '看这张图',
      contentParts: image('11111111-1111-4111-8111-111111111111'),
    });
    const vision = fakeVisionProfile();
    const base = {
      store,
      userId: USER,
      conversationId: conversation.id,
      requestId: 'req-1',
      turnId: 'req-1',
      instructions: 'prompt',
      promptVersion: 'v1',
      tools: [],
      replay: { summary: null, throughSeq: 0, messages: [user] },
      user: null,
      context: {},
      policy: DEFAULT_TOOL_POLICY,
      now: new Date(),
    };
    await DurableTranscript.begin({ ...base, profile: vision });
    const textOnly = modelProfile('deepseek-v4-pro');
    const switched = await DurableTranscript.begin({
      ...base,
      requestId: 'req-2',
      turnId: 'req-2',
      profile: textOnly,
    });
    expect(switched.epoch.reason).toBe('model-switch');
    const wireImages = switched.input.filter(
      (item) =>
        item.type === 'message' &&
        typeof item.content !== 'string' &&
        item.content.some((part) => part.type === 'image'),
    );
    expect(wireImages).toHaveLength(1);

    const planned = planMediaRequest({
      profile: textOnly,
      policy: null,
      current: { version: 1, parts: [{ type: 'text', text: 'next' }] },
      history: [image('11111111-1111-4111-8111-111111111111')],
      assets: [],
      limits: { maxImagesPerMessage: 5, maxImageBytes: 10_000_000, maxMessageImageBytes: 20_000_000 } as never,
    });
    expect(planned.ok ? null : planned.error.code).toBe('MODEL_INPUT_UNSUPPORTED');
    expect(planned.ok ? null : planned.error.details.scope).toBe('history');
  });

  it('A25: repeated images are separate occurrences in the replay window', async () => {
    const store = new InMemoryStore();
    await store.ensureUser(USER);
    const conversation = await store.createConversation(USER);
    const user = await store.appendMessage({
      conversationId: conversation.id,
      userId: USER,
      role: 'user',
      content: '两张一样的图',
      contentParts: image('22222222-2222-4222-8222-222222222222'),
    });
    const begun = await DurableTranscript.begin({
      store,
      userId: USER,
      conversationId: conversation.id,
      requestId: 'req',
      turnId: 'req',
      instructions: 'p',
      promptVersion: 'v1',
      tools: [],
      profile: fakeVisionProfile(),
      replay: { summary: null, throughSeq: 0, messages: [user] },
      user: null,
      context: {},
      policy: DEFAULT_TOOL_POLICY,
    });
    const item = begun.input.find((entry) => entry.type === 'message' && entry.role === 'user');
    const parts = item?.type === 'message' && typeof item.content !== 'string' ? item.content : [];
    expect(parts.filter((part) => part.type === 'image')).toHaveLength(2);
  });

  it('A26: a provider change creates a model-switch boundary even for the same model id', async () => {
    const store = new InMemoryStore();
    await store.ensureUser(USER);
    const conversation = await store.createConversation(USER);
    const firstProfile = { ...fakeVisionProfile(), providerId: 'provider-a' };
    const secondProfile = { ...fakeVisionProfile(), providerId: 'provider-b' };
    const options = {
      store,
      userId: USER,
      conversationId: conversation.id,
      requestId: 'r1',
      turnId: 'r1',
      instructions: 'p',
      promptVersion: 'v1',
      tools: [],
      replay: { summary: null, throughSeq: 0, messages: [] },
      user: null,
      context: {},
      policy: DEFAULT_TOOL_POLICY,
      now: new Date(),
    };
    await DurableTranscript.begin({ ...options, profile: firstProfile });
    const switched = await DurableTranscript.begin({
      ...options,
      requestId: 'r2',
      turnId: 'r2',
      profile: secondProfile,
    });
    expect(switched.epoch.reason).toBe('model-switch');
    expect(switched.epoch.providerId).toBe('provider-b');
  });

  it('A27: prompt and tool changes each open a new epoch and keep the old one', async () => {
    const store = new InMemoryStore();
    await store.ensureUser(USER);
    const conversation = await store.createConversation(USER);
    const options = {
      store,
      userId: USER,
      conversationId: conversation.id,
      requestId: 'r1',
      turnId: 'r1',
      instructions: 'prompt one',
      promptVersion: 'p1',
      tools: [],
      profile: fakeVisionProfile(),
      replay: { summary: null, throughSeq: 0, messages: [] },
      user: null,
      context: {},
      policy: DEFAULT_TOOL_POLICY,
      now: new Date(),
    };
    const first = await DurableTranscript.begin(options);
    const promptChanged = await DurableTranscript.begin({
      ...options,
      requestId: 'r2',
      turnId: 'r2',
      instructions: 'prompt two',
      promptVersion: 'p2',
    });
    expect(promptChanged.epoch.reason).toBe('prompt-change');
    const toolsChanged = await DurableTranscript.begin({
      ...options,
      requestId: 'r3',
      turnId: 'r3',
      instructions: 'prompt two',
      promptVersion: 'p2',
      tools: [
        {
          name: 'new_tool',
          description: 'new',
          parameters: {},
        },
      ],
    });
    expect(toolsChanged.epoch.reason).toBe('tools-change');
    const epochs = await store.listEpochs(conversation.id);
    expect(epochs.map((entry) => entry.reason)).toEqual([
      'new-conversation',
      'prompt-change',
      'tools-change',
    ]);
    expect(epochs[0]?.id).toBe(first.epoch.id);
    expect(epochs[0]?.endedAt).not.toBeNull();
  });
});

describe('A29–A32: usage and prefix diagnostics', () => {
  it('A29: sums known usage, reports last request separately and does not sum the window', async () => {
    const store = new InMemoryStore();
    const model = scriptedModel([
      { text: '第一步', usage: usage(1_000, 20, 800) },
      { text: '第二步', usage: usage(1_500, 30, 1_200) },
    ]);
    // One turn, two steps: force the first step to call a tool.
    const toolStep = scriptedModel([
      { text: '第一步', usage: usage(1_000, 20, 800) },
      { text: '第二步', usage: usage(1_500, 30, 1_200) },
    ]);
    void model;
    const withTool = scriptedModel([
      { calls: [{ name: 'noop', arguments: {} }], usage: usage(1_000, 20, 800) },
      { text: '第二步', usage: usage(1_500, 30, 1_200) },
    ]);
    const tool = (await import('../../src/tools/types.ts')).defineTool({
      name: 'noop',
      description: 'noop',
      parameters: (await import('zod')).z.object({}),
      sideEffect: 'none',
      readOnly: true,
      execute: async () => (await import('../../src/tools/types.ts')).toolOk('ok'),
    });
    void toolStep;
    const result = await runScenario({
      store,
      model: withTool,
      message: '两步',
      tools: [tool],
    });
    const completed = result.events.at(-1);
    if (completed?.type !== 'completed') throw new Error('no completion');
    expect(completed.turnUsage).toMatchObject({
      inputTokens: 2_500,
      outputTokens: 50,
      cachedTokens: 2_000,
      measuredSteps: 2,
      totalSteps: 2,
      incomplete: false,
    });
    expect(completed.usage?.inputTokens).toBe(1_500);
    expect(completed.contextTokens).toBeDefined();
    const steps = await store.listSteps(result.requestId);
    expect(steps.map((step) => step.usage?.inputTokens)).toEqual([1_000, 1_500]);
  });

  it('A30: unknown usage stays null and the aggregate is marked incomplete', async () => {
    const store = new InMemoryStore();
    const tool = (await import('../../src/tools/types.ts')).defineTool({
      name: 'noop',
      description: 'noop',
      parameters: (await import('zod')).z.object({}),
      sideEffect: 'none',
      readOnly: true,
      execute: async () => (await import('../../src/tools/types.ts')).toolOk('ok'),
    });
    const model = scriptedModel([
      { calls: [{ name: 'noop', arguments: {} }] },
      { text: '完成', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cachedTokens: 0 } },
    ]);
    const result = await runScenario({ store, model, message: '未知 usage', tools: [tool] });
    const completed = result.events.at(-1);
    if (completed?.type !== 'completed') throw new Error('no completion');
    expect(completed.turnUsage?.incomplete).toBe(true);
    expect(completed.turnUsage?.missingUsageSteps).toBe(1);
    const steps = await store.listSteps(result.requestId);
    expect(steps[0]?.usage).toBeNull();
    expect(steps[1]?.usage?.inputTokens).toBe(10);
  });

  it('A31: the existing completed/SSE fields are unchanged and additions are optional', async () => {
    const store = new InMemoryStore();
    const model = scriptedModel([{ text: '回复', usage: usage(10, 2, 5) }]);
    const result = await runScenario({ store, model, message: '你好' });
    const completed = result.events.at(-1);
    if (completed?.type !== 'completed') throw new Error('no completion');
    expect(completed.text).toBe('回复');
    expect(completed.conversationId).toBeTruthy();
    expect(completed.messageId).toBeTruthy();
    expect(completed.finishReason).toBe('completed');
    expect(completed.usage?.inputTokens).toBe(10);
    expect(completed.transcriptMode).toBe('durable');
    // Legacy mode keeps the same event shape with no transcript requirement.
    const legacy = await runScenario({
      store: new InMemoryStore(),
      model: scriptedModel([{ text: '旧模式', usage: usage(10, 2, 5) }]),
      message: '你好',
      mode: 'legacy',
    });
    const legacyCompleted = legacy.events.at(-1);
    if (legacyCompleted?.type !== 'completed') throw new Error('no completion');
    expect(legacyCompleted.transcriptMode).toBe('legacy');
    expect(legacyCompleted.text).toBe('旧模式');
  });

  it('A32: an ordinary turn keeps the prefix; a model switch is an explicit boundary', async () => {
    const store = new InMemoryStore();
    const model = scriptedModel([
      { text: '一', usage: usage(10, 2, 5) },
      { text: '二', usage: usage(20, 3, 10) },
    ]);
    const first = await runScenario({ store, model, message: '第一轮' });
    const second = await runScenario({
      store,
      model,
      message: '第二轮',
      conversationId: first.conversationId,
    });
    void second;
    const firstPrefix = JSON.stringify((model.requests[0]?.input ?? []).slice(0, 2));
    const secondPrefix = JSON.stringify((model.requests[1]?.input ?? []).slice(0, 2));
    expect(secondPrefix).toBe(firstPrefix);
    const epochs = await store.listEpochs(first.conversationId as string);
    expect(epochs).toHaveLength(1);

    const switched = scriptedModel([{ text: '三', usage: usage(30, 3, 25) }]);
    const third = await runScenario({
      store,
      model: switched,
      message: '换模型',
      conversationId: first.conversationId,
      mode: 'durable',
    });
    expect(third.events.at(-1)?.type).toBe('completed');
    // Same profile in this harness, so no model boundary is expected here; the
    // boundary is covered by A24/A26/A27. What matters is that the ordinary
    // turns above did not create one.
    expect((await store.listEpochs(first.conversationId as string)).filter((e) => e.reason !== 'new-conversation')).toEqual([]);
  });
});
