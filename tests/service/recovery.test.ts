/**
 * Turn recovery (ADR 028).
 *
 * The scenario under test is the one that separates "interrupt and continue"
 * from "crash recovery": the model asked for a write, the write succeeded, and
 * the process died before the reply was stored. Recovery must be able to say what
 * was asked, what was observed, and what could not be — and it must never run the
 * tool again.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import {
  recoverInterruptedTurns,
  toolStatusForExecution,
  type ExecutionStatusReader,
} from '../../src/service/recovery.ts';
import { TurnCoordinator, turnRequestHash } from '../../src/service/turns.ts';
import type { NewTurnEvent } from '../../src/session/turn-types.ts';

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

/** A turn that was admitted, did some work, and then lost its process. */
async function crashedTurn(events: readonly Omit<NewTurnEvent, 'turnId' | 'conversationId'>[]) {
  const requestId = randomUUID();
  const admission = await coordinator.begin({
    requestId,
    turnId: randomUUID(),
    userId: USER,
    conversationId,
    requestHash: turnRequestHash({
      kind: 'chat',
      userId: USER,
      conversationId,
      message: '把 a.ts 改一下',
    }),
  });
  expect(admission.kind).toBe('started');
  for (const event of events) {
    await store.appendTurnEvent({ ...event, turnId: requestId, conversationId });
  }
  return requestId;
}

function sandboxSays(status: string): ExecutionStatusReader {
  return { executionStatus: async () => status };
}

