/**
 * The compaction boundary.
 *
 * The important assertions are not "a summary was generated" but:
 *   - the current turn is never summarized away,
 *   - the raw messages remain in the store,
 *   - a failed summary does not advance the boundary,
 *   - a large prefix is split into bounded model calls.
 */

import { describe, expect, it } from 'vitest';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { MODEL_IDS } from '../../src/config.ts';
import { modelProfile } from '../../src/models/registry.ts';
import { DEFAULT_SESSION_CONFIG, type SessionConfig } from '../../src/session/config.ts';
import { EVIDENCE_HEADING, type WorkLedger } from '../../src/session/checkpoint.ts';
import { SessionService } from '../../src/session/service.ts';
import { summaryPromptVersion, type SummaryRequest } from '../../src/session/summary.ts';
import type { TaskBoardSnapshot } from '../../src/session/task-board.ts';

const USER = 'user-1';

function config(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    ...DEFAULT_SESSION_CONFIG,
    inputBudgetTokens: 240,
    promptReserveTokens: 40, // replay budget 200; trigger at 100
    compactTriggerRatio: 0.5,
    keepRecentMessages: 1,
    keepRecentTokens: 1_000,
    compactMinMessages: 2,
    summaryMaxInputTokens: 1_024,
    summaryTargetTokens: 20,
    replayMaxMessages: 100,
    ...overrides,
  };
}

async function seed(count: number, chars = 300): Promise<{
  store: InMemoryStore;
  conversationId: string;
  messages: Awaited<ReturnType<InMemoryStore['appendMessage']>>[];
}> {
  const store = new InMemoryStore();
  await store.ensureUser(USER);
  const conversation = await store.createConversation(USER);
  const messages: Awaited<ReturnType<InMemoryStore['appendMessage']>>[] = [];
  for (let index = 0; index < count; index += 1) {
    messages.push(
      await store.appendMessage({
        conversationId: conversation.id,
        userId: USER,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `第${index + 1}轮`.padEnd(chars, '话'),
      }),
    );
  }
  return { store, conversationId: conversation.id, messages };
}

