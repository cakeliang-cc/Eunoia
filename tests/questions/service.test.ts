/**
 * Typed questions: validation, idempotency, race, timeout and cancellation.
 */

import { describe, expect, it } from 'vitest';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { QuestionService } from '../../src/questions/service.ts';

function setup(ttlMs = 10_000) {
  let now = new Date('2026-09-01T00:00:00Z');
  return {
    service: new QuestionService({ store: new InMemoryStore(), ttlMs, now: () => now }),
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

const schema = {
  fields: [
    { key: 'branch', label: '目标分支', type: 'text' as const, required: true },
    {
      key: 'scope',
      label: '范围',
      type: 'select' as const,
      required: true,
      options: [
        { value: 'api', label: 'API' },
        { value: 'ui', label: 'UI' },
      ],
    },
    {
      key: 'checks',
      label: '检查',
      type: 'multi' as const,
      required: false,
      options: [
        { value: 'test', label: '测试' },
        { value: 'lint', label: 'Lint' },
      ],
    },
  ],
};

describe('ask and answer', () => {
  it('resolves a waiting turn with a validated answer', async () => {
    const { service } = setup();
    const record = await service.ask({ userId: 'u1', conversationId: 'c1', prompt: 'q', schema });
    expect(await service.pending('u1', 'c1')).toHaveLength(1);
    const waiting = service.wait('u1', record.id);
    await service.answer({
      userId: 'u1',
      questionId: record.id,
      answer: { branch: 'main', scope: 'api', checks: ['test'] },
    });
    await expect(waiting).resolves.toMatchObject({ branch: 'main', scope: 'api' });
    expect(await service.pending('u1', 'c1')).toHaveLength(0);
  });

  it('rejects missing required fields and options outside the list', async () => {
    const { service } = setup();
    const record = await service.ask({ userId: 'u1', conversationId: 'c1', prompt: 'q', schema });
    await expect(
      service.answer({ userId: 'u1', questionId: record.id, answer: { scope: 'api' } }),
    ).rejects.toMatchObject({ code: 'QUESTION_INVALID' });
    await expect(
      service.answer({
        userId: 'u1',
        questionId: record.id,
        answer: { branch: 'x', scope: 'nope' },
      }),
    ).rejects.toMatchObject({ code: 'QUESTION_INVALID' });
  });

  it('is idempotent per call and conflicts on a different question', async () => {
    const { service } = setup();
    const first = await service.ask({
      userId: 'u1',
      conversationId: 'c1',
      callId: 'call-1',
      prompt: 'q',
      schema: { fields: [] },
    });
    const second = await service.ask({
      userId: 'u1',
      conversationId: 'c1',
      callId: 'call-1',
      prompt: 'q',
      schema: { fields: [] },
    });
    expect(second.id).toBe(first.id);
    await expect(
      service.ask({
        userId: 'u1',
        conversationId: 'c1',
        callId: 'call-1',
        prompt: 'other',
        schema: { fields: [] },
      }),
    ).rejects.toMatchObject({ code: 'QUESTION_CONFLICT' });
  });

  it('delivers an answer that arrived before wait registered', async () => {
    const { service } = setup();
    const record = await service.ask({ userId: 'u1', conversationId: 'c1', prompt: 'q', schema: { fields: [] } });
    await service.answer({ userId: 'u1', questionId: record.id, answer: { text: 'early' } });
    await expect(service.wait('u1', record.id)).resolves.toEqual({ text: 'early' });
  });

  it('times out as expired and cancels a waiter', async () => {
    const { service } = setup(20);
    const first = await service.ask({ userId: 'u1', conversationId: 'c1', prompt: 'q', schema: { fields: [] } });
    await expect(service.wait('u1', first.id, { timeoutMs: 10 })).rejects.toMatchObject({
      code: 'QUESTION_TIMEOUT',
    });
    expect(await service.pending('u1', 'c1')).toHaveLength(0);

    const second = await service.ask({ userId: 'u1', conversationId: 'c1', prompt: 'q2', schema: { fields: [] } });
    const waiting = service.wait('u1', second.id);
    await service.cancel('u1', second.id);
    await expect(waiting).rejects.toMatchObject({ code: 'QUESTION_CANCELLED' });
  });

  it('does not let another user answer', async () => {
    const { service } = setup();
    const record = await service.ask({ userId: 'u1', conversationId: 'c1', prompt: 'q', schema: { fields: [] } });
    await expect(
      service.answer({ userId: 'u2', questionId: record.id, answer: { text: 'x' } }),
    ).rejects.toMatchObject({ code: 'QUESTION_NOT_FOUND' });
  });

  it('refuses an invalid field key', async () => {
    const { service } = setup();
    await expect(
      service.ask({
        userId: 'u1',
        conversationId: 'c1',
        prompt: 'q',
        schema: { fields: [{ key: 'bad key', label: 'x', type: 'text', required: true }] },
      }),
    ).rejects.toMatchObject({ code: 'QUESTION_INVALID' });
  });
});
