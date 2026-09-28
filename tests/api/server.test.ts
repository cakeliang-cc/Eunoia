/**
 * The HTTP layer, over a real socket.
 *
 * Real HTTP rather than a mocked request object, because the parts most likely
 * to break are exactly the parts a mock replaces: the SSE framing, the
 * `Set-Cookie` on first contact, the abort on client disconnect. A route test
 * that never opens a socket tests the router and calls it the server.
 *
 * The model is the one thing that is faked. `createApp` takes an injectable
 * runner for precisely this reason, so the routes can be exercised end to end —
 * retrieval, safety, persistence and all — without a credential.
 */

/*
 * Parsed JSON is untyped by nature, and these tests read arbitrary fields off
 * responses to pin their shape. The `any`s below are the boundary, not a
 * shortcut past it.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { createApp, MEMORY_ENABLED_KEY, parseChatRequest } from '../../src/api/server.ts';
import { IDENTITY_COOKIE } from '../../src/api/identity.ts';
import { PROMPT_VERSION } from '../../src/agent/instructions.ts';
import type { TurnRunner } from '../../src/service/chat.ts';
import type { AgentEvent } from '../../src/agent/events.ts';

let store: InMemoryStore;
let server: Server;
let base: string;

/** A runner that answers with fixed text and never touches the network. */
function stubRunner(reply = '听起来真的很沉。', extra: AgentEvent[] = []): TurnRunner {
  return async function* () {
    for (const event of extra) yield event;
    yield { type: 'text_delta', text: reply };
    yield { type: 'completed', text: reply };
  };
}

async function start(runner: TurnRunner = stubRunner()): Promise<void> {
  store = new InMemoryStore();
  server = createApp({ store, runner });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
}

beforeEach(async () => {
  await start();
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    // A keep-alive socket would hold the close open past the test.
    server.closeAllConnections?.();
  });
});

/** An identity that persists across requests, the way a browser's cookie does. */
async function newIdentity(): Promise<string> {
  const response = await fetch(`${base}/api/conversations`);
  const cookie = response.headers.get('set-cookie');
  expect(cookie, 'the server should mint an identity on first contact').toBeTruthy();
  return (cookie as string).split(';')[0] as string;
}

/** A parsed JSON response. `body` is `unknown` at the type level, as parsed JSON is. */
interface ApiResponse {
  readonly status: number;
  readonly body: Record<string, any>;
  readonly headers: Headers;
}

async function api(
  path: string,
  init: RequestInit & { cookie?: string } = {},
): Promise<ApiResponse> {
  const { cookie, ...rest } = init;
  const response = await fetch(`${base}${path}`, {
    ...rest,
    headers: {
      ...(rest.headers ?? {}),
      ...(cookie ? { cookie } : {}),
      ...(rest.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.length > 0 ? JSON.parse(text) : null,
    headers: response.headers,
  };
}

/** Post a message and read the SSE frames back. */
async function chat(
  message: string,
  options: { cookie?: string; conversationId?: string | null } = {},
): Promise<{ frames: { event: string; data: any }[]; cookie: string }> {
  const response = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    body: JSON.stringify({ message, conversationId: options.conversationId ?? null }),
  });

  expect(response.headers.get('content-type')).toContain('text/event-stream');
  // Without this an intermediate proxy buffers the whole reply and the
  // streaming effect disappears in production while working locally.
  expect(response.headers.get('x-accel-buffering')).toBe('no');

  const raw = await response.text();
  const frames = raw
    .split('\n\n')
    .filter((block) => block.trim().length > 0 && !block.startsWith(':'))
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? '';
      const data = /^data: (.*)$/m.exec(block)?.[1] ?? '{}';
      return { event, data: JSON.parse(data) };
    });

  const setCookie = response.headers.get('set-cookie') ?? '';
  return { frames, cookie: setCookie.split(';')[0] ?? '' };
}

