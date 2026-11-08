/**
 * Concurrent chat over real HTTP (ADR 027).
 *
 * The unit tests pin the admission rule; these pin the part a browser and a
 * direct `curl` actually see: the second request gets `409 conversation_busy`
 * before any message is written, and a retried request id is answered from the
 * record without a second model call.
 *
 * These use a real socket on purpose. The bug being fixed was that disabling the
 * send button was mistaken for concurrency control; a test that invoked
 * `runTurn` twice in one event loop would have missed it too.
 */

/*
 * Parsed JSON is untyped by nature; these tests read arbitrary fields off
 * responses to pin their shape.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { createApp } from '../../src/api/server.ts';
import type { TurnRunner } from '../../src/service/chat.ts';

let store: InMemoryStore;
let server: Server | null = null;
let base = '';

async function stop(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => {
    server!.close(() => resolve());
    server!.closeAllConnections?.();
  });
  server = null;
}

async function start(runner: TurnRunner): Promise<void> {
  await stop();
  store = new InMemoryStore();
  server = createApp({ store, runner });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  await start(fixedRunner('好的。'));
});

afterEach(async () => {
  await stop();
});

function fixedRunner(reply: string): TurnRunner {
  return async function* () {
    yield { type: 'text_delta', text: reply };
    yield { type: 'completed', text: reply };
  };
}

/**
 * A runner that starts only when released, plus a promise for "it has started".
 *
 * Deterministic instead of timing-based: the test waits for the turn to be
 * inside the model call before sending the competing request, so a slow machine
 * cannot turn the assertion into a race.
 */
function gatedRunner(reply: string): {
  runner: TurnRunner;
  started: Promise<void>;
  release: () => void;
} {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });

  const runner: TurnRunner = async function* () {
    markStarted();
    await gate;
    yield { type: 'text_delta', text: reply };
    yield { type: 'completed', text: reply };
  };
  return { runner, started, release };
}

async function identity(): Promise<string> {
  const response = await fetch(`${base}/api/conversations`);
  return (response.headers.get('set-cookie') as string).split(';')[0] as string;
}

