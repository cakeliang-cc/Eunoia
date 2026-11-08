/**
 * E01/E02 at the real HTTP + SQLite layer, with deterministic model doubles.
 *
 * The plan allows a scripted model for E01–E05 but requires the real API and a
 * real SQLite store. These tests do exactly that: `createApp` over a temp SQLite
 * file, member executions through `TeamService`, and the browser-facing routes.
 * File/command isolation is covered by the workspace suite; these two scenarios
 * are about delegation, messaging, dependencies and acceptance.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openSqliteStore } from '../../src/db/sqlite-store.ts';
import type { SqliteStore } from '../../src/db/sqlite-store.ts';
import { SqliteTeamStore } from '../../src/teams/store-sqlite.ts';
import { createApp } from '../../src/api/server.ts';
import { SessionService } from '../../src/session/service.ts';
import { TeamService, type TeamWorkspacePort } from '../../src/teams/service.ts';
import { defaultTeamConfig } from '../../src/teams/types.ts';
import type { LoopInputItem, LoopOutputItem, ModelTurn, ModelTurnEvent, ModelTurnRequest } from '../../src/agent/model-port.ts';

const TOKEN = 'e2e-team-token';

const workspace: TeamWorkspacePort = {
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

let server: Server;
let base: string;
let store: SqliteStore;
let teamStore: SqliteTeamStore;
let directory: string;
let cookie: string | null;

function rootTurn(gate: Promise<void>): ModelTurn {
  return async function* (): AsyncGenerator<ModelTurnEvent> {
    await gate;
    yield {
      type: 'done',
      output: [{ type: 'message', role: 'assistant', content: '汇总：任务已完成并验收。' }],
      usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60, cachedTokens: 0, reported: true },
    };
  };
}

/**
 * A worker that finds the assigned task in its prompt, claims it if needed and
 * submits once. It reads the tool result rather than guessing a revision.
 */
function workerTurn(name?: string): ModelTurn {
  return async function* (request: ModelTurnRequest): AsyncGenerator<ModelTurnEvent> {
    const prompt = userText(request.input);
    const taskId = currentTaskId(prompt);
    // E02 needs a real member-to-member message: 乙 discovers 甲 through the
    // roster and sends it with the member tool, exactly as a model would.
    if (name === '乙') {
      const alreadySent = request.input.some(
        (item) => item.type === 'function_call' && item.name === 'agent_send_message',
      );
      if (!alreadySent) {
        const last = lastResult(request.input);
        if (!last) {
          yield {
            type: 'done',
            output: [
              { type: 'function_call', callId: 'roster-1', name: 'agent_list', arguments: '{}' },
            ],
            usage: { inputTokens: 50, outputTokens: 5, totalTokens: 55, cachedTokens: 0, reported: true },
          };
          return;
        }
        let roster: any = null;
        try {
          roster = JSON.parse(last.output);
        } catch {
          roster = null;
        }
        const peer = roster?.value?.members?.find(
          (member: any) => member.name === '甲',
        );
        if (peer?.id) {
          yield {
            type: 'done',
            output: [
              {
                type: 'function_call',
                callId: 'peer-1',
                name: 'agent_send_message',
                arguments: JSON.stringify({
                  recipientId: peer.id,
                  clientMessageId: 'peer-e02',
                  body: '请核对任务 A 的证据',
                }),
              },
            ],
            usage: { inputTokens: 50, outputTokens: 5, totalTokens: 55, cachedTokens: 0, reported: true },
          };
          return;
        }
      }
    }
    if (!taskId) {
      yield {
        type: 'done',
        output: [{ type: 'message', role: 'assistant', content: '已就绪。' }],
        usage: { inputTokens: 50, outputTokens: 5, totalTokens: 55, cachedTokens: 0, reported: true },
      };
      return;
    }
    const last = lastResultFor(request.input, taskId);
    if (last) {
      let parsed: any = null;
      try {
        parsed = JSON.parse(last.output);
      } catch {
        parsed = null;
      }
      const task = parsed?.value?.task;
      if (task?.status === 'submitted') {
        yield {
          type: 'done',
          output: [{ type: 'message', role: 'assistant', content: '已提交。' }],
          usage: { inputTokens: 50, outputTokens: 5, totalTokens: 55, cachedTokens: 0, reported: true },
        };
        return;
      }
      if (task && typeof task.revision === 'number') {
        const output: LoopOutputItem[] = [
          {
            type: 'function_call',
            callId: 'submit-1',
            name: 'team_task_submit',
            arguments: JSON.stringify({
              taskId,
              expectedRevision: task.revision,
              summary: `${task.title} 已完成`,
              testEvidence: [`evidence:${taskId}`],
            }),
          },
        ];
        yield {
          type: 'done',
          output,
          usage: { inputTokens: 50, outputTokens: 5, totalTokens: 55, cachedTokens: 0, reported: true },
        };
        return;
      }
    }
    yield {
      type: 'done',
      output: [
        {
          type: 'function_call',
          callId: 'get-1',
          name: 'team_task_get',
          arguments: JSON.stringify({ taskId }),
        },
      ],
      usage: { inputTokens: 50, outputTokens: 5, totalTokens: 55, cachedTokens: 0, reported: true },
    };
  };
}