describe('identity', () => {
  it('mints a cookie on first contact and keeps it afterwards', async () => {
    const first = await fetch(`${base}/api/conversations`);
    const cookie = (first.headers.get('set-cookie') as string).split(';')[0] as string;
    expect(cookie.startsWith(`${IDENTITY_COOKIE}=`)).toBe(true);

    const second = await fetch(`${base}/api/conversations`, { headers: { cookie } });
    expect(second.headers.get('set-cookie')).toBeNull();
  });

  it('marks the identity cookie HttpOnly and SameSite=Lax', async () => {
    // Not decoration. This handle is the whole of the identity system (ADR 009),
    // so a script that can read it out of `document.cookie` can become the user.
    // `HttpOnly` is only free because no client code reads the cookie — if that
    // ever changes, this test is where it will show up.
    const response = await fetch(`${base}/api/conversations`);
    const header = response.headers.get('set-cookie') as string;
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Lax/i);
    // `Secure` is deliberately absent: it makes the browser drop the cookie over
    // plain http, and this is served over plain http in development. Asserted so
    // that adding it without TLS is a failing test rather than a broken local
    // login.
    expect(header).not.toMatch(/Secure/i);
  });

  it('replaces an unrecognised identifier rather than trusting it', async () => {
    // Accepting an arbitrary string would let a caller choose an id and read
    // someone else's memories. The header exists for the mini-program's own
    // auth layer, not as a way in.
    const response = await fetch(`${base}/api/conversations`, {
      headers: { 'x-user-id': '1' },
    });
    expect(response.headers.get('set-cookie')).toBeTruthy();
  });

  it('accepts a well-formed uuid from the header', async () => {
    const id = '0192f0aa-1111-7000-8000-000000000000';
    const response = await fetch(`${base}/api/conversations`, { headers: { 'x-user-id': id } });
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('keeps two identities apart', async () => {
    const alice = await newIdentity();
    const bob = await newIdentity();

    await chat('记住我喜欢喝美式', { cookie: alice });
    const bobMemory = await api('/api/memory', { cookie: bob });

    expect(bobMemory.body.memories).toEqual([]);
  });
});

describe('DELETE /api/me', () => {
  it('removes everything the person had and clears the cookie', async () => {
    const cookie = await newIdentity();
    const userId = cookie.split('=')[1] as string;
    await chat('我养了一只叫团子的猫', { cookie });
    await store.createMemory(userId, {
      type: 'semantic',
      content: '用户养了一只叫团子的猫',
      source: 'user_stated',
    });

    const response = await api('/api/me', { method: 'DELETE', cookie });

    expect(response.status).toBe(200);
    expect(response.body.deleted).toBe(true);
    expect(await store.listMemories(userId)).toEqual([]);
    expect(await store.listConversations(userId)).toEqual([]);
    // Cleared, not just deleted: a live cookie pointing at a row that is gone
    // would be accepted by `resolveIdentity` — it checks the shape, not the row
    // — and the next message would be written under a user that does not exist.
    const cleared = response.headers.get('set-cookie') as string;
    expect(cleared).toMatch(/df_uid=;/);
    expect(cleared).toMatch(/Max-Age=0/);
  });

  it('answers for someone who was never here rather than 404ing', async () => {
    // The caller asked for a state — "I have no data here" — and a caller with
    // no row is already in it. A 404 would report a failure that did not happen.
    const { status, body } = await api('/api/me', {
      method: 'DELETE',
      cookie: `${IDENTITY_COOKIE}=0192f0aa-0000-7000-8000-0000000000ff`,
    });
    expect(status).toBe(200);
    expect(body.deleted).toBe(false);
  });

  it('does not mint an identity in order to delete one', async () => {
    // The route deliberately skips `identify`, which creates a user when it
    // finds none. Minting here would both create a person to remove them and
    // answer with a cookie for a row that never existed.
    const response = await fetch(`${base}/api/me`, { method: 'DELETE' });
    const body = (await response.json()) as { deleted: boolean };
    expect(body.deleted).toBe(false);
    expect(response.headers.get('set-cookie')).toMatch(/Max-Age=0/);
  });

  it('leaves the other person alone', async () => {
    const alice = await newIdentity();
    const bob = await newIdentity();
    await store.createMemory(bob.split('=')[1] as string, {
      type: 'semantic',
      content: '鲍勃的私事',
      source: 'user_stated',
    });

    await api('/api/me', { method: 'DELETE', cookie: alice });

    expect((await api('/api/memory', { cookie: bob })).body.memories).toHaveLength(1);
  });
});

describe('GET /health', () => {
  it('reports ok and the prompt version', async () => {
    const { status, body } = await api('/health');
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    // Which prompt served a reply is otherwise unknowable after the fact.
    expect(body.prompt_version).toBe(PROMPT_VERSION);
  });
});

describe('POST /api/chat', () => {
  it('streams the reply as SSE and ends with completed', async () => {
    const { frames } = await chat('今天什么都不想做。');

    expect(frames.map((frame) => frame.event)).toEqual(['text_delta', 'completed']);
    expect(frames[0]?.data.text).toBe('听起来真的很沉。');
    expect(frames[1]?.data.text).toBe('听起来真的很沉。');
  });

  it('returns a conversation id the client can continue with', async () => {
    const { frames, cookie } = await chat('在吗');
    const conversationId = frames.at(-1)?.data.conversationId;
    expect(conversationId).toBeTruthy();

    await chat('还在吗', { cookie, conversationId });
    const { body } = await api(`/api/conversations/${conversationId}/messages`, { cookie });

    expect(body.messages.map((message: { content: string }) => message.content)).toEqual([
      '在吗',
      '听起来真的很沉。',
      '还在吗',
      '听起来真的很沉。',
    ]);
  });

  it('emits a memory_retrieved frame carrying counts and no content', async () => {
    const cookie = await newIdentity();
    const { frames } = await chat('我养了一只叫团子的猫，它最近不吃饭', { cookie });
    expect(frames.some((frame) => frame.event === 'memory_retrieved')).toBe(false);

    // Second turn, so the memory from the first is there to find. The stub
    // runner does not save anything, so this asserts the framing rather than the
    // extraction: it must never carry the memory text.
    const { frames: again } = await chat('团子还是不吃饭', { cookie });
    for (const frame of again) {
      expect(JSON.stringify(frame.data)).not.toContain('团子');
    }
  });

  it('emits a safety_notice frame for a risky message', async () => {
    const { frames } = await chat('我不想活了');
    const notice = frames.find((frame) => frame.event === 'safety_notice');
    expect(notice?.data.level).toBe('crisis');
  });

  it('rejects an empty message', async () => {
    const { status, body } = await api('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ message: '   ' }),
    });
    expect(status).toBe(400);
    expect(body.error).toContain('empty');
  });

  it('rejects a non-string message', async () => {
    const { status } = await api('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ message: 42 }),
    });
    expect(status).toBe(400);
  });

  it('rejects an absurdly long message rather than buffering it', async () => {
    const { status, body } = await api('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ message: '字'.repeat(9000) }),
    });
    expect(status).toBe(400);
    expect(body.error).toContain('8000');
  });

  it('rejects a body that is not JSON', async () => {
    const response = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    });
    expect(response.status).toBe(400);
  });

  it('surfaces a runner failure as an error frame, not a 500', async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    await start(async function* () {
      yield { type: 'error', message: 'upstream is down', retryable: true };
    });

    const { frames } = await chat('在吗');
    expect(frames.at(-1)?.event).toBe('error');
    expect(frames.at(-1)?.data.message).toContain('upstream is down');
  });

  it('does not retrieve when the person has switched memory off', async () => {
    // The runner is replaced before the request, so the assertion can be about
    // what the model was actually given rather than about the absence of a frame.
    let instructions = '';
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    await start(async function* (agent) {
      instructions = agent.instructions as string;
      yield { type: 'completed', text: '嗯。' };
    });

    const cookie = await newIdentity();
    const userId = cookie.split('=')[1] as string;
    await store.createMemory(userId, {
      type: 'semantic',
      content: '用户养了一只叫团子的猫',
      source: 'user_stated',
      importance: 1,
    });
    await store.setPreference(userId, MEMORY_ENABLED_KEY, false);

    const { frames } = await chat('团子最近不吃饭', { cookie });

    expect(frames.some((frame) => frame.event === 'memory_retrieved')).toBe(false);
    expect(instructions).not.toContain('团子');
    // Switched off means not consulted, not consulted-and-hidden.
    expect((await store.getMemory(userId, (await store.listMemories(userId))[0]!.id))?.accessCount).toBe(0);
  });
});

