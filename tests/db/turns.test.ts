/**
 * Turn admission and execution history, against a real SQLite file (ADR 027).
 *
 * The in-memory coordinator tests pin the rule; this file pins what only SQLite
 * can get wrong: the partial unique index that makes the rule hold when two
 * requests interleave, the foreign keys that clean the records up, the JSON
 * payload round-trip, and the version-7 → version-8 migration.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSqliteStore, type SqliteStore } from '../../src/db/sqlite-store.ts';
import { TurnCoordinator, turnRequestHash } from '../../src/service/turns.ts';
import { StoreTurnRecorder } from '../../src/service/turn-recorder.ts';
import type { TurnRecord } from '../../src/session/turn-types.ts';

let store: SqliteStore;
let scratch: string | null = null;

beforeEach(() => {
  store = openSqliteStore(':memory:');
});

afterEach(async () => {
  await store.close();
  if (scratch) {
    await rm(scratch, { recursive: true, force: true });
    scratch = null;
  }
});

async function seeded(): Promise<{ userId: string; conversationId: string }> {
  const userId = randomUUID();
  await store.ensureUser(userId);
  const conversation = await store.createConversation(userId);
  return { userId, conversationId: conversation.id };
}

function record(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    id: randomUUID(),
    turnId: randomUUID(),
    userId: 'placeholder',
    conversationId: 'placeholder',
    requestHash: 'hash',
    status: 'running',
    finishReason: null,
    reply: '',
    messageId: null,
    error: null,
    model: 'deepseek-flash',
    steps: 0,
    contextTokens: null,
    accepted: null,
    acceptance: [],
    usage: null,
    startedAt: new Date(),
    endedAt: null,
    ...overrides,
  };
}

describe('turn admission in SQLite', () => {
  it('lists a conversation trace oldest-first, bounded by time and row count', async () => {
    const { userId, conversationId } = await seeded();
    const other = await store.createConversation(userId);
    const turn = record({ userId, conversationId });
    const otherTurn = record({ userId, conversationId: other.id });
    await store.createTurn(turn);
    await store.createTurn(otherTurn);

    await store.appendTurnEvent({
      turnId: turn.id,
      conversationId,
      kind: 'tool_call',
      callId: 'c1',
      toolName: 'read',
      status: 'running',
      payload: { arguments: '{"file_path":"a.ts"}' },
    });
    await store.appendTurnEvent({
      turnId: turn.id,
      conversationId,
      kind: 'tool_result',
      callId: 'c1',
      toolName: 'read',
      status: 'succeeded',
      payload: { ok: true },
    });
    await store.appendTurnEvent({
      turnId: otherTurn.id,
      conversationId: other.id,
      kind: 'tool_call',
      callId: 'c2',
      toolName: 'bash',
      status: 'running',
      payload: {},
    });

    const all = await store.listConversationTurnEvents(conversationId);
    expect(all.map((entry) => entry.kind)).toEqual(['tool_call', 'tool_result']);
    expect(all[0]?.payload.arguments).toBe('{"file_path":"a.ts"}');

    const newest = await store.listConversationTurnEvents(conversationId, { limit: 1 });
    expect(newest.map((entry) => entry.kind)).toEqual(['tool_result']);

    const beforeEverything = await store.listConversationTurnEvents(conversationId, {
      before: new Date('2000-01-01T00:00:00.000Z'),
    });
    expect(beforeEverything).toEqual([]);
  });

  it('refuses a second running turn in the same conversation at the index', async () => {
    const { userId, conversationId } = await seeded();
    expect(await store.createTurn(record({ userId, conversationId }))).toBe('created');
    expect(await store.createTurn(record({ userId, conversationId }))).toBe('busy');

    const other = await store.createConversation(userId);
    expect(await store.createTurn(record({ userId, conversationId: other.id }))).toBe('created');
  });

  it('reports an existing id as exists rather than as busy', async () => {
    const { userId, conversationId } = await seeded();
    const first = record({ userId, conversationId });
    expect(await store.createTurn(first)).toBe('created');
    expect(await store.createTurn({ ...first, requestHash: 'different' })).toBe('exists');
    // The first row is the one that counts; a duplicate insert must not rewrite it.
    expect((await store.getTurn(first.id))?.requestHash).toBe('hash');
  });

  it('round-trips every field a finished turn writes', async () => {
    const { userId, conversationId } = await seeded();
    const turn = record({ userId, conversationId });
    await store.createTurn(turn);

    const finished = await store.finishTurn(turn.id, {
      status: 'completed',
      finishReason: 'incomplete_stream',
      reply: '说到一半',
      messageId: 'msg-9',
      steps: 3,
      contextTokens: 12_345,
      accepted: false,
      acceptance: [{ id: 'has_output', ok: true }, { id: 'finished', ok: false }],
    });

    expect(finished?.status).toBe('completed');
    expect(finished?.finishReason).toBe('incomplete_stream');
    expect(finished?.reply).toBe('说到一半');
    expect(finished?.messageId).toBe('msg-9');
    expect(finished?.steps).toBe(3);
    expect(finished?.contextTokens).toBe(12_345);
    expect(finished?.accepted).toBe(false);
    expect(finished?.acceptance).toEqual([
      { id: 'has_output', ok: true },
      { id: 'finished', ok: false },
    ]);
    expect(finished?.endedAt).toBeInstanceOf(Date);

    // A second finish is a no-op, which is what lets a transport safety net run
    // after the orchestrator without inventing a second outcome.
    const again = await store.finishTurn(turn.id, {
      status: 'failed',
      finishReason: 'failed',
      error: 'late',
    });
    expect(again?.status).toBe('completed');
    expect(again?.error).toBeNull();
  });

  it('frees the conversation as soon as the turn is finished', async () => {
    const { userId, conversationId } = await seeded();
    const turn = record({ userId, conversationId });
    await store.createTurn(turn);
    await store.finishTurn(turn.id, { status: 'interrupted', finishReason: 'cancelled' });

    expect(await store.activeTurn(conversationId)).toBeNull();
    expect(await store.createTurn(record({ userId, conversationId }))).toBe('created');
  });

  it('lists only running turns and cascades them with the conversation', async () => {
    const { userId, conversationId } = await seeded();
    await store.createTurn(record({ userId, conversationId }));
    expect(await store.listRunningTurns()).toHaveLength(1);

    expect(await store.deleteConversation(userId, conversationId)).toBe(true);
    expect(await store.listRunningTurns()).toHaveLength(0);
  });

  it('is the lock the coordinator relies on, not just a table', async () => {
    const { userId, conversationId } = await seeded();
    const coordinator = new TurnCoordinator(store);
    const requestHash = turnRequestHash({
      kind: 'chat',
      userId,
      conversationId,
      message: 'A',
    });

    const settled = await Promise.allSettled([
      coordinator.begin({ requestId: randomUUID(), userId, conversationId, requestHash }),
      coordinator.begin({ requestId: randomUUID(), userId, conversationId, requestHash }),
    ]);
    expect(settled.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((entry) => entry.status === 'rejected')).toHaveLength(1);
  });
});

describe('turn events', () => {
  it('assigns seq in append order and round-trips the payload', async () => {
    const { userId, conversationId } = await seeded();
    const turn = record({ userId, conversationId });
    await store.createTurn(turn);

    const call = await store.appendTurnEvent({
      turnId: turn.id,
      conversationId,
      kind: 'tool_call',
      callId: 'call-1',
      toolName: 'write_file',
      status: 'running',
      payload: { arguments: { path: 'a.txt' } },
    });
    const result = await store.appendTurnEvent({
      turnId: turn.id,
      conversationId,
      kind: 'tool_result',
      callId: 'call-1',
      toolName: 'write_file',
      status: 'succeeded',
      executionId: 'exec-1',
      payload: { output: 'wrote 12 bytes' },
    });

    expect(call.seq).toBe(1);
    expect(result.seq).toBe(2);

    const events = await store.listTurnEvents(turn.id);
    expect(events.map((event) => event.kind)).toEqual(['tool_call', 'tool_result']);
    expect(events[0]?.payload).toEqual({ arguments: { path: 'a.txt' } });
    expect(events[1]?.executionId).toBe('exec-1');
  });

  it('settles an unobserved call as unknown without losing its arguments', async () => {
    const { userId, conversationId } = await seeded();
    const turn = record({ userId, conversationId });
    await store.createTurn(turn);
    const call = await store.appendTurnEvent({
      turnId: turn.id,
      conversationId,
      kind: 'tool_call',
      callId: 'call-1',
      toolName: 'bash',
      status: 'running',
      payload: { arguments: { command: ['touch', 'x'] } },
    });

    await store.settleTurnEvent(turn.id, call.seq, 'unknown', { reconciled: 'no-record' });

    const [settled] = await store.listTurnEvents(turn.id);
    expect(settled?.status).toBe('unknown');
    expect(settled?.payload).toEqual({
      arguments: { command: ['touch', 'x'] },
      reconciled: 'no-record',
    });
  });

  it('cascades events with their turn', async () => {
    const { userId, conversationId } = await seeded();
    const turn = record({ userId, conversationId });
    await store.createTurn(turn);
    await store.appendTurnEvent({
      turnId: turn.id,
      conversationId,
      kind: 'assistant_text',
      status: 'succeeded',
      payload: { text: '半截' },
    });

    await store.deleteConversation(userId, conversationId);
    expect(await store.listTurnEvents(turn.id)).toHaveLength(0);
  });
});

describe('the execution recorder adapter', () => {
  it('writes calls, results and step text in the order the loop produced them', async () => {
    const { userId, conversationId } = await seeded();
    const turn = record({ userId, conversationId });
    await store.createTurn(turn);
    const recorder = new StoreTurnRecorder({
      store,
      turnId: turn.id,
      conversationId,
    });

    await recorder.assistantText(1, '我先改一下。');
    await recorder.toolCallRequested({
      callId: 'call-1',
      name: 'write_file',
      arguments: '{"path":"a.ts"}',
      summary: 'write a.ts',
    });
    await recorder.toolResult({
      callId: 'call-1',
      name: 'write_file',
      ok: true,
      status: 'succeeded',
      executionId: 'exec-1',
      output: 'wrote it',
      outputChars: 8,
    });
    await recorder.assistantText(2, '改好了。');

    const events = await store.listTurnEvents(turn.id);
    expect(events.map((event) => event.kind)).toEqual([
      'assistant_text',
      'tool_call',
      'tool_result',
      'assistant_text',
    ]);
    expect(events[1]).toMatchObject({
      callId: 'call-1',
      toolName: 'write_file',
      status: 'running',
      payload: { arguments: '{"path":"a.ts"}', summary: 'write a.ts' },
    });
    expect(events[2]).toMatchObject({
      status: 'succeeded',
      executionId: 'exec-1',
      payload: { ok: true, output: 'wrote it', outputChars: 8 },
    });
  });

  it('bounds the recorded output while keeping its true size', async () => {
    const { userId, conversationId } = await seeded();
    const turn = record({ userId, conversationId });
    await store.createTurn(turn);
    const recorder = new StoreTurnRecorder({ store, turnId: turn.id, conversationId });

    const output = 'x'.repeat(50_000);
    await recorder.toolResult({
      callId: 'call-1',
      name: 'read_file',
      ok: true,
      status: 'succeeded',
      output,
      outputChars: output.length,
    });

    const [event] = await store.listTurnEvents(turn.id);
    expect((event?.payload.output as string).length).toBe(2_000);
    expect(event?.payload.outputChars).toBe(50_000);
  });
});

describe('the version 7 to 8 migration', () => {
  it('adds the turn tables and the run finish reason without touching old rows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eunoia-turn-migrate-'));
    scratch = dir;
    const path = join(dir, 'eunoia.sqlite');

    // Build a current file, then rewind it to the version-7 shape: this is what
    // an installation from before this change looks like on disk.
    const first = openSqliteStore(path);
    const userId = randomUUID();
    await first.ensureUser(userId);
    await first.recordRun({
      id: 'run-old',
      userId,
      conversationId: null,
      model: 'deepseek-flash',
      promptVersion: 'v1',
      status: 'completed',
      usedTools: false,
      toolCalls: [],
      inputFingerprint: 'in',
      outputFingerprint: 'out',
      riskLevel: null,
      durationMs: 10,
      error: null,
    });
    await first.close();

    const legacy = new DatabaseSync(path);
    legacy.exec('DROP TABLE IF EXISTS turn_events');
    legacy.exec('DROP TABLE IF EXISTS turn_requests');
    legacy.exec('ALTER TABLE agent_runs DROP COLUMN finish_reason');
    legacy.exec('PRAGMA user_version = 7');
    legacy.close();

    const upgraded = openSqliteStore(path);
    try {
      const version = upgraded.database.prepare('PRAGMA user_version').get() as {
        user_version: number;
      };
      expect(Number(version.user_version)).toBe(11);

      const tables = (
        upgraded.database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as { name: string }[]
      ).map((row) => row.name);
      expect(tables).toContain('turn_requests');
      expect(tables).toContain('turn_events');

      const runColumns = (
        upgraded.database.prepare('PRAGMA table_info(agent_runs)').all() as { name: string }[]
      ).map((column) => column.name);
      expect(runColumns).toContain('finish_reason');

      const row = upgraded.database
        .prepare("SELECT id, finish_reason FROM agent_runs WHERE id = 'run-old'")
        .get() as { id: string; finish_reason: string | null } | undefined;
      expect(row?.id).toBe('run-old');
      expect(row?.finish_reason).toBeNull();
    } finally {
      await upgraded.close();
    }
  });
});
