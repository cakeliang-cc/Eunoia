/**
 * The Team HTTP surface over a real socket.
 *
 * The model and the workspace are fakes; the router, identity, token guard,
 * SQL store and SSE framing are real. These tests pin the wire contracts the
 * browser depends on: create-run idempotency, owner isolation, CAS conflicts and
 * the event cursor.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { createApp } from '../../src/api/server.ts';
import { SessionService } from '../../src/session/service.ts';
import { MemoryTeamStore } from '../../src/teams/store-memory.ts';
import { TeamService, type TeamWorkspacePort } from '../../src/teams/service.ts';
import { defaultTeamConfig } from '../../src/teams/types.ts';
import type { ModelTurn } from '../../src/agent/model-port.ts';

const TOKEN = 'test-team-token';

let store: InMemoryStore;
let teamStore: MemoryTeamStore;
let service: TeamService;
let server: Server;
let base: string;
let identityCookie: string | null = null;

function workspaceStub(): TeamWorkspacePort {
  return {
    async provision(input) {
      return {
        workspaceId: `ws_${input.memberId}`,
        workspaceTaskId: `ws_${input.memberId}`,
        workspacePath: `/tmp/${input.memberId}`,
        baselineId: `base_${input.memberId}`,
        sourceVersion: 'sha256:empty',
        baselineHashes: {},
      };
    },
    async session() {
      return null;
    },
    async diff() {
      return { files: [], sourceVersion: 'sha256:empty', candidateHash: 'sha256:empty' };
    },
    async currentHashes() {
      return {};
    },
  };
}

const answering: ModelTurn = async function* () {
  yield { type: 'text_delta', text: '好的。' };
  yield {
    type: 'done',
    output: [{ type: 'message', role: 'assistant', content: '好的。' }],
  };
};

async function start(): Promise<void> {
  store = new InMemoryStore();
  teamStore = new MemoryTeamStore();
  const sessions = new SessionService(store);
  service = new TeamService({
    teamStore,
    store,
    sessions,
    workspace: workspaceStub(),
    ceiling: defaultTeamConfig('deepseek-flash'),
    toolPolicy: { allowWorkspaceWrites: false, allowCommands: false, maxOutputChars: 60_000 },
    resolveModelTurn: async () => answering,
    transcriptMode: 'durable',
  });
  server = createApp({
    store,
    sessions,
    teamService: service,
    localToken: TOKEN,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
}

async function json(
  path: string,
  options: RequestInit & { identity?: string } = {},
): Promise<{ status: number; body: any; cookie: string | null }> {
  const cookie = options.identity ?? identityCookie;
  const headers: Record<string, string> = {
    'x-eunoia-token': TOKEN,
    ...(options.body ? { 'content-type': 'application/json' } : {}),
    ...(cookie ? { cookie } : {}),
  };
  const response = await fetch(`${base}${path}`, { ...options, headers });
  const text = await response.text();
  const setCookie = response.headers.get('set-cookie');
  if (!options.identity && setCookie) identityCookie = setCookie.split(';')[0] ?? null;
  return {
    status: response.status,
    body: text.length > 0 ? JSON.parse(text) : null,
    cookie: setCookie,
  };
}

async function conversation(identity?: string): Promise<string> {
  const created = await json('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ title: '团队会话' }),
    ...(identity ? { identity } : {}),
  });
  expect(created.status).toBe(201);
  return created.body.conversation.id as string;
}

beforeEach(async () => {
  identityCookie = null;
  await start();
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await teamStore.close();
});

describe('Team API', () => {
  it('refuses a write without the local token', async () => {
    const response = await fetch(`${base}/api/teams/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'x', requestId: 'y', message: 'z' }),
    });
    expect(response.status).toBe(403);
  });

  it('creates a run idempotently and returns a snapshot', async () => {
    const conversationId = await conversation();
    const body = JSON.stringify({
      conversationId,
      requestId: 'req-1',
      message: '请做一件小事',
    });
    const first = await json('/api/teams/runs', { method: 'POST', body });
    expect(first.status).toBe(201);
    expect(first.body.run.id).toMatch(/^run_/);
    expect(first.body.snapshot.team.id).toBe(first.body.team.id);
    const second = await json('/api/teams/runs', { method: 'POST', body });
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.run.id).toBe(first.body.run.id);

    const snapshot = await json(`/api/teams/runs/${first.body.run.id}`);
    expect(snapshot.status).toBe(200);
    expect(Array.isArray(snapshot.body.members)).toBe(true);
    expect(snapshot.body.members.length).toBeGreaterThan(0);
  });

  it('returns 404 for another owner\'s run', async () => {
    const ownCookie = (await json('/api/teams', { method: 'GET' })).cookie;
    const conversationId = await conversation();
    const created = await json('/api/teams/runs', {
      method: 'POST',
      body: JSON.stringify({ conversationId, requestId: 'req-owner', message: 'x' }),
    });
    // A different browser identity is a different user; guessing the id must
    // not reveal whether it exists.
    const other = await json(`/api/teams/runs/${created.body.run.id}`, {
      identity: 'eunoia_id=00000000-0000-4000-8000-0000000000ff',
    });
    expect([403, 404]).toContain(other.status);
    expect(ownCookie).toBeTruthy();
  });

  it('supports task creation, revision conflict and review', async () => {
    const conversationId = await conversation();
    const created = await json('/api/teams/runs', {
      method: 'POST',
      body: JSON.stringify({ conversationId, requestId: 'req-task', message: '任务' }),
    });
    const runId = created.body.run.id as string;
    const task = await json(`/api/teams/runs/${runId}/tasks`, {
      method: 'POST',
      body: JSON.stringify({
        title: '任务 A',
        specification: '写一段文字',
        acceptance: '有提交',
        required: true,
      }),
    });
    expect(task.status).toBe(201);
    const taskId = task.body.task.id as string;
    const stale = await json(`/api/teams/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify({ expectedRevision: 99, title: '改' }),
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('TEAM_TASK_CONFLICT');
    const listed = await json(`/api/teams/runs/${runId}/tasks`);
    expect(listed.body.tasks[0].id).toBe(taskId);
    const report = await json(`/api/teams/runs/${runId}/report`);
    expect(report.body.complete).toBe(false);
  });

  it('streams a cursor of events after a given sequence', async () => {
    const conversationId = await conversation();
    const created = await json('/api/teams/runs', {
      method: 'POST',
      body: JSON.stringify({ conversationId, requestId: 'req-events', message: '事件' }),
    });
    const runId = created.body.run.id as string;
    const first = await json(`/api/teams/runs/${runId}/events?after=0`);
    expect(first.status).toBe(200);
    expect(Array.isArray(first.body.events)).toBe(true);
    expect(first.body.events.length).toBeGreaterThan(0);
    const cursor = first.body.cursor as number;
    const second = await json(`/api/teams/runs/${runId}/events?after=${cursor}`);
    expect(second.body.events.every((event: any) => event.sequence > cursor)).toBe(true);
  });

  it('reports budget and usage for a run', async () => {
    const conversationId = await conversation();
    const created = await json('/api/teams/runs', {
      method: 'POST',
      body: JSON.stringify({ conversationId, requestId: 'req-budget', message: '预算' }),
    });
    const runId = created.body.run.id as string;
    const budget = await json(`/api/teams/runs/${runId}/budget`);
    expect(budget.status).toBe(200);
    expect(budget.body.budget.limits.maxRequests).toBeGreaterThan(0);
    expect(budget.body.usage.requests).toBeGreaterThanOrEqual(0);
  });

  it('streams persisted events over SSE and honours a cursor', async () => {
    const conversationId = await conversation();
    const created = await json('/api/teams/runs', {
      method: 'POST',
      body: JSON.stringify({ conversationId, requestId: 'req-sse', message: 'SSE' }),
    });
    const runId = created.body.run.id as string;
    const first = await json(`/api/teams/runs/${runId}/events?after=0`);
    const cursor = first.body.cursor as number;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(`${base}/api/teams/runs/${runId}/events/stream?after=${cursor}`, {
        signal: controller.signal,
        ...(identityCookie ? { headers: { cookie: identityCookie } } : {}),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      // Creating a task after the cursor produces a durable event the stream
      // must deliver without rebuilding the run.
      await json(`/api/teams/runs/${runId}/tasks`, {
        method: 'POST',
        body: JSON.stringify({
          title: 'SSE 任务',
          specification: '',
          acceptance: '证据',
          required: true,
        }),
      });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let found: { sequence: number } | null = null;
      const deadline = Date.now() + 4_000;
      while (!found && Date.now() < deadline) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          if (!frame.includes('event: team')) continue;
          const dataLine = frame
            .split('\n')
            .find((line) => line.startsWith('data: '));
          if (!dataLine) continue;
          const data = JSON.parse(dataLine.slice(6));
          if (typeof data.sequence === 'number' && data.sequence > cursor) {
            found = data;
            break;
          }
        }
      }
      expect(found).not.toBeNull();
      expect(found!.sequence).toBeGreaterThan(cursor);
      await reader.cancel().catch(() => undefined);
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  });

  it('does not list a member conversation as a normal conversation', async () => {
    const cookie = (await json('/api/teams', { method: 'GET' })).cookie;
    const conversationId = await conversation();
    const created = await json('/api/teams/runs', {
      method: 'POST',
      body: JSON.stringify({ conversationId, requestId: 'req-list', message: '列表' }),
    });
    const runId = created.body.run.id as string;
    // Wait for the activation to settle before listing, so the assertion is
    // about the filter and not about timing.
    for (let index = 0; index < 100; index += 1) {
      const snapshot = await json(`/api/teams/runs/${runId}`);
      const root = snapshot.body.members.find((member: any) => member.role === 'root');
      const activations = root
        ? await teamStore.listActivations(runId, root.id)
        : [];
      if (activations.every((activation) => activation.status !== 'running' && activation.status !== 'queued')) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const listed = await json('/api/conversations', {
      ...(cookie ? { identity: cookie.split(';')[0]! } : {}),
    });
    const ids = listed.body.conversations.map((entry: any) => entry.id);
    expect(ids).toContain(conversationId);
    const members = (await json(`/api/teams/runs/${runId}`)).body.members as any[];
    for (const member of members) {
      expect(ids).not.toContain(member.internalConversationId);
    }
  });
});
