/**
 * R09 — member questions are aggregated into the root conversation, carry the
 * asking member/generation, and cannot be answered twice or by a stale card.
 */

import { describe, expect, it } from 'vitest';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { QuestionService } from '../../src/questions/service.ts';

const schema = {
  fields: [{ key: 'choice', label: '选择', type: 'text' as const, required: true }],
};

function setup() {
  let now = new Date('2026-11-08T10:00:00Z');
  const store = new InMemoryStore();
  const service = new QuestionService({ store, now: () => now, ttlMs: 60_000 });
  return {
    store,
    service,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe('R09 — member question aggregation', () => {
  it('merges two identical member questions into one root card', async () => {
    const h = setup();
    const first = await h.service.ask({
      userId: 'u1',
      conversationId: 'root-conversation',
      memberId: 'member-a',
      generation: 10,
      prompt: '选择哪个方案？',
      schema,
    });
    const second = await h.service.ask({
      userId: 'u1',
      conversationId: 'root-conversation',
      memberId: 'member-b',
      generation: 11,
      prompt: '选择哪个方案？',
      schema,
    });
    expect(second.id).toBe(first.id);
    const pending = await h.service.pending('u1', 'root-conversation');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.memberId).toBe('member-a');
    expect(pending[0]?.generation).toBe(10);
  });

  it('routes one answer to the waiting member exactly once', async () => {
    const h = setup();
    const record = await h.service.ask({
      userId: 'u1',
      conversationId: 'root-conversation',
      memberId: 'member-a',
      generation: 10,
      prompt: '选择哪个方案？',
      schema,
    });
    const waiting = h.service.wait('u1', record.id);
    await h.service.answer({
      userId: 'u1',
      questionId: record.id,
      answer: { choice: 'A' },
      generation: 10,
    });
    await expect(waiting).resolves.toEqual({ choice: 'A' });
    await expect(
      h.service.answer({ userId: 'u1', questionId: record.id, answer: { choice: 'B' } }),
    ).rejects.toMatchObject({ code: 'QUESTION_ALREADY_ANSWERED' });
  });

  it('refuses an answer for an older generation and keeps the current card pending', async () => {
    const h = setup();
    const record = await h.service.ask({
      userId: 'u1',
      conversationId: 'root-conversation',
      memberId: 'member-a',
      generation: 10,
      prompt: '选择哪个方案？',
      schema,
    });
    await expect(
      h.service.answer({
        userId: 'u1',
        questionId: record.id,
        answer: { choice: 'A' },
        generation: 9,
      }),
    ).rejects.toMatchObject({ code: 'QUESTION_CONFLICT' });
    expect((await h.service.pending('u1', 'root-conversation'))).toHaveLength(1);
  });

  it('cancels a closed member’s pending question and rejects its waiter', async () => {
    const h = setup();
    const record = await h.service.ask({
      userId: 'u1',
      conversationId: 'root-conversation',
      memberId: 'member-a',
      generation: 10,
      prompt: '还在等吗？',
      schema,
    });
    const waiting = h.service.wait('u1', record.id);
    expect(await h.service.cancelForMember('u1', 'member-a', '成员已关闭')).toBe(1);
    await expect(waiting).rejects.toMatchObject({ code: 'QUESTION_CANCELLED' });
    await expect(
      h.service.answer({ userId: 'u1', questionId: record.id, answer: { choice: 'A' } }),
    ).rejects.toMatchObject({ code: 'QUESTION_ALREADY_ANSWERED' });
  });

  it('a persisted answer can be read after a restart even though the waiter is gone', async () => {
    const h = setup();
    const record = await h.service.ask({
      userId: 'u1',
      conversationId: 'root-conversation',
      memberId: 'member-a',
      generation: 10,
      prompt: '重启后还能读到吗？',
      schema,
    });
    await h.service.answer({
      userId: 'u1',
      questionId: record.id,
      answer: { choice: 'yes' },
      generation: 10,
    });
    const restarted = new QuestionService({ store: h.store, ttlMs: 60_000 });
    await expect(restarted.wait('u1', record.id)).resolves.toEqual({ choice: 'yes' });
    expect(await restarted.pending('u1', 'root-conversation')).toHaveLength(0);
  });
});
