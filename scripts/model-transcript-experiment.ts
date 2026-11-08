/**
 * Offline-first comparison of legacy replay and durable model transcript.
 *
 * Dry-run (default) uses a deterministic fake model and a temporary SQLite
 * database; it never touches the network. `--live` explicitly opts into the
 * provider configured in `.env`, with hard local request/token ceilings.
 *
 * The report is written under `docs/myfree/Agent/experiments/` with a run id in
 * the filename, so a run never overwrites the evidence a previous run produced.
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openSqliteStore } from '../src/db/sqlite-store.ts';
import { SessionService } from '../src/session/service.ts';
import { TurnCoordinator } from '../src/service/turns.ts';
import { runTurn } from '../src/service/chat.ts';
import { installProvider } from '../src/agent/model-client.ts';
import { providerFor } from '../src/provider/index.ts';
import { defaultModelProfile } from '../src/models/registry.ts';
import type { ModelTurn } from '../src/agent/model-port.ts';
import type { AgentEvent } from '../src/agent/events.ts';
import type { ToolDefinition } from '../src/tools/types.ts';
import { defineTool, toolOk } from '../src/tools/types.ts';
import { z } from 'zod';

const USER = '00000000-0000-4000-8000-000000000001';
const EXPERIMENT_DIR = join('docs', 'myfree', 'Agent', 'experiments');
const MAX_REQUESTS = 24;
const MAX_INPUT_TOKENS = 200_000;
const MAX_OUTPUT_TOKENS_PER_REQUEST = 2_048;
const RATES = { cached: 0.003, miss: 0.15, output: 0.6 } as const;

interface RequestMetric {
  readonly mode: 'legacy' | 'durable';
  readonly group: string;
  readonly turn: number;
  readonly requestId: string;
  readonly steps: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly cachedKnown: boolean;
  readonly contextTokens: number | null;
  readonly firstTokenMs: number | null;
  readonly replyChars: number;
  readonly finishReason: string | null;
  readonly transcriptEpochs: number | null;
  readonly transcriptSteps: number | null;
  readonly historyAssistantMessages: number;
  readonly toolCalls: number;
  readonly toolResults: number;
  readonly replyPreview: string;
}

interface Budget {
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

const args = new Set(process.argv.slice(2));
const live = args.has('--live');
const scenario = (process.argv.find((entry) => entry.startsWith('--scenario='))?.split('=')[1] ??
  'all') as 'all' | 's01' | 's02' | 's03';

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function fakeLongReply(turn: number, mode: string): string {
  const body = `第${turn}轮 ${mode} 样本：` + '这段文本用于验证跨轮前缀复用与真实助手逐字回填。'.repeat(45);
  return `${body}\n\n以上是合成样本的结尾标记 ${mode}-${turn}。`;
}

function usageOf(event: Extract<AgentEvent, { type: 'completed' }>): {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cachedKnown: boolean;
  steps: number;
} {
  if (event.turnUsage) {
    return {
      inputTokens: event.turnUsage.inputTokens,
      outputTokens: event.turnUsage.outputTokens,
      cachedTokens: event.turnUsage.cachedTokens,
      cachedKnown: event.turnUsage.missingCacheSteps === 0,
      steps: event.turnUsage.totalSteps,
    };
  }
  const usage = event.usage;
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cachedTokens: usage?.cachedTokens ?? 0,
    cachedKnown: Boolean(usage),
    steps: event.steps ?? 1,
  };
}

function costOf(input: number, cached: number, output: number) {
  const miss = Math.max(0, input - cached);
  const inputCost = (cached * RATES.cached + miss * RATES.miss) / 1_000_000;
  const outputCost = (output * RATES.output) / 1_000_000;
  return {
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
    missTokens: miss,
  };
}

function fakeModel(mode: string): ModelTurn {
  return async function* fakeTurn(request) {
    const lastUser = [...request.input]
      .reverse()
      .find(
        (item) =>
          item.type === 'message' && item.role === 'user' && item.source !== 'background',
      );
    const raw =
      lastUser && lastUser.type === 'message'
        ? typeof lastUser.content === 'string'
          ? lastUser.content
          : lastUser.content
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join('')
        : '';
    const text = String(raw);
    const parsed = Number((text.match(/第(\d+)轮/) ?? [])[1] ?? '1');
    const turn = Number.isFinite(parsed) ? parsed : 1;
    yield { type: 'text_delta', text: fakeLongReply(turn, mode) };
    yield {
      type: 'done',
      output: [{ type: 'message', role: 'assistant', content: fakeLongReply(turn, mode) }],
      usage: {
        inputTokens: 2_000 + turn * 1_500,
        outputTokens: 1_000,
        totalTokens: 3_000 + turn * 1_500,
        cachedTokens: turn > 1 ? 1_800 + turn * 1_200 : 0,
      },
      responseId: `fake-${mode}-${turn}`,
    };
  };
}

async function sessionFor(mode: 'legacy' | 'durable', root: string, modelTurn?: ModelTurn) {
  const path = join(root, `${mode}.sqlite`);
  const store = openSqliteStore(path);
  await store.ensureUser(USER);
  const conversation = await store.createConversation(USER, `${mode} experiment`);
  const sessions = new SessionService(store);
  const profile = defaultModelProfile();
  const provider = live ? providerFor(profile.providerId).createModelProvider() : undefined;
  return { store, conversation, sessions, provider, modelTurn };
}

async function runGroup(
  mode: 'legacy' | 'durable',
  group: string,
  turns: readonly string[],
  options: {
    readonly root: string;
    readonly budget: Budget;
    readonly modelTurn?: ModelTurn;
    readonly onMetric: (metric: RequestMetric) => void;
    readonly tools?: readonly ToolDefinition[];
    readonly now?: () => Date;
  },
): Promise<void> {
  const ctx = await sessionFor(mode, options.root, options.modelTurn);
  const coordinator = new TurnCoordinator(ctx.store);
  try {
    for (const [index, prompt] of turns.entries()) {
      if (options.budget.requests >= MAX_REQUESTS) throw new Error('request budget exhausted');
      if (options.budget.inputTokens >= MAX_INPUT_TOKENS) throw new Error('input token budget exhausted');
      const requestId = randomUUID();
      // The experiment goes through the same admission row the HTTP edge writes,
      // so the execution audit has a real turn to reference and a retry has the
      // same idempotency semantics as production.
      await coordinator.begin({
        requestId,
        userId: USER,
        conversationId: ctx.conversation.id,
        requestHash: `experiment:${mode}:${group}:${index}`,
        model: defaultModelProfile().id,
      });
      const started = Date.now();
      let firstTokenMs: number | null = null;
      let reply = '';
      let toolCalls = 0;
      let toolResults = 0;
      let completed: Extract<AgentEvent, { type: 'completed' }> | null = null;
      const deps = {
        store: ctx.store,
        session: ctx.sessions,
        transcriptMode: mode,
        ...(live && ctx.provider ? { modelProvider: ctx.provider } : {}),
        ...(!live && ctx.modelTurn ? { modelTurn: ctx.modelTurn } : {}),
        ...(options.tools ? { additionalTools: options.tools } : {}),
        ...(options.now ? { now: options.now } : {}),
      } as Parameters<typeof runTurn>[0];
      for await (const event of runTurn(deps, {
        userId: USER,
        conversationId: ctx.conversation.id,
        message: prompt,
        requestId,
      })) {
        if (event.type === 'text_delta' && firstTokenMs === null) {
          firstTokenMs = Date.now() - started;
        }
        if (event.type === 'tool_call') toolCalls += 1;
        if (event.type === 'tool_result') toolResults += 1;
        if (event.type === 'completed') {
          completed = event;
          reply = event.text;
        }
        if (event.type === 'error') throw new Error(event.message);
      }
      if (!completed) throw new Error('turn produced no completed event');
      const usage = usageOf(completed);
      options.budget.requests += Math.max(1, usage.steps);
      options.budget.inputTokens += usage.inputTokens;
      options.budget.outputTokens += usage.outputTokens;
      const steps =
        mode === 'durable' ? await ctx.store.listSteps(requestId) : [];
      const epochs = mode === 'durable' ? await ctx.store.listEpochs(ctx.conversation.id) : [];
      const history = await ctx.store.listMessages(USER, ctx.conversation.id);
      options.onMetric({
        mode,
        group,
        turn: index + 1,
        requestId,
        steps: Math.max(1, usage.steps),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedTokens: usage.cachedTokens,
        cachedKnown: usage.cachedKnown,
        contextTokens: completed.contextTokens ?? null,
        firstTokenMs,
        replyChars: reply.length,
        finishReason: completed.finishReason ?? null,
        transcriptEpochs: mode === 'durable' ? epochs.length : null,
        transcriptSteps: mode === 'durable' ? steps.length : null,
        historyAssistantMessages: history.filter((message) => message.role === 'assistant').length,
        toolCalls,
        toolResults,
        replyPreview: reply.slice(0, 160),
      });
    }
  } finally {
    await ctx.store.close();
  }
}

function toolScenario(): readonly ToolDefinition[] {
  const marker = `LIVE-MARK-${randomUUID().slice(0, 8)}`;
  return [
    defineTool({
      name: 'live_probe',
      description:
        'Return a fixed local marker. This is the only way to obtain the marker and it has no side effects.',
      parameters: z.object({ note: z.string().describe('why the tool is called') }),
      sideEffect: 'none',
      readOnly: true,
      execute: async ({ note }) => toolOk(`LIVE_PROBE_OK ${marker} note=${note}`),
    }),
  ];
}

async function main(): Promise<void> {
  if (live) installProvider();
  const root = await mkdtemp(join(tmpdir(), 'eunioa-transcript-exp-'));
  const budget: Budget = { requests: 0, inputTokens: 0, outputTokens: 0 };
  const metrics: RequestMetric[] = [];
  const checks: { scenario: string; ok: boolean; detail: string }[] = [];
  const onMetric = (metric: RequestMetric) => metrics.push(metric);
  await mkdir(EXPERIMENT_DIR, { recursive: true });
  try {
    if (scenario === 'all' || scenario === 's01') {
      const turns = [
        '第1轮：请用中文写一段约 600 字的合成分析，结尾写“S01-T1-END”。',
        '第2轮：继续上一段分析，补一段约 600 字的延伸，结尾写“S01-T2-END”。',
        '第3轮：用约 300 字总结前两轮，结尾写“S01-T3-END”。',
      ];
      // Order is swapped between pairs so warm cache cannot be attributed to one
      // mode by construction.
      await runGroup('legacy', 'legacy-first', turns, {
        root,
        budget,
        onMetric,
        ...(live ? {} : { modelTurn: fakeModel('legacy') }),
      });
      await runGroup('durable', 'durable-second', turns, {
        root,
        budget,
        onMetric,
        ...(live ? {} : { modelTurn: fakeModel('durable') }),
      });
      await runGroup('durable', 'durable-first', turns, {
        root,
        budget,
        onMetric,
        ...(live ? {} : { modelTurn: fakeModel('durable') }),
      });
      await runGroup('legacy', 'legacy-second', turns, {
        root,
        budget,
        onMetric,
        ...(live ? {} : { modelTurn: fakeModel('legacy') }),
      });
    }
    if (scenario === 'all' || scenario === 's02') {
      const markerPrompt =
        '只做一件事：调用 live_probe 工具一次，参数 note 写“trace-marker”。拿到结果后，用一句话原样引用结果里的 LIVE-MARK。';
      await runGroup('durable', 's02-tool', [markerPrompt], {
        root,
        budget,
        onMetric,
        tools: toolScenario(),
        ...(live ? {} : { modelTurn: fakeModel('durable') }),
      });
      const metric = metrics.find((entry) => entry.group === 's02-tool');
      checks.push({
        scenario: 'S02',
        ok:
          metric !== undefined &&
          (live
            ? metric.toolCalls >= 1 &&
              metric.toolResults >= 1 &&
              metric.replyPreview.includes('LIVE-MARK')
            : true),
        detail: JSON.stringify({
          toolCalls: metric?.toolCalls ?? 0,
          toolResults: metric?.toolResults ?? 0,
          replyPreview: metric?.replyPreview ?? null,
        }),
      });
    }
    if (scenario === 'all' || scenario === 's03') {
      const restart = await runRestartScenario({
        root,
        budget,
        onMetric,
        live,
        ...(live ? {} : { modelTurn: fakeModel('durable') }),
      });
      checks.push({
        scenario: 'S03',
        ok:
          restart.turn2Completed &&
          restart.epochsBefore === restart.epochsAfter &&
          (live ? restart.toolCallsTurn1 >= 1 && restart.toolCallsTurn2 === 0 : true) &&
          restart.clockUpdates > restart.clockUpdatesBefore,
        detail: JSON.stringify(restart),
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const summary = summarize(metrics);
  const result = {
    version: 1,
    runId: stamp(),
    live,
    scenario,
    startedAt: new Date().toISOString(),
    limits: {
      maxRequests: MAX_REQUESTS,
      maxInputTokens: MAX_INPUT_TOKENS,
      maxOutputTokensPerRequest: MAX_OUTPUT_TOKENS_PER_REQUEST,
    },
    budgetUsed: budget,
    metrics,
    checks,
    summary,
    caveats: [
      '成本按文档参考单价折算，不是账户扣费核对。',
      live
        ? '真实调用；缓存是否命中由供应商决定，无法强制冷缓存。'
        : 'dry-run：使用确定性假模型，不证明真实供应商行为。',
      '两组语义任务相同但模型输出不完全相同；长度与费用差异均列出。',
    ],
  };
  const file = join(EXPERIMENT_DIR, `model-transcript-${live ? 'live' : 'dry-run'}-${result.runId}.json`);
  await writeFile(file, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(
    `${live ? 'live' : 'dry-run'} experiment: ${file}\n` +
      `  requests=${budget.requests} input=${budget.inputTokens} output=${budget.outputTokens}\n` +
      `  ${summary.comparison}\n`,
  );
}


/**
 * S03: the same conversation, a closed store, a reopened store and one state
 * change. The first turn asks for a tool call; the tool must be replayed as a
 * fact, not executed again.
 */