async function newConversation(
  cookie: string,
): Promise<{ id: string; userId: string }> {
  const response = await fetch(`${base}/api/conversations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: '{}',
  });
  const body = (await response.json()) as {
    conversation: { id: string; userId: string };
  };
  return { id: body.conversation.id, userId: body.conversation.userId };
}

interface ChatOptions {
  readonly cookie: string;
  readonly conversationId?: string | null;
  readonly requestId?: string;
  readonly turnId?: string;
}

function chat(
  message: string,
  options: ChatOptions,
): Promise<{ status: number; frames: { event: string; data: any }[]; body: any }> {
  return post('/api/chat', {
    message,
    conversationId: options.conversationId ?? null,
    ...(options.requestId ? { requestId: options.requestId } : {}),
    ...(options.turnId ? { turnId: options.turnId } : {}),
  }, options.cookie);
}

async function post(
  path: string,
  payload: Record<string, unknown>,
  cookie: string,
): Promise<{ status: number; frames: { event: string; data: any }[]; body: any }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    return { status: response.status, frames: [], body: text.length > 0 ? JSON.parse(text) : null };
  }
  return { status: response.status, frames: parseFrames(text), body: null };
}

function parseFrames(raw: string): { event: string; data: any }[] {
  return raw
    .split('\n\n')
    .filter((block) => block.trim().length > 0 && !block.startsWith(':'))
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? '';
      const data = /^data: (.*)$/m.exec(block)?.[1] ?? '{}';
      return { event, data: JSON.parse(data) };
    });
}

describe('a second turn in one conversation', () => {
  it('is refused with 409 and writes no message', async () => {
    const gated = gatedRunner('第一轮答完了');
    await start(gated.runner);
    const cookie = await identity();
    const { id: conversationId, userId } = await newConversation(cookie);

    const first = chat('A', { cookie, conversationId, requestId: randomUUID() });
    await gated.started;

    const second = await chat('B', { cookie, conversationId, requestId: randomUUID() });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('conversation_busy');
    expect(second.body.conversationId).toBe(conversationId);
    expect(typeof second.body.activeTurnId).toBe('string');

    gated.release();
    const completed = await first;
    expect(completed.frames.at(-1)?.event).toBe('completed');

    // The invariant the bug broke: B never reached the transcript, so assistant
    // A's answer is to A and nothing else.
    const messages = await store.listMessages(userId, conversationId);
    expect(messages.map((message) => message.content)).toEqual(['A', '第一轮答完了']);
  });

  it('is accepted once the first turn finished', async () => {
    const cookie = await identity();
    const { id: conversationId } = await newConversation(cookie);

    const first = await chat('A', { cookie, conversationId, requestId: randomUUID() });
    expect(first.frames.at(-1)?.event).toBe('completed');

    const second = await chat('B', { cookie, conversationId, requestId: randomUUID() });
    expect(second.status).toBe(200);
    expect(second.frames.at(-1)?.event).toBe('completed');
  });
});

describe('a retried request id', () => {
  it('replays the recorded reply without calling the model again', async () => {
    let calls = 0;
    const runner: TurnRunner = async function* () {
      calls += 1;
      yield { type: 'text_delta', text: '只生成一次' };
      yield { type: 'completed', text: '只生成一次' };
    };
    await start(runner);
    const cookie = await identity();
    const { id: conversationId, userId } = await newConversation(cookie);
    const requestId = randomUUID();

    const first = await chat('你好', { cookie, conversationId, requestId });
    expect(first.frames.at(-1)?.event).toBe('completed');

    const retry = await chat('你好', { cookie, conversationId, requestId });
    const last = retry.frames.at(-1);
    expect(last?.event).toBe('completed');
    expect(last?.data.replayed).toBe(true);
    expect(last?.data.text).toBe('只生成一次');
    expect(calls).toBe(1);

    const messages = await store.listMessages(userId, conversationId);
    expect(messages).toHaveLength(2);
  });

  it('reports a duplicate that arrives before the first attempt finished', async () => {
    const gated = gatedRunner('慢答案');
    await start(gated.runner);
    const cookie = await identity();
    const { id: conversationId } = await newConversation(cookie);
    const requestId = randomUUID();

    const first = chat('你好', { cookie, conversationId, requestId });
    await gated.started;

    const duplicate = await chat('你好', { cookie, conversationId, requestId });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('request_in_flight');

    gated.release();
    await first;
  });

  it('rejects an id rebound to a different message', async () => {
    const cookie = await identity();
    const { id: conversationId } = await newConversation(cookie);
    const requestId = randomUUID();

    await chat('第一句', { cookie, conversationId, requestId });
    const rebound = await chat('完全不同的第二句', { cookie, conversationId, requestId });

    expect(rebound.status).toBe(409);
    expect(rebound.body.code).toBe('request_conflict');
  });

  it('rejects a reused id from another person', async () => {
    const cookieA = await identity();
    const conversationA = (await newConversation(cookieA)).id;
    const requestId = randomUUID();
    await chat('我的问题', { cookie: cookieA, conversationId: conversationA, requestId });

    const cookieB = await identity();
    const conversationB = (await newConversation(cookieB)).id;
    const stolen = await chat('同一个 id', {
      cookie: cookieB,
      conversationId: conversationB,
      requestId,
    });

    expect(stolen.status).toBe(409);
    expect(stolen.body.code).toBe('request_conflict');
  });

  it('replays a stored failure as an error frame instead of re-running', async () => {
    let calls = 0;
    const failing: TurnRunner = async function* () {
      calls += 1;
      yield { type: 'error', message: '模型拒绝了这次请求', retryable: false };
    };
    await start(failing);
    const cookie = await identity();
    const { id: conversationId } = await newConversation(cookie);
    const requestId = randomUUID();

    const first = await chat('你好', { cookie, conversationId, requestId });
    expect(first.frames.at(-1)?.event).toBe('error');

    const retry = await chat('你好', { cookie, conversationId, requestId });
    const last = retry.frames.at(-1);
    expect(last?.event).toBe('error');
    expect(last?.data.replayed).toBe(true);
    expect(last?.data.message).toBe('模型拒绝了这次请求');
    expect(calls).toBe(1);
  });
});

describe('conversation ownership', () => {
  it('answers 404 for a conversation id that does not exist', async () => {
    const cookie = await identity();
    const missing = await chat('你好', { cookie, conversationId: randomUUID(), requestId: randomUUID() });
    expect(missing.status).toBe(404);
  });

  it('answers 404 for somebody else’s conversation instead of opening a new one', async () => {
    const cookieA = await identity();
    const conversationA = (await newConversation(cookieA)).id;

    const cookieB = await identity();
    const attempt = await chat('走错门了', {
      cookie: cookieB,
      conversationId: conversationA,
      requestId: randomUUID(),
    });
    expect(attempt.status).toBe(404);
  });
});

/**
 * The terminal verdict on the wire (ADR 029).
 *
 * A retry must replay the verdict as well as the text: otherwise the client
 * would show the same answer twice, once marked complete and once marked cut.
 */
describe('finish reason and acceptance', () => {
  it('carries them on the live turn and on the replay', async () => {
    const cut: TurnRunner = async function* () {
      yield { type: 'text_delta', text: '说到一半' };
      yield { type: 'completed', text: '说到一半', finishReason: 'incomplete_stream' };
    };
    await start(cut);
    const cookie = await identity();
    const { id: conversationId } = await newConversation(cookie);
    const requestId = randomUUID();

    const first = await chat('说点', { cookie, conversationId, requestId });
    const live = first.frames.at(-1);
    expect(live?.data.finishReason).toBe('incomplete_stream');
    expect(live?.data.accepted).toBe(false);
    expect(live?.data.acceptance).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'finished', ok: false })]),
    );

    const retry = await chat('说点', { cookie, conversationId, requestId });
    expect(retry.frames.at(-1)?.data).toMatchObject({
      finishReason: 'incomplete_stream',
      accepted: false,
      replayed: true,
    });
  });

  it('reports a normal answer as accepted', async () => {
    const cookie = await identity();
    const { id: conversationId } = await newConversation(cookie);
    const result = await chat('你好', { cookie, conversationId, requestId: randomUUID() });

    expect(result.frames.at(-1)?.data).toMatchObject({
      finishReason: 'completed',
      accepted: true,
    });
  });
});
