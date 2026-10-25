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
import { DEFAULT_SESSION_CONFIG, type SessionConfig } from '../../src/session/config.ts';
import { SessionService } from '../../src/session/service.ts';
import type { SummaryRequest } from '../../src/session/summary.ts';

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

  it('leaves a short conversation alone', async () => {
    const { store, conversationId } = await seed(2, 10);
    const sessions = new SessionService(store, {
      config: config({ inputBudgetTokens: 10_000, compactTriggerRatio: 0.9 }),
      summarize: async () => '不该被调用',
    });

    const replay = await sessions.prepare(USER, conversationId);
    expect(replay.summary).toBeNull();
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
