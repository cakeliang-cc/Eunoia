import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { QuestionService } from '../../src/questions/service.ts';
import { createApp } from '../../src/api/server.ts';

const TOKEN = 'q-token';
let server: Server;
let base: string;
let store: InMemoryStore;
let questions: QuestionService;
let cookie = '';

async function api(path: string, init: RequestInit & { token?: boolean } = {}) {
  const { token, ...rest } = init;
  const response = await fetch(`${base}${path}`, {
    ...rest,
    headers: {
      ...(rest.headers ?? {}),
      ...(cookie ? { cookie } : {}),
      ...(rest.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { 'x-eunoia-token': TOKEN } : {}),
    },
  });
  const setCookie = response.headers.get('set-cookie');
  if (!cookie && setCookie) cookie = setCookie.split(';')[0] as string;
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

beforeEach(async () => {
  store = new InMemoryStore();
  questions = new QuestionService({ store });
  server = createApp({ store, localToken: TOKEN, questions });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  cookie = '';
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
});

describe('question API', () => {
  it('lists, answers and no longer lists a pending question', async () => {
    const created = await api('/api/conversations', { method: 'POST', body: '{}' });
    const conversationId = created.body.conversation.id as string;
    const userId = decodeURIComponent(cookie.split('=').slice(1).join('='));
    const record = await questions.ask({
      userId,
      conversationId,
      prompt: '用哪个分支？',
      schema: {
        fields: [{ key: 'branch', label: '分支', type: 'text', required: true }],
      },
    });

    const pending = await api(`/api/questions?conversationId=${conversationId}`);
    expect(pending.status).toBe(200);
    expect(pending.body.questions).toHaveLength(1);

    const answered = await api(`/api/questions/${record.id}/answer`, {
      method: 'POST',
      token: true,
      body: JSON.stringify({ answer: { branch: 'main' } }),
    });
    expect(answered.status).toBe(200);
    expect(answered.body.question.answer).toEqual({ branch: 'main' });

    const after = await api(`/api/questions?conversationId=${conversationId}`);
    expect(after.body.questions).toHaveLength(0);
  });

  it('requires the control token to answer', async () => {
    const created = await api('/api/conversations', { method: 'POST', body: '{}' });
    const conversationId = created.body.conversation.id as string;
    const userId = decodeURIComponent(cookie.split('=').slice(1).join('='));
    const record = await questions.ask({ userId, conversationId, prompt: 'q', schema: { fields: [] } });
    const response = await api(`/api/questions/${record.id}/answer`, {
      method: 'POST',
      body: JSON.stringify({ answer: { text: 'x' } }),
    });
    expect(response.status).toBe(403);
  });

  it('does not list another conversation\'s questions', async () => {
    const first = await api('/api/conversations', { method: 'POST', body: '{}' });
    const second = await api('/api/conversations', { method: 'POST', body: '{}' });
    const userId = decodeURIComponent(cookie.split('=').slice(1).join('='));
    await questions.ask({
      userId,
      conversationId: first.body.conversation.id,
      prompt: 'q',
      schema: { fields: [] },
    });
    const list = await api(`/api/questions?conversationId=${second.body.conversation.id}`);
    expect(list.body.questions).toHaveLength(0);
  });
});