describe('recovering a crashed turn', () => {
  it('settles the write against the sandbox record and keeps the partial reply', async () => {
    const requestId = await crashedTurn([
      {
        kind: 'assistant_text',
        status: 'succeeded',
        payload: { step: 1, text: '我先改一下文件。' },
      },
      {
        kind: 'tool_call',
        callId: 'call-1',
        toolName: 'write_file',
        status: 'running',
        executionId: 'exec-1',
        payload: { arguments: '{"path":"a.ts"}' },
      },
    ]);

    const report = await recoverInterruptedTurns({
      store,
      executions: sandboxSays('SUCCEEDED'),
    });

    expect(report).toMatchObject({ checked: 1, recovered: 1, unknownExecutions: 0 });

    const turn = await store.getTurn(requestId);
    expect(turn).toMatchObject({
      status: 'interrupted',
      finishReason: 'crashed',
      reply: '我先改一下文件。',
      accepted: false,
    });
    expect(turn?.acceptance).toEqual([
      { id: 'finished', ok: false, detail: 'the process ended before the turn reached an outcome' },
    ]);

    // The call is settled from the sandbox's own row, and its arguments are
    // still there: that is what "we know what was asked" means after a crash.
    const events = await store.listTurnEvents(requestId);
    const call = events.find((event) => event.kind === 'tool_call');
    expect(call?.status).toBe('succeeded');
    expect(call?.payload).toMatchObject({ arguments: '{"path":"a.ts"}', reconciled: 'SUCCEEDED' });

    // The half-written reply is a real transcript message, marked interrupted so
    // the next turn can continue from it.
    const messages = await store.listMessages(USER, conversationId);
    expect(messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: '我先改一下文件。',
      interrupted: true,
    });
    expect(turn?.messageId).toBe(messages.at(-1)?.id);
  });

  it('keeps an unobservable outcome UNKNOWN and never replays it', async () => {
    const requestId = await crashedTurn([
      {
        kind: 'tool_call',
        callId: 'call-1',
        toolName: 'bash',
        status: 'running',
        executionId: 'exec-1',
        payload: { arguments: '{"command":["rm","-rf","build"]}' },
      },
    ]);

    const report = await recoverInterruptedTurns({ store });

    expect(report).toMatchObject({ checked: 1, recovered: 1, unknownExecutions: 1 });
    const events = await store.listTurnEvents(requestId);
    expect(events.filter((event) => event.kind === 'tool_call')).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: 'unknown',
      payload: { reconciled: 'no-record' },
    });
    // No replay: recovery produced no second call and no result for the first.
    expect(events.some((event) => event.kind === 'tool_result')).toBe(false);
  });

  it('adopts a recorded result instead of asking the sandbox again', async () => {
    let asked = 0;
    const requestId = await crashedTurn([
      {
        kind: 'tool_call',
        callId: 'call-1',
        toolName: 'write_file',
        status: 'running',
        executionId: 'exec-1',
        payload: { arguments: '{}' },
      },
      {
        kind: 'tool_result',
        callId: 'call-1',
        toolName: 'write_file',
        status: 'failed',
        payload: { ok: false, output: '' },
      },
    ]);

    await recoverInterruptedTurns({
      store,
      executions: {
        executionStatus: async () => {
          asked += 1;
          return 'SUCCEEDED';
        },
      },
    });

    const [call] = await store.listTurnEvents(requestId);
    expect(call?.status).toBe('failed');
    expect(call?.payload).toMatchObject({ reconciled: 'tool_result' });
    expect(asked).toBe(0);
  });

  it('does the same thing twice without duplicating the partial reply', async () => {
    await crashedTurn([
      { kind: 'assistant_text', status: 'succeeded', payload: { step: 1, text: '半截话' } },
    ]);

    await recoverInterruptedTurns({ store });
    const first = await store.listMessages(USER, conversationId);
    const second = await recoverInterruptedTurns({ store });
    const after = await store.listMessages(USER, conversationId);

    expect(second).toMatchObject({ checked: 0, recovered: 0 });
    expect(after).toHaveLength(first.length);
    expect(after.filter((message) => message.content === '半截话')).toHaveLength(1);
  });

  it('adopts a message that was already stored before the crash', async () => {
    const requestId = await crashedTurn([
      { kind: 'assistant_text', status: 'succeeded', payload: { step: 1, text: '已经写下的半截' } },
    ]);
    // The crash landed between the message insert and the turn finish.
    const stored = await store.appendMessage({
      conversationId,
      userId: USER,
      role: 'assistant',
      content: '已经写下的半截',
      interrupted: true,
    });

    await recoverInterruptedTurns({ store });

    const turn = await store.getTurn(requestId);
    expect(turn?.messageId).toBe(stored.id);
    const messages = await store.listMessages(USER, conversationId);
    expect(messages.filter((message) => message.content === '已经写下的半截')).toHaveLength(1);
  });

  it('leaves a turn that already finished alone', async () => {
    const requestId = randomUUID();
    const admission = await coordinator.begin({
      requestId,
      userId: USER,
      conversationId,
      requestHash: turnRequestHash({ kind: 'chat', userId: USER, conversationId, message: 'x' }),
    });
    expect(admission.kind).toBe('started');
    await coordinator.finish(requestId, {
      status: 'completed',
      finishReason: 'completed',
      reply: '答完了',
    });

    const report = await recoverInterruptedTurns({ store });
    expect(report.checked).toBe(0);
    expect((await store.getTurn(requestId))?.finishReason).toBe('completed');
  });
});

describe('sandbox status mapping', () => {
  it('distinguishes observed success, observed failure and the unknown middle', () => {
    expect(toolStatusForExecution('SUCCEEDED')).toBe('succeeded');
    for (const failed of ['FAILED', 'TIMEOUT', 'CANCELLED', 'INTERRUPTED']) {
      expect(toolStatusForExecution(failed)).toBe('failed');
    }
    // RETRYABLE is a decision the sandbox is allowed to make, not an observation
    // of this run; treating it as success or failure would both be guesses.
    for (const unknown of ['RUNNING', 'SUBMITTED', 'RECONCILING', 'RETRYABLE', 'UNKNOWN', null]) {
      expect(toolStatusForExecution(unknown)).toBe('unknown');
    }
  });
});