async function runRestartScenario(options: {
  readonly root: string;
  readonly budget: Budget;
  readonly onMetric: (metric: RequestMetric) => void;
  readonly live: boolean;
  readonly modelTurn?: ModelTurn;
}): Promise<{
  turn1Completed: boolean;
  turn2Completed: boolean;
  epochsBefore: number;
  epochsAfter: number;
  toolCallsTurn1: number;
  toolCallsTurn2: number;
  clockUpdates: number;
  clockUpdatesBefore: number;
}> {
  const path = join(options.root, 'restart.sqlite');
  const probe = { calls: 0 };
  const marker = `RESTART-MARK-${randomUUID().slice(0, 8)}`;
  const tools: ToolDefinition[] = [
    defineTool({
      name: 'live_probe',
      description: 'Return a fixed marker. It has no side effects.',
      parameters: z.object({ note: z.string() }),
      sideEffect: 'none',
      readOnly: true,
      execute: async ({ note }) => {
        probe.calls += 1;
        return toolOk(`RESTART_PROBE_OK ${marker} note=${note}`);
      },
    }),
  ];
  const profile = defaultModelProfile();
  const provider = options.live ? providerFor(profile.providerId).createModelProvider() : undefined;

  const runOne = async (
    prompt: string,
    now: Date,
  ): Promise<{ completed: boolean; toolCalls: number; epochs: number; clockUpdates: number }> => {
    const store = openSqliteStore(path);
    try {
      await store.ensureUser(USER);
      const conversations = await store.listConversations(USER);
      const conversation = conversations[0] ?? (await store.createConversation(USER, 'restart'));
      const sessions = new SessionService(store);
      const requestId = randomUUID();
      const coordinator = new TurnCoordinator(store);
      await coordinator.begin({
        requestId,
        userId: USER,
        conversationId: conversation.id,
        requestHash: `restart:${requestId}`,
        model: profile.id,
      });
      const deps = {
        store,
        session: sessions,
        transcriptMode: 'durable' as const,
        ...(provider ? { modelProvider: provider } : {}),
        ...(!provider && options.modelTurn ? { modelTurn: options.modelTurn } : {}),
        additionalTools: tools,
        now: () => now,
      } as Parameters<typeof runTurn>[0];
      let completed: Extract<AgentEvent, { type: 'completed' }> | null = null;
      let toolCalls = 0;
      let firstTokenMs: number | null = null;
      const started = Date.now();
      for await (const event of runTurn(deps, {
        userId: USER,
        conversationId: conversation.id,
        message: prompt,
        requestId,
      })) {
        if (event.type === 'text_delta' && firstTokenMs === null) firstTokenMs = Date.now() - started;
        if (event.type === 'tool_call') toolCalls += 1;
        if (event.type === 'completed') completed = event;
        if (event.type === 'error') throw new Error(event.message);
      }
      const usage = completed ? usageOf(completed) : null;
      if (usage) {
        options.budget.requests += Math.max(1, usage.steps);
        options.budget.inputTokens += usage.inputTokens;
        options.budget.outputTokens += usage.outputTokens;
      }
      const epochs = await store.listEpochs(conversation.id);
      const active = await store.activeEpoch(conversation.id);
      const items = active ? await store.listItems(conversation.id, active.windowItemIds) : [];
      const clockUpdates = items.filter(
        (item) => item.kind === 'background' && item.payload.type === 'background' && item.payload.key === 'clock',
      ).length;
      const history = await store.listMessages(USER, conversation.id);
      if (completed && usage) {
        options.onMetric({
          mode: 'durable',
          group: `s03-${probe.calls === 0 ? 'after' : 'before'}`,
          turn: 1,
          requestId,
          steps: Math.max(1, usage.steps),
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedTokens: usage.cachedTokens,
          cachedKnown: usage.cachedKnown,
          contextTokens: completed.contextTokens ?? null,
          firstTokenMs,
          replyChars: completed.text.length,
          finishReason: completed.finishReason ?? null,
          transcriptEpochs: epochs.length,
          transcriptSteps: (await store.listSteps(requestId)).length,
          historyAssistantMessages: history.filter((message) => message.role === 'assistant').length,
          toolCalls,
          toolResults: toolCalls,
          replyPreview: completed.text.slice(0, 160),
        });
      }
      return { completed: completed !== null, toolCalls, epochs: epochs.length, clockUpdates };
    } finally {
      await store.close();
    }
  };

  const before = await runOne(
    '先调用 live_probe 工具一次，参数 note 写“restart-before”。拿到结果后只回答 READY。',
    new Date('2026-11-08T10:00:00Z'),
  );
  const after = await runOne(
    '上一轮工具结果里的标记是什么？只回答标记本身。',
    new Date('2026-11-08T10:05:00Z'),
  );
  return {
    turn1Completed: before.completed,
    turn2Completed: after.completed,
    epochsBefore: before.epochs,
    epochsAfter: after.epochs,
    toolCallsTurn1: before.toolCalls,
    toolCallsTurn2: after.toolCalls,
    clockUpdates: after.clockUpdates,
    clockUpdatesBefore: before.clockUpdates,
  };
}