describe('the memory endpoints', () => {
  it('lists memories and whether retrieval is on', async () => {
    const cookie = await newIdentity();
    await store.createMemory(cookie.split('=')[1] as string, {
      type: 'semantic',
      content: '用户讨厌香菜',
      source: 'user_stated',
    });

    const { body } = await api('/api/memory', { cookie });
    expect(body.memories).toHaveLength(1);
    expect(body.enabled).toBe(true);
  });

  it('lets the person correct a memory, recorded as their own action', async () => {
    const cookie = await newIdentity();
    const userId = cookie.split('=')[1] as string;
    const memory = await store.createMemory(userId, {
      type: 'semantic',
      content: '用户喜欢跑步',
      source: 'user_stated',
    });

    const { status, body } = await api(`/api/memory/${memory.id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ content: '用户膝盖受伤，不跑步了' }),
    });

    expect(status).toBe(200);
    expect(body.memory.content).toContain('不跑步了');
    // `actor` is the whole reason the column exists: a person correcting their
    // own memory is not the agent doing it.
    expect(store.events.at(-1)?.actor).toBe('user');
  });

  it('rejects an invalid status rather than writing it', async () => {
    const cookie = await newIdentity();
    const userId = cookie.split('=')[1] as string;
    const memory = await store.createMemory(userId, {
      type: 'semantic',
      content: 'x',
      source: 'user_stated',
    });

    const { status } = await api(`/api/memory/${memory.id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ status: 'obliterated' }),
    });
    expect(status).toBe(400);
  });

  it('soft-deletes a memory', async () => {
    const cookie = await newIdentity();
    const userId = cookie.split('=')[1] as string;
    const memory = await store.createMemory(userId, {
      type: 'semantic',
      content: 'x',
      source: 'user_stated',
    });

    const { status } = await api(`/api/memory/${memory.id}`, { method: 'DELETE', cookie });
    expect(status).toBe(200);
    // Still a row: `memory_events` and `superseded_by` point at it.
    expect((await store.getMemory(userId, memory.id))?.status).toBe('deleted');
    expect((await api('/api/memory', { cookie })).body.memories).toEqual([]);
  });

  it('cannot touch a memory belonging to someone else', async () => {
    const alice = await newIdentity();
    const bob = await newIdentity();
    const memory = await store.createMemory(alice.split('=')[1] as string, {
      type: 'semantic',
      content: '私事',
      source: 'user_stated',
    });

    expect((await api(`/api/memory/${memory.id}`, { method: 'DELETE', cookie: bob })).status).toBe(404);
    expect((await api(`/api/memory/${memory.id}`, { method: 'PATCH', cookie: bob, body: '{}' })).status).toBe(404);
  });

  it('ignores a non-uuid id rather than 500ing', async () => {
    expect((await api('/api/memory/not-a-uuid', { cookie: await newIdentity() })).status).toBe(404);
  });
});