function userText(input: readonly LoopInputItem[]): string {
  // Join every user message and take the *last* task id. The current task
  // instruction is the newest, but a mailbox delivery may follow it; looking
  // only at the last message would miss the task.
  return input
    .flatMap((item) =>
      item.type === 'message' && item.role === 'user'
        ? [JSON.stringify(item.content)]
        : [],
    )
    .join('\n');
}

function lastResult(input: readonly LoopInputItem[]): Extract<LoopInputItem, { type: 'function_call_result' }> | null {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index]!;
    if (item.type === 'function_call_result') return item;
  }
  return null;
}

/** The newest tool result that belongs to this task, not to an earlier one. */
/** The task named by the newest task instruction, never a dependency id. */
function currentTaskId(prompt: string): string | null {
  const pattern = /请执行任务「[^」]+」（(task_[0-9a-f-]{36})/g;
  let found: string | null = null;
  for (const match of prompt.matchAll(pattern)) found = match[1] ?? found;
  return found;
}

function lastResultFor(
  input: readonly LoopInputItem[],
  taskId: string,
): Extract<LoopInputItem, { type: 'function_call_result' }> | null {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index]!;
    if (item.type === 'function_call_result' && item.output.includes(taskId)) return item;
  }
  return null;
}

async function start(input: { readonly rootGate: Promise<void>; readonly root: ModelTurn }): Promise<void> {
  directory = await mkdtemp(join(tmpdir(), 'eunoia-team-e2e-'));
  store = openSqliteStore(join(directory, 'e2e.sqlite'));
  teamStore = new SqliteTeamStore({ path: join(directory, 'e2e.sqlite') });
  const sessions = new SessionService(store);
  const service = new TeamService({
    teamStore,
    store,
    sessions,
    workspace,
    ceiling: {
      ...defaultTeamConfig('deepseek-flash'),
      limits: {
        ...defaultTeamConfig('deepseek-flash').limits,
        maxConcurrentModelRequests: 5,
      },
      budget: {
        ...defaultTeamConfig('deepseek-flash').budget,
        maxOutputTokens: 64_000,
      },
    },
    toolPolicy: { allowWorkspaceWrites: false, allowCommands: false, maxOutputChars: 60_000 },
    resolveModelTurn: async (member) =>
      member.role === 'root' ? input.root : workerTurn(member.name),
    transcriptMode: 'durable',
  });
  server = createApp({ store, sessions, teamService: service, localToken: TOKEN });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cookie = null;
}

