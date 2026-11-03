/**
 * The SQLite store, against a real database file.
 *
 * This replaces the Postgres integration file. The point is the same: the
 * in-memory store is what the behavioural suite runs against, so the only thing
 * this file can catch is the *translation* — SQL, JSON columns, booleans, date
 * strings, foreign keys and cascades. Those are exactly the places where a
 * domain type can look correct while the stored row disagrees.
 *
 * SQLite makes this suite runnable with `npm test` and no service. That is the
 * point of the switch: a database test that needs Docker is a test that gets
 * skipped by the person in a hurry.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteStore, type SqliteStore } from '../../src/db/sqlite-store.ts';
import { runTurn } from '../../src/service/chat.ts';
import { MODEL_IDS } from '../../src/config.ts';
import type { AgentRunRecord } from '../../src/memory/store.ts';

let store: SqliteStore;
let scratch: string | null = null;

beforeEach(async () => {
  store = openSqliteStore(':memory:');
});

afterEach(async () => {
  await store.close();
  if (scratch) {
    await rm(scratch, { recursive: true, force: true });
    scratch = null;
  }
});

async function freshUser(): Promise<string> {
  const id = randomUUID();
  await store.ensureUser(id);
  return id;
}

function all<T>(sql: string, ...params: (string | number | null)[]): T[] {
  return store.database.prepare(sql).all(...params) as T[];
}

function get<T>(sql: string, ...params: (string | number | null)[]): T | undefined {
  return store.database.prepare(sql).get(...params) as T | undefined;
}

describe('SqliteStore', () => {
  it('answers a ping', async () => {
    expect(await store.ping()).toBe(true);
  });

  it('opens a file, applies the schema and reports a healthy database', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'eunoia-sqlite-'));
    const path = join(scratch, 'test.sqlite');
    const fileStore = openSqliteStore(path);
    try {
      await fileStore.ensureUser(randomUUID());
      expect(await fileStore.ping()).toBe(true);
      const check = fileStore.database.prepare('PRAGMA integrity_check').get() as {
        integrity_check: string;
      };
      expect(check.integrity_check).toBe('ok');
    } finally {
      await fileStore.close();
    }
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
    expect(read).toMatchObject({
      content: '用户讨厌香菜',
      status: 'active',
      tags: ['饮食'],
      accessCount: 0,
    });
    expect(read?.importance).toBeCloseTo(0.7, 5);
    expect(read?.createdAt).toBeInstanceOf(Date);
  });

  it('keeps an explicit status', async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 5));
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

  it('counts accesses and scopes them to the owner', async () => {
    const alice = await freshUser();
    const bob = await freshUser();
    const created = await store.createMemory(alice, {
      type: 'semantic',
      content: '用户养了一只叫团子的猫',
      source: 'user_stated',
    });

    await store.markAccessed(alice, [created.id]);
    await store.markAccessed(alice, [created.id]);
    await store.markAccessed(bob, [created.id]);

    const read = await store.getMemory(alice, created.id);
    expect(read?.accessCount).toBe(2);
    expect(read?.lastAccessedAt).toBeInstanceOf(Date);
  });

  it('writes a memory event with a null memory id', async () => {
    const userId = await freshUser();
    await store.logMemoryEvent({
      memoryId: null,
      userId,
      action: 'retrieved',
      actor: 'system',
      detail: { count: 3 },
    });
    const row = get<{ action: string; actor: string; detail: string }>(
      'SELECT action, actor, detail FROM memory_events WHERE user_id = ?',
      userId,
    );
    expect(row?.action).toBe('retrieved');
    expect(JSON.parse(row?.detail ?? '{}')).toEqual({ count: 3 });
  });

  // ------------------------------------------------------- conversations -----

  it('creates a conversation, appends messages and counts turns', async () => {
    const userId = await freshUser();
    const conversation = await store.ensureConversation(userId);

    await store.appendMessage({ conversationId: conversation.id, userId, role: 'user', content: '一' });
    await store.appendMessage({ conversationId: conversation.id, userId, role: 'assistant', content: '二' });
    await store.appendMessage({ conversationId: conversation.id, userId, role: 'user', content: '三' });

    expect((await store.recentMessages(conversation.id, 2)).map((m) => m.content)).toEqual([
      '二',
      '三',
    ]);
    const listed = await store.listConversations(userId);
    expect(listed[0]?.turnCount).toBe(2);
    expect(listed[0]?.lastTurnAt).toBeInstanceOf(Date);
  });

  it('round-trips an interrupted reply without losing its flag', async () => {
    // The flag is what tells the UI, and the next turn, that this reply stops
    // mid-thought rather than being the whole answer.
    const userId = await freshUser();
    const conversation = await store.ensureConversation(userId);

    const stopped = await store.appendMessage({
      conversationId: conversation.id,
      userId,
      role: 'assistant',
      content: '听起来',
      interrupted: true,
    });
    await store.appendMessage({
      conversationId: conversation.id,
      userId,
      role: 'assistant',
      content: '完整的回复。',
    });

    const listed = await store.listMessages(userId, conversation.id);
    expect(listed.map((message) => message.interrupted)).toEqual([true, false]);
    const recent = await store.recentMessages(conversation.id, 2);
    expect(recent[0]?.id).toBe(stopped.id);
    expect(recent[0]?.interrupted).toBe(true);
  });

  it('rewinds to the last user message for a regeneration', async () => {
    const userId = await freshUser();
    const conversation = await store.ensureConversation(userId);
    await store.appendMessage({ conversationId: conversation.id, userId, role: 'user', content: '一' });
    await store.appendMessage({ conversationId: conversation.id, userId, role: 'assistant', content: '旧回复' });
    await store.appendMessage({ conversationId: conversation.id, userId, role: 'user', content: '二' });
    await store.appendMessage({
      conversationId: conversation.id,
      userId,
      role: 'assistant',
      content: '要换掉的回复',
    });

    const last = await store.lastUserMessage(userId, conversation.id);
    expect(last?.content).toBe('二');
    expect(await store.deleteMessagesAfter(userId, conversation.id, last?.seq as number)).toBe(1);

    expect((await store.listMessages(userId, conversation.id)).map((m) => m.content)).toEqual([
      '一',
      '旧回复',
      '二',
    ]);
    // The previous user turn is untouched; only the tail after the rerun point goes.
    expect((await store.lastUserMessage(userId, conversation.id))?.content).toBe('二');
  });

  it('derives history stats with numbers, not concatenated strings', async () => {
    const userId = await freshUser();
    expect(await store.historyStats(userId)).toEqual({
      conversations: 0,
      messages: 0,
      firstAt: null,
      lastAt: null,
    });

    const first = await store.ensureConversation(userId);
    await store.appendMessage({ conversationId: first.id, userId, role: 'user', content: '一' });
    const other = await store.ensureConversation(userId);
    await store.appendMessage({ conversationId: other.id, userId, role: 'assistant', content: '二' });

    const after = await store.historyStats(userId);
    expect(after.conversations).toBe(2);
    expect(after.messages).toBe(2);
    expect(after.firstAt).toBeInstanceOf(Date);
    expect(after.lastAt).toBeInstanceOf(Date);
    expect(typeof after.conversations).toBe('number');
  });

  it('reuses a conversation by id, but gives a stranger a new one', async () => {
    const alice = await freshUser();
    const bob = await freshUser();
    const first = await store.ensureConversation(alice);
    expect((await store.ensureConversation(alice, first.id)).id).toBe(first.id);

    const asBob = await store.ensureConversation(bob, first.id);
    expect(asBob.id).not.toBe(first.id);
    expect(await store.listMessages(bob, first.id)).toEqual([]);
  });

  it('names a conversation once and never replaces the name', async () => {
    const userId = await freshUser();
    const conversation = await store.ensureConversation(userId);
    await store.nameConversation(userId, conversation.id, '今天不想上班');
    await store.nameConversation(userId, conversation.id, '后来的这句话');
    expect((await store.listConversations(userId))[0]?.title).toBe('今天不想上班');
  });

  it('creates, renames, archives, restores and deletes a conversation', async () => {
    const userId = await freshUser();
    const created = await store.createConversation(userId, '面试复盘');
    expect(created.title).toBe('面试复盘');

    const renamed = await store.updateConversation(userId, created.id, {
      title: '换个名字',
      archived: true,
    });
    expect(renamed?.title).toBe('换个名字');
    expect(renamed?.archivedAt).toBeInstanceOf(Date);
    expect((await store.updateConversation(userId, created.id, { title: null }))?.title).toBeNull();

    expect((await store.listConversations(userId)).map((row) => row.id)).not.toContain(created.id);
    expect(
      (await store.listConversations(userId, { includeArchived: true })).map((row) => row.id),
    ).toContain(created.id);
    expect((await store.updateConversation(userId, created.id, { archived: false }))?.archivedAt).toBeNull();

    await store.appendMessage({ conversationId: created.id, userId, role: 'user', content: '继续' });
    expect((await store.getConversation(userId, created.id))?.turnCount).toBe(1);
    expect(await store.deleteConversation(userId, created.id)).toBe(true);
    expect(await store.getConversation(userId, created.id)).toBeNull();
    expect(await store.listMessages(userId, created.id)).toEqual([]);
  });

  it('persists a per-conversation model pin', async () => {
    const userId = await freshUser();
    const conversation = await store.createConversation(userId, '模型自检', MODEL_IDS.fast);
    expect(conversation.modelId).toBe(MODEL_IDS.fast);
    expect((await store.updateConversation(userId, conversation.id, { modelId: null }))?.modelId).toBeNull();
  });

  it('unarchives a conversation when a new message is written', async () => {
    const userId = await freshUser();
    const conversation = await store.createConversation(userId);
    await store.updateConversation(userId, conversation.id, { archived: true });
    await store.appendMessage({ conversationId: conversation.id, userId, role: 'user', content: '还在吗' });
    expect((await store.getConversation(userId, conversation.id))?.archivedAt).toBeNull();
  });

  it('assigns seq and reads messages after a boundary', async () => {
    const userId = await freshUser();
    const conversation = await store.createConversation(userId);
    const first = await store.appendMessage({ conversationId: conversation.id, userId, role: 'user', content: '一' });
    const second = await store.appendMessage({ conversationId: conversation.id, userId, role: 'assistant', content: '二' });
    const third = await store.appendMessage({ conversationId: conversation.id, userId, role: 'user', content: '三' });

    expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3]);
    expect((await store.messagesAfter(conversation.id, 1, 10)).map((m) => m.seq)).toEqual([2, 3]);
    expect((await store.recentMessages(conversation.id, 2)).map((m) => m.seq)).toEqual([2, 3]);
  });

  it('stores a rolling summary and removes it with the conversation', async () => {
    const userId = await freshUser();
    const conversation = await store.createConversation(userId);
    for (const content of ['一', '二', '三']) {
      await store.appendMessage({ conversationId: conversation.id, userId, role: 'user', content });
    }
    await store.saveSummary({
      conversationId: conversation.id,
      summary: '前三条的摘要',
      throughSeq: 2,
      summaryTokens: 8,
      model: 'deepseek-flash',
      promptVersion: 'test',
      updatedAt: new Date(),
    });
    expect(await store.getSummary(conversation.id)).toMatchObject({
      summary: '前三条的摘要',
      throughSeq: 2,
    });
    expect((await store.messagesAfter(conversation.id, 2, 10)).map((m) => m.seq)).toEqual([3]);
    await store.deleteConversation(userId, conversation.id);
    expect(await store.getSummary(conversation.id)).toBeNull();
  });

  // -------------------------------------------------- preferences, feedback --

  it('round-trips JSON preferences', async () => {
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
    const message = await store.appendMessage({ conversationId: conversation.id, userId, role: 'assistant', content: '嗯。' });
    await store.saveFeedback({ messageId: message.id, userId, rating: 'bad' });
    await store.saveFeedback({ messageId: message.id, userId, rating: 'good' });
    const listed = await store.listFeedback(userId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.rating).toBe('good');
  });

  it('records a run and its fingerprints as JSON', async () => {
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
    const row = get<{ tool_calls: string; input_fingerprint: string; used_tools: number }>(
      'SELECT tool_calls, input_fingerprint, used_tools FROM agent_runs WHERE id = ?',
      id,
    );
    expect(JSON.parse(row?.tool_calls ?? '[]')).toEqual(['search_memory']);
    expect(row?.input_fingerprint).toBe('len=6');
    expect(row?.used_tools).toBe(1);
  });

  it('upserts evaluation cases and stores results with JSON checks', async () => {
    await store.upsertEvaluationCases([
      {
        id: 'case-1',
        category: 'memory',
        title: '记住偏好',
        userMessage: '记住我喜欢下雨天',
        expectedBehaviors: ['保存偏好'],
        forbiddenBehaviors: ['编造事实'],
        checks: [{ kind: 'tool', name: 'save_memory' }],
      },
    ]);
    await store.saveEvaluationResults([
      {
        runId: randomUUID(),
        caseId: 'case-1',
        reply: '好，记住了。',
        passed: true,
        score: 1,
        promptVersion: 'test',
        model: 'deepseek-v4-pro',
        mode: 'recorded',
        violations: ['none'],
      },
    ]);

    const caseRow = get<{ expected_behaviors: string; checks: string }>(
      'SELECT expected_behaviors, checks FROM evaluation_cases WHERE id = ?',
      'case-1',
    );
    expect(JSON.parse(caseRow?.expected_behaviors ?? '[]')).toEqual(['保存偏好']);
    expect(JSON.parse(caseRow?.checks ?? '[]')).toEqual([{ kind: 'tool', name: 'save_memory' }]);

    const result = get<{ passed: number; violations: string }>(
      'SELECT passed, violations FROM evaluation_results WHERE case_id = ?',
      'case-1',
    );
    expect(result?.passed).toBe(1);
    expect(JSON.parse(result?.violations ?? '[]')).toEqual(['none']);
  });

  // ------------------------------------------------- referential integrity -----

  it('refuses a conversation for a user who does not exist', async () => {
    await expect(store.ensureConversation(randomUUID())).rejects.toThrow(/FOREIGN KEY|constraint/i);
  });

  it('a real turn creates its own user first', async () => {
    const userId = randomUUID();
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
    expect(get('SELECT id FROM users WHERE id = ?', userId)).toBeDefined();
    expect(await store.listConversations(userId)).toHaveLength(1);
  });

  // -------------------------------------------------- retention (spec §44) -----

  async function aPersonWithHistory(externalId: string | null = null) {
    const id = randomUUID();
    await store.ensureUser(id, externalId);
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
    const run: AgentRunRecord = {
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
    };
    await store.recordRun(run);
    return { id, conversationId: conversation.id };
  }

  it('deletes every row that references a person', async () => {
    const { id, conversationId } = await aPersonWithHistory();
    expect(await store.deleteUser(id)).toBe(true);

    const counts = all<{ name: string; n: number }>(
      `SELECT 'conversations' AS name, count(*) AS n FROM conversations WHERE user_id = ?
       UNION ALL SELECT 'messages', count(*) FROM messages WHERE user_id = ?
       UNION ALL SELECT 'memories', count(*) FROM memories WHERE user_id = ?
       UNION ALL SELECT 'memory_events', count(*) FROM memory_events WHERE user_id = ?
       UNION ALL SELECT 'user_preferences', count(*) FROM user_preferences WHERE user_id = ?
       UNION ALL SELECT 'message_feedback', count(*) FROM message_feedback WHERE user_id = ?`,
      id,
      id,
      id,
      id,
      id,
      id,
    );
    for (const row of counts) expect(row.n, `${row.name} still has rows`).toBe(0);
    expect(await store.listMessages(id, conversationId)).toEqual([]);
  });

  it('keeps the run as an anonymous measurement', async () => {
    const { id } = await aPersonWithHistory();
    await store.deleteUser(id);
    const rows = all<{ user_id: string | null; conversation_id: string | null }>(
      `SELECT user_id, conversation_id FROM agent_runs WHERE user_id IS NULL AND prompt_version = 'test'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.user_id).toBeNull();
      expect(row.conversation_id).toBeNull();
    }
  });

  it('reports false for a person who was never there', async () => {
    expect(await store.deleteUser(randomUUID())).toBe(false);
  });

  it('matches an external prefix literally and filters by age', async () => {
    const namespace = `eval-test-${randomUUID()}:`;
    const id = randomUUID();
    await store.ensureUser(id, `${namespace}case-01`);

    expect(await store.listUsersByExternalPrefix('%')).toEqual([]);
    expect(await store.listUsersByExternalPrefix('_val')).toEqual([]);
    expect(await store.listUsersByExternalPrefix(namespace)).toHaveLength(1);
    expect(await store.listUsersByExternalPrefix(namespace, { olderThan: new Date(Date.now() - 60_000) })).toHaveLength(0);
    expect(await store.listUsersByExternalPrefix(namespace, { olderThan: new Date(Date.now() + 60_000) })).toHaveLength(1);
  });

  it('does not erase an external id when a later ensureUser omits it', async () => {
    const id = randomUUID();
    const mark = `eval-test-${randomUUID()}:case-02`;
    await store.ensureUser(id, mark);
    await store.ensureUser(id);
    expect(get<{ external_id: string }>('SELECT external_id FROM users WHERE id = ?', id)?.external_id).toBe(mark);
  });
});

describe('schema version 7 (interrupt and continue)', () => {
  /**
   * A version-6 file: no `messages.interrupted`, and an `agent_runs.status`
   * CHECK that does not accept `'interrupted'`.
   *
   * The CHECK is the reason this migration is not a plain ALTER: SQLite cannot
   * edit one, so the table has to be rebuilt and its rows copied.
   */
  async function version6File(): Promise<string> {
    scratch = await mkdtemp(join(tmpdir(), 'eunoia-v6-'));
    const path = join(scratch, 'v6.sqlite');
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE conversations (id TEXT PRIMARY KEY, user_id TEXT);
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        token_estimate INTEGER,
        seq INTEGER NOT NULL
      );
      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        conversation_id TEXT,
        model TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
        ended_at TEXT,
        duration_ms INTEGER,
        status TEXT NOT NULL DEFAULT 'running'
          CHECK (status IN ('running', 'completed', 'failed', 'safety_replaced')),
        used_tools INTEGER NOT NULL DEFAULT 0,
        tool_calls TEXT NOT NULL DEFAULT '[]',
        input_fingerprint TEXT,
        output_fingerprint TEXT,
        risk_level TEXT,
        error TEXT
      );
      INSERT INTO users (id) VALUES ('u1');
      INSERT INTO conversations (id, user_id) VALUES ('c1', 'u1');
      INSERT INTO messages
        (id, conversation_id, user_id, role, content, created_at, seq)
      VALUES ('m1', 'c1', 'u1', 'assistant', '旧回复', '2026-01-01T00:00:00.000Z', 1);
      INSERT INTO agent_runs
        (id, user_id, conversation_id, model, prompt_version, status)
      VALUES ('r1', 'u1', 'c1', 'test-model', 'v6', 'completed');
      PRAGMA user_version = 6;
    `);
    legacy.close();
    return path;
  }

  it('adds the interrupted flag and keeps existing rows', async () => {
    const path = await version6File();
    const opened = openSqliteStore(path);
    try {
      const columns = (
        opened.database.prepare('PRAGMA table_info(messages)').all() as { name: string }[]
      ).map((column) => column.name);
      expect(columns).toContain('interrupted');

      const message = opened.database
        .prepare('SELECT content, interrupted FROM messages WHERE id = ?')
        .get('m1') as { content: string; interrupted: number } | undefined;
      expect(message).toEqual({ content: '旧回复', interrupted: 0 });
    } finally {
      await opened.close();
    }
  });

  it('widens the run status CHECK and preserves the rows it copied', async () => {
    const path = await version6File();
    const opened = openSqliteStore(path);
    try {
      const kept = opened.database
        .prepare('SELECT model, prompt_version, status FROM agent_runs WHERE id = ?')
        .get('r1') as { model: string; prompt_version: string; status: string } | undefined;
      expect(kept).toEqual({ model: 'test-model', prompt_version: 'v6', status: 'completed' });

      // The whole point of the rebuild: a stopped turn is its own status, not
      // a failure and not a completion.
      expect(() =>
        opened.database
          .prepare(
            `INSERT INTO agent_runs (id, model, prompt_version, status)
             VALUES ('r2', 'test-model', 'v7', 'interrupted')`,
          )
          .run(),
      ).not.toThrow();
    } finally {
      await opened.close();
    }
  });
});