describe('the preferences endpoints', () => {
  it('stores and reads back a preference', async () => {
    const cookie = await newIdentity();
    await api('/api/preferences', {
      method: 'PUT',
      cookie,
      body: JSON.stringify({ 'tone.directness': 0.8 }),
    });

    const { body } = await api('/api/preferences', { cookie });
    expect(body.preferences['tone.directness']).toBe(0.8);
    expect(body.memoryEnabled).toBe(true);
  });

  it('reports memory as off once switched off', async () => {
    const cookie = await newIdentity();
    await api('/api/preferences', {
      method: 'PUT',
      cookie,
      body: JSON.stringify({ [MEMORY_ENABLED_KEY]: false }),
    });

    expect((await api('/api/preferences', { cookie })).body.memoryEnabled).toBe(false);
  });

  it('rejects a body that is not an object', async () => {
    const { status } = await api('/api/preferences', {
      method: 'PUT',
      cookie: await newIdentity(),
      body: JSON.stringify([1, 2, 3]),
    });
    expect(status).toBe(400);
  });
});

describe('the feedback endpoints', () => {
  it('records a rating against a message', async () => {
    const cookie = await newIdentity();
    const { frames } = await chat('在吗', { cookie });
    const messageId = frames.at(-1)?.data.messageId;
    expect(messageId).toBeTruthy();

    const response = await api('/api/feedback', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ messageId, rating: 'good' }),
    });
    expect(response.status).toBe(200);
    expect((await api('/api/feedback', { cookie })).body.feedback[0].rating).toBe('good');
  });

  it('rejects a rating that is neither good nor bad', async () => {
    const { status } = await api('/api/feedback', {
      method: 'POST',
      cookie: await newIdentity(),
      body: JSON.stringify({ messageId: 'm1', rating: 'maybe' }),
    });
    expect(status).toBe(400);
  });
});

describe('the web client', () => {
  it('serves the page at the root', async () => {
    const response = await fetch(`${base}/`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('<!doctype html>');
  });
});

describe('unknown routes', () => {
  it('return 404 as JSON rather than HTML', async () => {
    const { status, body } = await api('/api/does-not-exist');
    expect(status).toBe(404);
    expect(body.error).toBe('not found');
  });
});

describe('parseChatRequest', () => {
  it('trims the message', () => {
    expect(parseChatRequest({ message: '  在吗  ' })).toEqual({ message: '在吗', conversationId: null });
  });

  it('names the offending field', () => {
    expect(parseChatRequest({})).toContain('message');
    expect(parseChatRequest({ message: 'x', conversationId: 7 })).toContain('conversationId');
    expect(parseChatRequest(null)).toContain('JSON object');
  });
});