async function call(
  path: string,
  options: { method?: string; body?: unknown; token?: boolean } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) {
    headers['x-eunoia-token'] = TOKEN;
    if (options.body === undefined) headers['content-type'] = 'application/json';
  }
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0] ?? null;
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error('condition not met before deadline');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function snapshot(runId: string): Promise<any> {
  const response = await call(`/api/teams/runs/${runId}`);
  expect(response.status).toBe(200);
  return response.body;
}

beforeEach(() => {
  // Each test starts its own server and temp database.
});

afterEach(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await teamStore?.close();
  await store?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('E01 — delegation: fresh, fork, follow-up, close', () => {
  it('runs two members with independent conversations and closes them cleanly', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await start({ rootGate: gate, root: rootTurn(gate) });
    const conversation = (await call('/api/conversations', {
      method: 'POST',
      body: { title: 'E01' },
      token: true,
    })).body.conversation.id as string;
    const run = (await call('/api/teams/runs', {
      method: 'POST',
      token: true,
      body: { conversationId: conversation, requestId: 'e01-root', message: '委派两个成员' },
    })).body;
    const runId = run.run.id as string;
    const rootId = run.rootMemberId as string;

    const fresh = (await call(`/api/teams/runs/${runId}/members`, {
      method: 'POST',
      token: true,
      body: { parentMemberId: rootId, name: 'fresh 成员', context: 'fresh', message: '读一段只读说明。' },
    })).body;
    const fork = (await call(`/api/teams/runs/${runId}/members`, {
      method: 'POST',
      token: true,
      body: { parentMemberId: rootId, name: 'fork 成员', context: 'fork', message: '继续父上下文。' },
    })).body;
    const members = (await snapshot(runId)).members as any[];
    const freshMember = members.find((member) => member.id === fresh.member.id)!;
    const forkMember = members.find((member) => member.id === fork.member.id)!;
    expect(freshMember.internalConversationId).not.toBe(forkMember.internalConversationId);
    expect(freshMember.contextMode).toBe('fresh');
    expect(forkMember.contextMode).toBe('fork');

    // Wait for both initial activations, then follow one up and close both.
    await waitFor(async () => {
      const current = (await snapshot(runId)).members as any[];
      return current
        .filter((member) => member.role !== 'root')
        .every((member) => member.status === 'idle');
    });
    const follow = await call(`/api/teams/members/${fresh.member.id}/followup`, {
      method: 'POST',
      token: true,
      body: { runId, message: '再补充一句。' },
    });
    expect(follow.status).toBe(201);
    const closeFresh = await call(`/api/teams/members/${fresh.member.id}/close`, { method: 'POST', token: true });
    const closeFork = await call(`/api/teams/members/${fork.member.id}/close`, { method: 'POST', token: true });
    expect([200, 201]).toContain(closeFresh.status);
    expect([200, 201]).toContain(closeFork.status);

    const closed = (await snapshot(runId)).members as any[];
    expect(closed.filter((member) => member.role !== 'root').every((member) => member.status === 'closed')).toBe(true);
    // Late follow-up to a closed member is refused.
    const late = await call(`/api/teams/members/${fresh.member.id}/followup`, {
      method: 'POST',
      token: true,
      body: { runId, message: '还在吗？' },
    });
    expect(late.status).toBe(409);
    release();
    await waitFor(async () => {
      const current = await snapshot(runId);
      return ['succeeded', 'waiting_user', 'cancelled'].includes(current.run.status);
    });
    void fork;
  });
});