describe('SessionService compaction', () => {
  it('summarizes the old prefix, keeps the protected tail and never deletes raw messages', async () => {
    const { store, conversationId, messages } = await seed(6);
    const calls: SummaryRequest[] = [];
    const sessions = new SessionService(store, {
      config: config(),
      summarize: async (request) => {
        calls.push(request);
        return '更早的摘要';
      },
    });

    const replay = await sessions.prepare(USER, conversationId, {
      protectSeq: messages.at(-1)!.seq,
    });

    expect(replay.summary).toBe('更早的摘要');
    expect(replay.throughSeq).toBe(messages.at(-2)!.seq);
    expect(replay.messages.map((message) => message.seq)).toEqual([messages.at(-1)!.seq]);
    expect(calls.length).toBeGreaterThan(0);
    // The summary is chunked: 5 old messages at ~304 tokens each against a
    // 768-token chunk budget cannot fit in one call.
    expect(calls.length).toBeGreaterThan(1);

    expect(await store.getSummary(conversationId)).toMatchObject({
      summary: '更早的摘要',
      throughSeq: messages.at(-2)!.seq,
    });
    // Raw history is intact; compaction changes the model window, not storage.
    expect(await store.listMessages(USER, conversationId)).toHaveLength(6);
  });

  it('does not summarize the current user message even when it is older than the recent tail', async () => {
    const { store, conversationId, messages } = await seed(4);
    const sessions = new SessionService(store, {
      config: config({ keepRecentMessages: 0 }),
      summarize: async () => '摘要',
    });

    const replay = await sessions.prepare(USER, conversationId, {
      protectSeq: messages.at(-1)!.seq,
    });

    // keepRecentMessages=0 would otherwise archive everything, but the protected
    // current turn is kept.
    expect(replay.messages.at(-1)?.seq).toBe(messages.at(-1)!.seq);
    expect(replay.throughSeq).toBeLessThan(messages.at(-1)!.seq);
  });

  it('does not advance the boundary when the summarizer fails', async () => {
    const { store, conversationId, messages } = await seed(6);
    const sessions = new SessionService(store, {
      config: config(),
      summarize: async () => {
        throw new Error('model down');
      },
    });

    const result = await sessions.compact(USER, conversationId, {
      protectSeq: messages.at(-1)!.seq,
    });

    expect(result.compacted).toBe(false);
    expect(result.reason).toBe('summary_failed');
    expect(await store.getSummary(conversationId)).toBeNull();
    expect(await store.listMessages(USER, conversationId)).toHaveLength(6);
  });

  it('does not advance the boundary when the summary is not smaller than the shadowed content', async () => {
    const { store, conversationId, messages } = await seed(3, 10);
    const sessions = new SessionService(store, {
      config: config({ summaryTargetTokens: 2_000 }),
      summarize: async () => '大'.repeat(500),
    });

    const result = await sessions.compact(USER, conversationId, {
      protectSeq: messages.at(-1)!.seq,
    });

    expect(result.compacted).toBe(false);
    expect(result.reason).toBe('summary_failed');
    expect(await store.getSummary(conversationId)).toBeNull();
    expect(await store.listMessages(USER, conversationId)).toHaveLength(3);
  });

  it('leaves a short conversation alone', async () => {
    const { store, conversationId } = await seed(2, 10);
    const sessions = new SessionService(store, {
      config: config({ inputBudgetTokens: 10_000, compactTriggerRatio: 0.9 }),
      summarize: async () => '不该被调用',
    });

    const replay = await sessions.prepare(USER, conversationId);
    expect(replay.summary).toBeNull();
  });

  it('uses the pinned model’s budget, not the process default', async () => {
    const store = new InMemoryStore();
    await store.ensureUser(USER);
    const big = modelProfile(MODEL_IDS.companion);
    const small = {
      ...big,
      id: 'small-test',
      contextWindowTokens: 2_000,
      maxOutputTokens: 10,
      safetyBufferTokens: 10,
      defaultInputBudgetTokens: 1_200,
    };

    const smallConversation = await store.createConversation(USER, 'small', 'small-test');
    for (let index = 0; index < 20; index += 1) {
      await store.appendMessage({
        conversationId: smallConversation.id,
        userId: USER,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `第${index + 1}轮`.padEnd(30, '话'),
      });
    }
    const last = (await store.listMessages(USER, smallConversation.id)).at(-1)!;

    const sessions = new SessionService(store, {
      config: config({
        inputBudgetTokens: null,
        promptReserveTokens: 40,
        compactTriggerRatio: 0.5,
        keepRecentMessages: 1,
      }),
      model: big,
      resolveModel: (id) => (id === 'small-test' ? small : big),
      summarize: async () => '小模型摘要',
    });

    const replay = await sessions.prepare(USER, smallConversation.id, { protectSeq: last.seq });
    expect(replay.summary).toBe('小模型摘要');
    expect(replay.throughSeq).toBeLessThan(last.seq);
  });

  it('compacts an idle conversation once it is older than the threshold', async () => {
    const { store, conversationId } = await seed(6);
    const sessions = new SessionService(store, {
      config: config(),
      summarize: async () => '空闲摘要',
    });

    const compacted = await sessions.compactIdle(
      USER,
      60,
      new Date(Date.now() + 2 * 60 * 60 * 1000),
    );

    expect(compacted).toBe(1);
    expect((await store.getSummary(conversationId))?.summary).toBe('空闲摘要');
    expect(await store.listMessages(USER, conversationId)).toHaveLength(6);
  });
});

/**
 * The task checkpoint's wiring.
 *
 * The unit tests in `checkpoint.test.ts` prove the ledger and the prompt. These
 * prove the service actually reads the trace, asks for the right template, and
 * stores facts rather than model recollection.
 */
