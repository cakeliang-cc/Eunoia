/**
 * Turn admission (ADR 027).
 *
 * These are the rules the interview question is about, tested without HTTP:
 * one running turn per conversation, a retried request id answered from the
 * record, and an id rebound to different content rejected rather than reused.
 *
 * The store is the in-memory one, so a passing test is a statement about the
 * admission rule rather than about SQLite. The SQLite lock — a partial unique
 * index, which is what makes the rule hold across two processes — is covered in
 * `tests/db/turns.test.ts`.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import {
  ConversationBusyError,
  TurnCoordinator,
  TurnRequestConflictError,
  turnRequestHash,
} from '../../src/service/turns.ts';

const USER = 'user-1';

let store: InMemoryStore;
let coordinator: TurnCoordinator;
let conversationId: string;

beforeEach(async () => {
  store = new InMemoryStore();
  await store.ensureUser(USER);
  conversationId = (await store.createConversation(USER)).id;
  coordinator = new TurnCoordinator(store);
});

function hashOf(message: string, extra: Partial<Parameters<typeof turnRequestHash>[0]> = {}): string {
  return turnRequestHash({
    kind: 'chat',
    userId: USER,
    conversationId,
    message,
    ...extra,
  });
}

function begin(message: string, options: { requestId?: string; turnId?: string } = {}) {
  return coordinator.begin({
    requestId: options.requestId ?? randomUUID(),
    turnId: options.turnId ?? randomUUID(),
    userId: USER,
    conversationId,
    requestHash: hashOf(message),
  });
}

describe('one running turn per conversation', () => {
  it('admits the first turn and refuses a second with the active turn id', async () => {
    const first = await begin('A');
    expect(first.kind).toBe('started');

    await expect(begin('B')).rejects.toBeInstanceOf(ConversationBusyError);
    await expect(begin('B')).rejects.toMatchObject({
      code: 'conversation_busy',
      conversationId,
      activeTurnId: first.record.turnId,
    });
  });

  it('admits exactly one of two turns started at the same instant', async () => {
    // The failure this prevents: both requests observe "free", both append a
    // user message, and each model call replays the other's message.
    const results = await Promise.allSettled([begin('A'), begin('B')]);
    const admitted = results.filter((result) => result.status === 'fulfilled');
    const refused = results.filter((result) => result.status === 'rejected');

    expect(admitted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConversationBusyError);
  });

  it('accepts a new turn once the previous one finished', async () => {
    const first = await begin('A');
    await coordinator.finish(first.record.id, {
      status: 'completed',
      finishReason: 'completed',
      reply: '答',
    });

    const second = await begin('B');
    expect(second.kind).toBe('started');
  });

  it('keeps different conversations independent', async () => {
    const other = (await store.createConversation(USER)).id;
    const first = await begin('A');
    expect(first.kind).toBe('started');

    const concurrent = await coordinator.begin({
      requestId: randomUUID(),
      turnId: randomUUID(),
      userId: USER,
      conversationId: other,
      requestHash: turnRequestHash({
        kind: 'chat',
        userId: USER,
        conversationId: other,
        message: 'B',
      }),
    });
    expect(concurrent.kind).toBe('started');
  });
});

describe('idempotent request ids', () => {
  it('replays the recorded outcome instead of running again', async () => {
    const requestId = randomUUID();
    const first = await begin('A', { requestId });
    expect(first.kind).toBe('started');
    await coordinator.finish(requestId, {
      status: 'completed',
      finishReason: 'completed',
      reply: '已经答过了',
      messageId: 'msg-1',
    });

    const retry = await coordinator.begin({
      requestId,
      turnId: randomUUID(),
      userId: USER,
      conversationId,
      requestHash: hashOf('A'),
    });

    expect(retry.kind).toBe('replay');
    expect(retry.record.reply).toBe('已经答过了');
    expect(retry.record.messageId).toBe('msg-1');
    expect(retry.record.finishReason).toBe('completed');
  });

  it('reports an in-flight duplicate as such, not as a new turn', async () => {
    const requestId = randomUUID();
    await begin('A', { requestId });

    const retry = await coordinator.begin({
      requestId,
      turnId: randomUUID(),
      userId: USER,
      conversationId,
      requestHash: hashOf('A'),
    });
    expect(retry.kind).toBe('in_flight');
  });

  it('rejects the same id rebound to different content', async () => {
    const requestId = randomUUID();
    await begin('A', { requestId });

    await expect(
      coordinator.begin({
        requestId,
        turnId: randomUUID(),
        userId: USER,
        conversationId,
        requestHash: hashOf('B'),
      }),
    ).rejects.toBeInstanceOf(TurnRequestConflictError);
  });

  it('binds the digest to the user and the conversation, not just the text', async () => {
    // Same words, different person: this is not a retry, and treating it as one
    // would hand somebody else's request id over to them.
    const sameText = '同一句话';
    expect(hashOf(sameText)).not.toBe(
      turnRequestHash({ kind: 'chat', userId: 'user-2', conversationId, message: sameText }),
    );
    expect(hashOf(sameText)).not.toBe(
      turnRequestHash({ kind: 'chat', userId: USER, conversationId: 'other', message: sameText }),
    );
    expect(hashOf(sameText)).not.toBe(hashOf(sameText, { continue: true }));
  });

  it('rejects a reused id even after the first request failed', async () => {
    const requestId = randomUUID();
    await begin('A', { requestId });
    await coordinator.finish(requestId, {
      status: 'failed',
      finishReason: 'failed',
      error: 'provider said no',
    });

    await expect(
      coordinator.begin({
        requestId,
        turnId: randomUUID(),
        userId: USER,
        conversationId,
        requestHash: hashOf('B'),
      }),
    ).rejects.toBeInstanceOf(TurnRequestConflictError);
  });
});

describe('settlement', () => {
  it('keeps the first outcome and ignores a late second finish', async () => {
    const requestId = randomUUID();
    await begin('A', { requestId });

    await coordinator.finish(requestId, {
      status: 'completed',
      finishReason: 'completed',
      reply: '先说好的',
    });
    // A transport safety net, or recovery, arriving late must not rewrite it.
    await coordinator.finish(requestId, {
      status: 'interrupted',
      finishReason: 'cancelled',
      reply: '',
    });

    const record = await coordinator.get(requestId);
    expect(record?.status).toBe('completed');
    expect(record?.finishReason).toBe('completed');
    expect(record?.reply).toBe('先说好的');
  });

  it('records an interrupted turn without freeing the wrong conversation', async () => {
    const first = await begin('A');
    const finished = await coordinator.finish(first.record.id, {
      status: 'interrupted',
      finishReason: 'cancelled',
      reply: '半截',
    });
    expect(finished?.status).toBe('interrupted');
    expect(finished?.finishReason).toBe('cancelled');
    expect(await coordinator.current(conversationId)).toBeNull();
  });
});