describe('E02 — Team: parallel work, peer message, dependency and acceptance', () => {
  it('runs two members, delivers a peer message, and accepts a dependent task', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await start({ rootGate: gate, root: rootTurn(gate) });
    const conversation = (await call('/api/conversations', {
      method: 'POST',
      body: { title: 'E02' },
      token: true,
    })).body.conversation.id as string;
    const run = (await call('/api/teams/runs', {
      method: 'POST',
      token: true,
      body: { conversationId: conversation, requestId: 'e02-root', message: '两个成员并行，第三个任务依赖它们。' },
    })).body;
    const runId = run.run.id as string;
    const rootId = run.rootMemberId as string;

    const a = (await call(`/api/teams/runs/${runId}/members`, {
      method: 'POST',
      token: true,
      body: { parentMemberId: rootId, name: '甲', context: 'fresh', message: '待命。' },
    })).body.member;
    const b = (await call(`/api/teams/runs/${runId}/members`, {
      method: 'POST',
      token: true,
      body: { parentMemberId: rootId, name: '乙', context: 'fresh', message: '待命。' },
    })).body.member;
    await waitFor(async () => {
      const members = (await snapshot(runId)).members as any[];
      return members.filter((member) => member.role !== 'root').every((member) => member.status === 'idle');
    });

    const taskA = (await call(`/api/teams/runs/${runId}/tasks`, {
      method: 'POST',
      token: true,
      body: {
        title: '任务 A',
        specification: '只读检查 A',
        acceptance: '提交证据',
        required: true,
        ownerId: a.id,
      },
    })).body.task;
    const taskB = (await call(`/api/teams/runs/${runId}/tasks`, {
      method: 'POST',
      token: true,
      body: {
        title: '任务 B',
        specification: '只读检查 B',
        acceptance: '提交证据',
        required: true,
        ownerId: b.id,
      },
    })).body.task;

    await waitFor(async () => {
      const tasks = (await snapshot(runId)).tasks as any[];
      return [taskA.id, taskB.id].every((id) =>
        ['submitted', 'accepted'].includes(tasks.find((task) => task.id === id)?.status),
      );
    });
    for (const id of [taskA.id, taskB.id]) {
      const current = (await snapshot(runId)).tasks.find((task: any) => task.id === id);
      const reviewed = await call(`/api/teams/tasks/${id}/review`, {
        method: 'POST',
        token: true,
        body: { expectedRevision: current.revision, decision: 'accepted', reason: '证据充分' },
      });
      expect(reviewed.status).toBe(200);
      expect(reviewed.body.task.status).toBe('accepted');
    }

    // The member-to-member message is produced by 乙 through agent_send_message.
    await waitFor(async () => {
      const messages = (await snapshot(runId)).messages as any[];
      return messages.some(
        (message) =>
          message.senderId === b.id && message.clientMessageId === 'peer-e02',
      );
    });

    const taskC = (await call(`/api/teams/runs/${runId}/tasks`, {
      method: 'POST',
      token: true,
      body: {
        title: '任务 C',
        specification: '引用 A 与 B 的结论',
        acceptance: '引用 A 和 B 各一条证据',
        required: true,
        ownerId: a.id,
        dependencies: [taskA.id, taskB.id],
      },
    })).body.task;
    await waitFor(async () => {
      const tasks = (await snapshot(runId)).tasks as any[];
      return ['submitted', 'accepted'].includes(
        tasks.find((task) => task.id === taskC.id)?.status,
      );
    });
    const currentC = (await snapshot(runId)).tasks.find((task: any) => task.id === taskC.id);
    const reviewedC = await call(`/api/teams/tasks/${taskC.id}/review`, {
      method: 'POST',
      token: true,
      body: { expectedRevision: currentC.revision, decision: 'accepted', reason: '引用完整' },
    });
    expect(reviewedC.body.task.status).toBe('accepted');

    release();
    await waitFor(async () => {
      const current = await snapshot(runId);
      return current.run.status === 'succeeded';
    });
    const done = await snapshot(runId);
    expect(done.tasks.every((task: any) => task.status === 'accepted')).toBe(true);
    expect(done.run.status).toBe('succeeded');
    expect(done.members.length).toBe(3);
    expect(done.messages.some((message: any) => message.senderId === b.id)).toBe(true);
  });
});
