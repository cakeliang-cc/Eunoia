/**
 * The Postgres store, against a real Postgres.
 *
 * Skipped unless `DATABASE_URL` is set, because `npm test` has to stay runnable
 * with nothing installed — a suite that requires a container is a suite that
 * gets skipped by whoever is in a hurry, and then it is not a suite.
 *
 *     docker compose up -d
 *     DATABASE_URL=postgres://designfree:designfree@localhost:5433/designfree npm test
 *
 * What this file is for: the in-memory store is the one the behavioural tests
 * run against, so the *only* thing that can go wrong here is the SQL. These
 * assertions are therefore about the translation — that a soft delete is a
 * `status` update rather than a `DELETE`, that an update cannot cross a user
 * boundary, that `updated_at` moves — rather than about behaviour, which is
 * already covered elsewhere against the same interface.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

import { createPool, describeTarget } from '../../src/db/pool.ts';
import { migrate } from '../../src/db/migrate.ts';
import { PostgresStore } from '../../src/db/postgres-store.ts';

const url = process.env.DATABASE_URL?.trim() ?? '';
const enabled = url.length > 0;

// Assigned in `beforeAll`, which only runs when the suite is enabled.
let pool!: Pool;
let store!: PostgresStore;

const createdUsers: string[] = [];

async function freshUser(): Promise<string> {
  const id = randomUUID();
  await store.ensureUser(id);
  createdUsers.push(id);
  return id;
}

describe.skipIf(!enabled)('PostgresStore', () => {
  beforeAll(async () => {
    pool = createPool(url);
    await migrate(pool);
    store = new PostgresStore(pool);
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    for (const userId of createdUsers) {
      await pool.query('DELETE FROM agent_runs WHERE user_id = $1', [userId]).catch(() => undefined);
      await pool.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => undefined);
    }
    // Evaluation rows are written under throwaway users and cleaned above; the
    // case rows themselves are shared and left in place.
    await pool.end();
  });

  beforeEach(() => {
    createdUsers.length = 0;
  });

  it('reports the target without leaking credentials', () => {
    const described = describeTarget(url);
    expect(described).toContain('5433');
    expect(described).not.toContain('designfree:designfree');
  });

  it('answers a ping', async () => {
    expect(await store.ping()).toBe(true);
  });

  it('confirms the vector extension and the embedding column exist', async () => {
    // The column and its index are created now and unused until similarity is
    // switched on. If they were missing, enabling it would be a migration rather
    // than a backfill — and the migration would happen at the worst moment.
    const { rows } = await pool.query<{ extversion: string }>(
      "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
    );
    expect(rows[0]?.extversion).toBeTruthy();

    const column = await pool.query(
      `SELECT atttypmod FROM pg_attribute
       WHERE attrelid = 'memories'::regclass AND attname = 'embedding'`,
    );
    expect(column.rows).toHaveLength(1);
  });

  // ------------------------------------------------------------ memories -----

  it('creates and reads a memory back', async () => {
    const userId = await freshUser();
    const created = await store.createMemory(userId, {
      type: 'semantic',
      content: '用户讨厌香菜',
      importance: 0.7,
      confidence: 0.9,
      source: 'user_stated',
      tags: ['饮食'],
    });

    const read = await store.getMemory(userId, created.id);
    expect(read?.content).toBe('用户讨厌香菜');
    expect(read?.importance).toBeCloseTo(0.7, 5);
    expect(read?.status).toBe('active');
    expect(read?.tags).toEqual(['饮食']);
  });

  it('keeps an explicit status, so the nullability convention round-trips', async () => {
    const userId = await freshUser();
    const created = await store.createMemory(userId, {
      type: 'narrative',
      content: '用户可能在考虑换工作',
      source: 'inferred',
      confidence: 0.9,
      status: 'unconfirmed',
    });

    expect((await store.getMemory(userId, created.id))?.status).toBe('unconfirmed');
  });

  it('soft-deletes rather than removing the row', async () => {
    const userId = await freshUser();
    const created = await store.createMemory(userId, {
      type: 'semantic',
      content: '用户喜欢跑步',
      source: 'user_stated',
    });

    expect(await store.deleteMemory(userId, created.id)).toBe(true);
    expect((await store.getMemory(userId, created.id))?.status).toBe('deleted');

    // Asking for every row returns every row, including the deleted one. That is
    // the right default for a data layer and the wrong one for a screen, so the
    // filter lives at the call site that faces a person — see
    // `VISIBLE_MEMORY_STATUSES` in `src/api/server.ts`.
    expect(await store.listMemories(userId)).toHaveLength(1);
    expect(await store.listMemories(userId, { statuses: ['active', 'unconfirmed'] })).toEqual([]);
    expect(await store.listMemories(userId, { statuses: ['deleted'] })).toHaveLength(1);
  });

  it('refuses to read or write another user\'s memory', async () => {
    const alice = await freshUser();
    const bob = await freshUser();
    const created = await store.createMemory(alice, {
      type: 'semantic',
      content: '私事',
      source: 'user_stated',
    });

    expect(await store.getMemory(bob, created.id)).toBeNull();
    expect(await store.updateMemory(bob, created.id, { content: '被我改了' })).toBeNull();
    expect(await store.deleteMemory(bob, created.id)).toBe(false);
    expect((await store.getMemory(alice, created.id))?.content).toBe('私事');
  });

  it('moves updated_at on an update but leaves created_at alone', async () => {
    const userId = await freshUser();
    const created = await store.createMemory(userId, {
      type: 'semantic',
      content: '用户喜欢跑步',
      source: 'user_stated',
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    const updated = await store.updateMemory(userId, created.id, { content: '用户不跑步了' });

    expect(updated?.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
    expect(updated?.createdAt.getTime()).toBe(created.createdAt.getTime());
  });

  it('filters by type and by status', async () => {
    const userId = await freshUser();
    await store.createMemory(userId, { type: 'episodic', content: '事件', source: 'user_stated' });
    await store.createMemory(userId, { type: 'semantic', content: '偏好', source: 'user_stated' });

    expect(await store.listMemories(userId, { types: ['semantic'] })).toHaveLength(1);
    expect(await store.listMemories(userId, { types: ['episodic', 'semantic'] })).toHaveLength(2);
  });

  it('counts accesses, which the memory panel displays', async () => {
    const userId = await freshUser();
    const created = await store.createMemory(userId, {
      type: 'semantic',
      content: '用户养了一只叫团子的猫',
      source: 'user_stated',
    });

    await store.markAccessed(userId, [created.id]);
    await store.markAccessed(userId, [created.id]);

    const read = await store.getMemory(userId, created.id);
    expect(read?.accessCount).toBe(2);
    expect(read?.lastAccessedAt).toBeInstanceOf(Date);
  });

  it('ignores an access for a memory that is not the caller\'s', async () => {
    const alice = await freshUser();
    const bob = await freshUser();
    const created = await store.createMemory(alice, {
      type: 'semantic',
      content: 'x',
      source: 'user_stated',
    });

    await store.markAccessed(bob, [created.id]);
    expect((await store.getMemory(alice, created.id))?.accessCount).toBe(0);
  });

  it('writes a memory event with a null memory id, which is what retrieval logs', async () => {
    // `memory_id` is nullable precisely so a retrieval — which is about a set of
    // memories, not one — can be recorded.
    const userId = await freshUser();
    await store.logMemoryEvent({
      memoryId: null,
      userId,
      action: 'retrieved',
      actor: 'system',
      detail: { count: 3 },
    });

    const { rows } = await pool.query(
      'SELECT action, actor, detail FROM memory_events WHERE user_id = $1',
      [userId],
    );
    expect(rows[0]?.action).toBe('retrieved');
    expect(rows[0]?.detail).toEqual({ count: 3 });
  });

  // ------------------------------------------------------- conversations -----

  it('creates a conversation, appends messages and counts turns', async () => {
    const userId = await freshUser();
    const conversation = await store.ensureConversation(userId);

    await store.appendMessage({ conversationId: conversation.id, userId, role: 'user', content: '一' });
    await store.appendMessage({ conversationId: conversation.id, userId, role: 'assistant', content: '二' });
    await store.appendMessage({ conversationId: conversation.id, userId, role: 'user', content: '三' });

    const recent = await store.recentMessages(conversation.id, 2);
    expect(recent.map((message) => message.content)).toEqual(['二', '三']);

    const listed = await store.listConversations(userId);
    expect(listed[0]?.turnCount).toBe(2);
    expect(listed[0]?.lastTurnAt).toBeInstanceOf(Date);
  });

  it('reuses a conversation when given its id, and makes a new one otherwise', async () => {
    const userId = await freshUser();
    const first = await store.ensureConversation(userId);
    const again = await store.ensureConversation(userId, first.id);
    const other = await store.ensureConversation(userId);

    expect(again.id).toBe(first.id);
    expect(other.id).not.toBe(first.id);
  });

  it('does not hand a conversation to the wrong user', async () => {
    const alice = await freshUser();
    const bob = await freshUser();
    const aliceConversation = await store.ensureConversation(alice);

    const asBob = await store.ensureConversation(bob, aliceConversation.id);
    // Asking for someone else's conversation gets you a new one, not theirs.
    expect(asBob.id).not.toBe(aliceConversation.id);
    expect(await store.listMessages(bob, aliceConversation.id)).toEqual([]);
  });

  // -------------------------------------------------- preferences, feedback --

  it('round-trips a JSON preference', async () => {
    const userId = await freshUser();
    await store.setPreference(userId, 'memory.enabled', false);
    await store.setPreference(userId, 'tone', { directness: 0.8 });

    expect(await store.getPreference(userId, 'memory.enabled')).toBe(false);
    expect(await store.getPreference(userId, 'tone')).toEqual({ directness: 0.8 });
    expect(await store.listPreferences(userId)).toMatchObject({ 'memory.enabled': false });
  });

  it('returns null for a preference that was never set', async () => {
    expect(await store.getPreference(await freshUser(), 'nope')).toBeNull();
  });

  it('upserts feedback, so changing your mind replaces the rating', async () => {
    const userId = await freshUser();
    const conversation = await store.ensureConversation(userId);
    const message = await store.appendMessage({
      conversationId: conversation.id,
      userId,
      role: 'assistant',
      content: '嗯。',
    });

    await store.saveFeedback({ messageId: message.id, userId, rating: 'bad' });
    await store.saveFeedback({ messageId: message.id, userId, rating: 'good' });

    const listed = await store.listFeedback(userId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.rating).toBe('good');
  });

  it('records a run and its fingerprints', async () => {
    const userId = await freshUser();
    const conversation = await store.ensureConversation(userId);
    const id = randomUUID();

    await store.recordRun({
      id,
      userId,
      conversationId: conversation.id,
      model: 'deepseek-v4-pro',
      promptVersion: 'abc123',
      status: 'completed',
      usedTools: true,
      toolCalls: ['search_memory'],
      inputFingerprint: 'len=6',
      outputFingerprint: 'len=2',
      riskLevel: 'none',
      durationMs: 1200,
      error: null,
    });

    const { rows } = await pool.query('SELECT * FROM agent_runs WHERE id = $1', [id]);
    expect(rows[0]?.tool_calls).toEqual(['search_memory']);
    // The message itself is not stored on the run row: the fingerprint is what
    // makes a run greppable without putting a person's words in an audit table.
    expect(rows[0]?.input_fingerprint).toBe('len=6');
  });
});