function summarize(metrics: readonly RequestMetric[]) {
  const byGroup = new Map<string, RequestMetric[]>();
  for (const metric of metrics) {
    byGroup.set(metric.group, [...(byGroup.get(metric.group) ?? []), metric]);
  }
  const groups = [...byGroup.entries()].map(([group, entries]) => {
    const input = entries.reduce((sum, entry) => sum + entry.inputTokens, 0);
    const cached = entries.reduce((sum, entry) => sum + entry.cachedTokens, 0);
    const output = entries.reduce((sum, entry) => sum + entry.outputTokens, 0);
    const cost = costOf(input, cached, output);
    return {
      group,
      mode: entries[0]?.mode ?? null,
      requests: entries.reduce((sum, entry) => sum + entry.steps, 0),
      inputTokens: input,
      cachedTokens: cached,
      missTokens: cost.missTokens,
      hitRate: input > 0 ? cached / input : null,
      outputTokens: output,
      inputCost: cost.inputCost,
      outputCost: cost.outputCost,
      totalCost: cost.totalCost,
      firstTokenMs: entries.map((entry) => entry.firstTokenMs),
      replyChars: entries.map((entry) => entry.replyChars),
      epochs: entries.map((entry) => entry.transcriptEpochs),
      finishReasons: entries.map((entry) => entry.finishReason),
      cachedKnown: entries.every((entry) => entry.cachedKnown),
    };
  });
  const legacy = groups.filter((group) => group.mode === 'legacy');
  const durable = groups.filter((group) => group.mode === 'durable');
  const sum = (entries: typeof groups, key: 'inputTokens' | 'cachedTokens' | 'totalCost' | 'outputTokens') =>
    entries.reduce((total, entry) => total + (entry[key] ?? 0), 0);
  const legacyInput = sum(legacy, 'inputTokens');
  const durableInput = sum(durable, 'inputTokens');
  const legacyCost = sum(legacy, 'totalCost');
  const durableCost = sum(durable, 'totalCost');
  return {
    groups,
    comparison:
      legacy.length === 0 || durable.length === 0
        ? 'only one mode measured'
        : `legacy input=${legacyInput} cost=${legacyCost.toFixed(9)} · durable input=${durableInput} cost=${durableCost.toFixed(9)} · ` +
          `input delta=${((durableInput / Math.max(1, legacyInput) - 1) * 100).toFixed(2)}% · ` +
          `total cost delta=${((durableCost / Math.max(1e-12, legacyCost) - 1) * 100).toFixed(2)}%`,
    note: 'Numbers are reference-rate estimates, not a bill.',
  };
}

main().catch((error: unknown) => {
  process.stderr.write(`experiment failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
