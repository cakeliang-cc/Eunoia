/**
 * The Postgres store, against a real Postgres.
 *
 * Skipped unless `DATABASE_URL` is set, because `npm test` has to stay runnable
 * with nothing installed — a suite that requires a container is a suite that
 * gets skipped by whoever is in a hurry, and then it is not a suite.
 *
 *     docker compose up -d
 *     DATABASE_URL=postgres://designfree:<password>@127.0.0.1:5433/designfree npm test
 *
 * What this file is for: the in-memory store is the one the behavioural tests
 * run against, so the *only* thing that can go wrong here is the SQL. These
 * assertions are therefore about the translation — that a soft delete is a
 * `status` update rather than a `DELETE`, that an update cannot cross a user
 * boundary, that `updated_at` moves — rather than about behaviour, which is
 * already covered elsewhere against the same interface.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

/**
 * Everyone this file creates, cleaned up in `afterAll`.
 *
 * Deliberately *not* reset between tests. It was, and the effect was that only
 * the last test's users were ever removed — every earlier test left a user, a
 * conversation and a memory behind, which is the same accumulation this project
 * had just written a retention sweep to stop. Found by counting the rows in the
 * database rather than by reading this file.
 */
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
      // Runs first, and by hand: `users` is `ON DELETE SET NULL` for them, so
      // deleting the user leaves the run behind. That is the right behaviour for
      // a real deletion and clutter in a test database.
      await pool.query('DELETE FROM agent_runs WHERE user_id = $1', [userId]).catch(() => undefined);
      await pool.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => undefined);
    }
    // Evaluation rows are written under throwaway users and cleaned above; the
    // case rows themselves are shared and left in place.
    await pool.end();
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

  it('derives the relationship from counts, in one query', async () => {
    const userId = await freshUser();

    // Before anything: no history, and nulls rather than zero dates. `new Date(0)`
    // would render as "认识 20000 天".
    const before = await store.historyStats(userId);
    expect(before).toEqual({ conversations: 0, messages: 0, firstAt: null, lastAt: null });

    const first = await store.ensureConversation(userId);
    await store.appendMessage({ conversationId: first.id, userId, role: 'user', content: '一' });
    const other = await store.ensureConversation(userId);
    await store.appendMessage({ conversationId: other.id, userId, role: 'assistant', content: '二' });

    const after = await store.historyStats(userId);
    expect(after.conversations).toBe(2);
    // Both roles count: the relationship is not a count of things the person
    // said, it is how much has passed between us.
    expect(after.messages).toBe(2);
    expect(after.firstAt).toBeInstanceOf(Date);
    expect(after.lastAt).toBeInstanceOf(Date);
    // `count(*)` comes back from `pg` as a string, so this is the assertion that
    // catches a missing cast — the arithmetic downstream would have produced
    // "3 次对话" by string concatenation rather than addition.
    expect(typeof after.conversations).toBe('number');
    expect(typeof after.messages).toBe('number');
  });

  it('counts only the caller\'s own history', async () => {
    const userId = await freshUser();
    const strangerId = await freshUser();
    const strangerConversation = await store.ensureConversation(strangerId);
    await store.appendMessage({
      conversationId: strangerConversation.id,
      userId: strangerId,
      role: 'user',
      content: '不该被数进去',
    });

    expect((await store.historyStats(userId)).conversations).toBe(0);
  });

  it('reuses a conversation when given its id, and makes a new one otherwise', async () => {
    const userId = await freshUser();
    const first = await store.ensureConversation(userId);
    const again = await store.ensureConversation(userId, first.id);
    const other = await store.ensureConversation(userId);

    expect(again.id).toBe(first.id);
    expect(other.id).not.toBe(first.id);
  });

  it('names a conversation once, and never replaces the name', async () => {
    const userId = await freshUser();
    const conversation = await store.ensureConversation(userId);

    await store.nameConversation(userId, conversation.id, '今天不想上班');
    await store.nameConversation(userId, conversation.id, '后来的这句话');

    // The second call is what a long conversation would otherwise do on every
    // turn: the list would be a rolling window onto whatever was said last.
    const listed = await store.listConversations(userId);
    expect(listed[0]?.title).toBe('今天不想上班');
  });

  it('does not name a conversation that belongs to someone else', async () => {
    const alice = await freshUser();
    const bob = await freshUser();
    const aliceConversation = await store.ensureConversation(alice);

    await store.nameConversation(bob, aliceConversation.id, '我给它起个名字');

    const listed = await store.listConversations(alice);
    expect(listed[0]?.title).toBeNull();
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

  it('creates, renames, archives and deletes a conversation', async () => {
    const userId = await freshUser();
    const created = await store.createConversation(userId, '面试复盘');
    expect(created.title).toBe('面试复盘');
    expect(created.archivedAt).toBeNull();

    expect((await store.getConversation(userId, created.id))?.id).toBe(created.id);

    const renamed = await store.updateConversation(userId, created.id, {
      title: '换个名字',
      archived: true,
    });
    expect(renamed?.title).toBe('换个名字');
    expect(renamed?.archivedAt).toBeInstanceOf(Date);

    // Clearing the name is a different parameter shape than setting it: a
    // nullable `title = $3` must still be typed by the column, not guessed.
    const cleared = await store.updateConversation(userId, created.id, { title: null });
    expect(cleared?.title).toBeNull();

    // Archived is hidden from the ordinary list, not deleted.
    expect((await store.listConversations(userId)).map((row) => row.id)).not.toContain(
      created.id,
    );
    expect(
      (await store.listConversations(userId, { includeArchived: true })).map((row) => row.id),
    ).toContain(created.id);

    const restored = await store.updateConversation(userId, created.id, { archived: false });
    expect(restored?.archivedAt).toBeNull();

    await store.appendMessage({
      conversationId: created.id,
      userId,
      role: 'user',
      content: '继续',
    });
    expect((await store.getConversation(userId, created.id))?.turnCount).toBe(1);

    expect(await store.deleteConversation(userId, created.id)).toBe(true);
    expect(await store.getConversation(userId, created.id)).toBeNull();
    expect(await store.listMessages(userId, created.id)).toEqual([]);
  });

  it('unarchives a conversation when a new message is written', async () => {
    const userId = await freshUser();
    const conversation = await store.createConversation(userId);
    await store.updateConversation(userId, conversation.id, { archived: true });

    await store.appendMessage({
      conversationId: conversation.id,
      userId,
      role: 'user',
      content: '还在吗',
    });

    expect((await store.getConversation(userId, conversation.id))?.archivedAt).toBeNull();
  });

  it('does not update or delete another user\'s conversation', async () => {
    const alice = await freshUser();
    const bob = await freshUser();
    const conversation = await store.createConversation(alice, 'Alice 的对话');

    expect(await store.getConversation(bob, conversation.id)).toBeNull();
    expect(
      await store.updateConversation(bob, conversation.id, { title: '不是你的' }),
    ).toBeNull();
    expect(await store.deleteConversation(bob, conversation.id)).toBe(false);
    expect((await store.getConversation(alice, conversation.id))?.title).toBe('Alice 的对话');
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

  // ------------------------------------------------- referential integrity -----

  /**
   * The whole reason this file exists.
   *
   * A route that writes before its user row exists is indistinguishable from a
   * correct one under `InMemoryStore`, which enforces no foreign keys. Both
   * `/api/chat` and `/api/preferences` did exactly that: green across 349
   * offline tests, and a 500 the first time either met Postgres. The constraint
   * lives here, so the test that catches it has to live here too.
   */
  it('refuses a conversation for a user who does not exist, which is the bug', async () => {
    await expect(store.ensureConversation(randomUUID())).rejects.toThrow(/foreign key|violates/i);
  });

  it('a real turn creates its own user first, in the order the schema requires', async () => {
    // `runTurn` is driven with a fake runner, so this asserts the ordering of
    // the writes and nothing about the model.
    const { runTurn } = await import('../../src/service/chat.ts');
    const userId = randomUUID();
    createdUsers.push(userId);

    const events: string[] = [];
    for await (const event of runTurn(
      {
        store,
        runner: async function* () {
          yield { type: 'completed', text: '嗯。' };
        },
      },
      { userId, message: '第一次说话。' },
    )) {
      events.push(event.type);
    }

    expect(events.at(-1)).toBe('completed');
    // The user row exists as a side effect of the turn, not of the test setup —
    // `freshUser()` was deliberately not called.
    const { rows } = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
    expect(rows).toHaveLength(1);
    expect(await store.listConversations(userId)).toHaveLength(1);
  });

  // -------------------------------------------------- retention (spec §44) -----

  describe('deleting a person', () => {
    /** A user with one of everything, so the cascade has something to catch. */
    async function aPersonWithHistory(externalId: string | null = null) {
      const id = randomUUID();
      await store.ensureUser(id, externalId);
      createdUsers.push(id);

      const conversation = await store.ensureConversation(id);
      const message = await store.appendMessage({
        conversationId: conversation.id,
        userId: id,
        role: 'user',
        content: '我养了一只叫团子的猫',
      });
      await store.createMemory(id, {
        type: 'semantic',
        content: '用户养了一只叫团子的猫',
        source: 'user_stated',
      });
      await store.setPreference(id, 'tone.directness', 0.8);
      await store.saveFeedback({ messageId: message.id, userId: id, rating: 'good' });
      await store.recordRun({
        id: randomUUID(),
        userId: id,
        conversationId: conversation.id,
        model: 'deepseek-v4-pro',
        promptVersion: 'test',
        status: 'completed',
        usedTools: false,
        toolCalls: [],
        inputFingerprint: 'len=2 sha256=deadbeef',
        outputFingerprint: 'len=8 sha256=cafef00d',
        riskLevel: null,
        durationMs: 10,
        error: null,
      });

      return { id, conversationId: conversation.id };
    }

    it('takes every row that references them, in one statement', async () => {
      // The in-memory store mirrors this by hand, which is exactly why it has to
      // be checked here: a cascade is a property of the schema, and the offline
      // suite cannot see the schema.
      const { id, conversationId } = await aPersonWithHistory();

      expect(await store.deleteUser(id)).toBe(true);

      const counts = await pool.query<{ table: string; n: string }>(
        `SELECT 'conversations' AS table, count(*) AS n FROM conversations WHERE user_id = $1
         UNION ALL SELECT 'messages', count(*) FROM messages WHERE user_id = $1
         UNION ALL SELECT 'memories', count(*) FROM memories WHERE user_id = $1
         UNION ALL SELECT 'memory_events', count(*) FROM memory_events WHERE user_id = $1
         UNION ALL SELECT 'user_preferences', count(*) FROM user_preferences WHERE user_id = $1
         UNION ALL SELECT 'message_feedback', count(*) FROM message_feedback WHERE user_id = $1`,
        [id],
      );
      for (const row of counts.rows) {
        expect(row.n, `${row.table} still has rows for a deleted person`).toBe('0');
      }
      expect(await store.listMessages(id, conversationId)).toEqual([]);
    });

    it('keeps the run as an anonymous measurement', async () => {
      // The deliberate asymmetry, and the one thing that would be easy to get
      // wrong in the other direction: `agent_runs` is `ON DELETE SET NULL`.
      // Observability is sizes and hashes (spec §14), and a run whose owner has
      // been erased is still evidence about what a prompt version did.
      const { id } = await aPersonWithHistory();

      await store.deleteUser(id);

      const { rows } = await pool.query<{ user_id: string | null; conversation_id: string | null }>(
        `SELECT user_id, conversation_id FROM agent_runs WHERE user_id IS NULL AND prompt_version = 'test'`,
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.user_id).toBeNull();
        // The conversation went with the person, and the run's pointer to it is
        // nulled rather than left dangling.
        expect(row.conversation_id).toBeNull();
      }
    });

    it('reports false for a person who was never there', async () => {
      expect(await store.deleteUser(randomUUID())).toBe(false);
    });
  });

  describe('external identities', () => {
    /**
     * A namespace unique to one assertion.
     *
     * Counting assertions cannot use the real `eval:` prefix: this database
     * already holds leftovers from runs made before the sweep existed, which is
     * the gap itself. Counting those would make the suite pass or fail
     * depending on whether anyone had run an evaluation recently — the same
     * class of defect as a check that cannot fire, arriving by a different road.
     * `external_id` is `UNIQUE`, so a fresh namespace per test also keeps two
     * runs of this file from colliding.
     */
    const namespace = (): string => `eval-test-${randomUUID()}:`;

    it('records one, and a later call without one does not erase it', async () => {
      // `ensureUser` runs on every request, and only the evaluation runner
      // passes an external id. If the COALESCE were missing, the second call
      // would blank the mark and make the user un-sweepable — silently, and only
      // in the request path, which no unit test goes through.
      const id = randomUUID();
      createdUsers.push(id);
      const mark = `${namespace()}case-01`;

      await store.ensureUser(id, mark);
      await store.ensureUser(id);

      const { rows } = await pool.query<{ external_id: string }>(
        'SELECT external_id FROM users WHERE id = $1',
        [id],
      );
      expect(rows[0]?.external_id).toBe(mark);
    });

    it('matches a prefix literally, not as a LIKE pattern', async () => {
      // `starts_with`, not `LIKE $1 || '%'`. A sweep is a delete, and `%` in a
      // `LIKE` prefix widens the match to every user in the table — so the first
      // two assertions are absolute rather than relative, and hold whatever else
      // is in the database.
      const ns = namespace();
      const id = randomUUID();
      createdUsers.push(id);
      await store.ensureUser(id, `${ns}case-02`);

      expect(await store.listUsersByExternalPrefix('%'), "'%' matched as a wildcard").toEqual([]);
      expect(await store.listUsersByExternalPrefix('_val'), "'_' matched as a wildcard").toEqual([]);
      expect(await store.listUsersByExternalPrefix(ns)).toHaveLength(1);
    });

    it('does not match a prefix that is merely close', async () => {
      // `evalx:` is one character from `eval:`, and one character is the whole
      // distance between a sweep that removes throwaway users and one that
      // removes nothing it was asked to.
      const ns = namespace();
      const id = randomUUID();
      createdUsers.push(id);
      await store.ensureUser(id, `${ns}evalx:case-03`);

      expect(await store.listUsersByExternalPrefix(`${ns}eval:`)).toEqual([]);
      expect(await store.listUsersByExternalPrefix(`${ns}evalx:`)).toHaveLength(1);
    });

    it('filters by age, which is the race guard the sweep runs on', async () => {
      const ns = namespace();
      const id = randomUUID();
      createdUsers.push(id);
      await store.ensureUser(id, `${ns}case-04`);

      const future = new Date(Date.now() + 60_000);
      const past = new Date(Date.now() - 60_000);
      expect(await store.listUsersByExternalPrefix(ns, { olderThan: future })).toHaveLength(1);
      expect(await store.listUsersByExternalPrefix(ns, { olderThan: past })).toHaveLength(0);
    });
  });
});