describe('SessionService task checkpoints', () => {
  const ledger: WorkLedger = {
    toolCalls: 2,
    files: [
      {
        path: 'src/session/service.ts',
        operation: 'edit',
        calls: 2,
        lastStatus: 'passed',
        evidence: 'turn turn-1/seq 3',
      },
    ],
    commands: [
      {
        command: 'npm test',
        kind: 'test',
        status: 'failed',
        exitCode: 1,
        outputTail: '1 failed',
        evidence: 'turn turn-1/seq 5',
      },
    ],
    pending: [
      {
        toolName: 'bash',
        summary: '运行 npm run build',
        reason: 'no_result',
        evidence: 'turn turn-1/seq 7',
      },
    ],
    searched: false,
    trace: ['turn turn-1（2026-11-08T09:00:00Z）· 2 次工具调用'],
  };

  const board: TaskBoardSnapshot = {
    runId: 'run-1',
    tasks: [
      {
        id: 'task-1',
        title: '拆分 compact',
        status: 'running',
        required: true,
        acceptance: 'npm test 通过',
      },
    ],
  };

  const narrative = [
    '## 任务与约束',
    '- 拆分 compact，保持旧摘要行为',
    '## 文件与改动理由',
    '- src/session/service.ts — 抽出上下文收集',
    '## 下一步',
    '- 跑 npm test',
  ].join('\n');

  it('asks for the coding template and stores the evidence and board', async () => {
    const { store, conversationId, messages } = await seed(6);
    const requests: SummaryRequest[] = [];
    const sessions = new SessionService(store, {
      config: config({ summaryTargetTokens: 2_000 }),
      summarize: async (request) => {
        requests.push(request);
        return narrative;
      },
      evidence: { collect: async () => ledger },
      taskBoard: { snapshot: async () => board },
    });

    const result = await sessions.compact(USER, conversationId, {
      protectSeq: messages.at(-1)!.seq,
    });

    expect(result.compacted).toBe(true);
    expect(requests[0]?.mode).toBe('coding');
    expect(requests[0]?.ledger).toEqual(ledger);
    expect(requests[0]?.board).toEqual(board);

    const stored = await store.getSummary(conversationId);
    expect(stored?.summary).toContain('## 任务与约束');
    expect(stored?.summary).toContain(EVIDENCE_HEADING);
    expect(stored?.summary).toContain('src/session/service.ts');
    expect(stored?.summary).toContain('npm test');
    expect(stored?.summary).toContain('没有返回结果');
    expect(stored?.summary).toContain('task-1');
    expect(stored?.promptVersion).toBe(summaryPromptVersion('coding'));
  });

  it('rebuilds the appendix instead of carrying the previous one forward', async () => {
    const { store, conversationId, messages } = await seed(6);
    await store.saveSummary({
      conversationId,
      summary: [
        '## 任务与约束',
        '- 旧任务',
        '',
        EVIDENCE_HEADING,
        '### 文件变更',
        '- `src/old.ts` · 修改 1 次 · 最后一次成功（turn old/seq 1）',
      ].join('\n'),
      throughSeq: messages[0]!.seq,
      summaryTokens: 20,
      model: 'test',
      promptVersion: 'old',
      updatedAt: new Date(),
    });

    const requests: SummaryRequest[] = [];
    const sessions = new SessionService(store, {
      config: config({ summaryTargetTokens: 2_000 }),
      summarize: async (request) => {
        requests.push(request);
        return narrative;
      },
      evidence: { collect: async () => ledger },
    });

    await sessions.compact(USER, conversationId, { protectSeq: messages.at(-1)!.seq });

    expect(requests[0]?.previousSummary).toBe('## 任务与约束\n- 旧任务');
    const stored = await store.getSummary(conversationId);
    expect(stored?.summary).not.toContain('src/old.ts');
    expect(stored?.summary).toContain('src/session/service.ts');
  });

  it('falls back to the companion template when checkpoints are disabled', async () => {
    const { store, conversationId, messages } = await seed(6);
    const requests: SummaryRequest[] = [];
    const sessions = new SessionService(store, {
      config: config({
        checkpointEnabled: false,
        checkpointMode: 'coding',
        summaryTargetTokens: 2_000,
      }),
      summarize: async (request) => {
        requests.push(request);
        return narrative;
      },
      evidence: { collect: async () => ledger },
      taskBoard: { snapshot: async () => board },
    });

    await sessions.compact(USER, conversationId, { protectSeq: messages.at(-1)!.seq });

    expect(requests[0]?.mode).toBe('companion');
    expect(requests[0]?.ledger).toBeUndefined();
    expect(requests[0]?.board).toBeUndefined();
    const stored = await store.getSummary(conversationId);
    expect(stored?.summary).not.toContain(EVIDENCE_HEADING);
    expect(stored?.promptVersion).toBe(summaryPromptVersion('companion'));
  });

  it('honours a forced companion mode even when the trace is coding', async () => {
    const { store, conversationId, messages } = await seed(6);
    const requests: SummaryRequest[] = [];
    const sessions = new SessionService(store, {
      config: config({ checkpointMode: 'companion', summaryTargetTokens: 2_000 }),
      summarize: async (request) => {
        requests.push(request);
        return narrative;
      },
      evidence: { collect: async () => ledger },
    });

    await sessions.compact(USER, conversationId, { protectSeq: messages.at(-1)!.seq });

    expect(requests[0]?.mode).toBe('companion');
    expect((await store.getSummary(conversationId))?.summary).not.toContain(EVIDENCE_HEADING);
  });

  it('does not fail compaction when the trace or the board cannot be read', async () => {
    const { store, conversationId, messages } = await seed(6);
    const sessions = new SessionService(store, {
      config: config({ summaryTargetTokens: 2_000 }),
      summarize: async () => narrative,
      evidence: {
        collect: async () => {
          throw new Error('trace unavailable');
        },
      },
      taskBoard: {
        snapshot: async () => {
          throw new Error('board unavailable');
        },
      },
    });

    const result = await sessions.compact(USER, conversationId, {
      protectSeq: messages.at(-1)!.seq,
    });

    expect(result.compacted).toBe(true);
    const stored = await store.getSummary(conversationId);
    // The conversation is still compacted; only the appendix is missing.
    expect(stored?.summary).toBe(narrative);
  });

  it('uses the coding template on the automatic prepare path', async () => {
    const { store, conversationId, messages } = await seed(6);
    const requests: SummaryRequest[] = [];
    const sessions = new SessionService(store, {
      config: config({ summaryTargetTokens: 2_000 }),
      summarize: async (request) => {
        requests.push(request);
        return narrative;
      },
      evidence: { collect: async () => ledger },
    });

    const replay = await sessions.prepare(USER, conversationId, {
      protectSeq: messages.at(-1)!.seq,
    });

    // `prepare` is the real trigger: compaction happens inside it when the
    // window crosses the trigger ratio, so the checkpoint must appear there.
    expect(requests[0]?.mode).toBe('coding');
    expect(replay.summary).toContain(EVIDENCE_HEADING);
    expect(replay.throughSeq).toBe(messages.at(-2)!.seq);
  });

  it('exposes the stored checkpoint as structure for readers', async () => {    const { store, conversationId, messages } = await seed(6);
    const sessions = new SessionService(store, {
      config: config({ summaryTargetTokens: 2_000 }),
      summarize: async () => narrative,
      evidence: { collect: async () => ledger },
      taskBoard: { snapshot: async () => board },
    });

    await sessions.compact(USER, conversationId, { protectSeq: messages.at(-1)!.seq });

    const checkpoint = await sessions.checkpoint(USER, conversationId);
    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.mode).toBe('coding');
    expect(checkpoint?.throughSeq).toBe(messages.at(-2)!.seq);
    expect(checkpoint?.sections[0]?.title).toBe('任务与约束');
    expect(checkpoint?.evidence?.files[0]?.path).toBe('src/session/service.ts');
    expect(checkpoint?.evidence?.verifications[0]?.status).toBe('failed');
    expect(checkpoint?.evidence?.board[0]?.id).toBe('task-1');
  });

  it('returns null for a conversation that has never compacted', async () => {
    const { store, conversationId } = await seed(2);
    const sessions = new SessionService(store, { config: config() });
    expect(await sessions.checkpoint(USER, conversationId)).toBeNull();
  });
});
