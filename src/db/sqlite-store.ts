/**
 * The SQLite implementation of `Store` (ADR 016).
 *
 * This is the store the product now runs on. It replaces the Postgres + Docker
 * stack for a reason that is not "SQLite is trendy": this is a single-user app
 * on one machine, and the previous store required a container, a password, a
 * migration runner and a 837-line driver for data that fits comfortably in one
 * file. The `Store` interface did not change, so memory, session, tools,
 * evaluation and privacy all kept working against the same domain types.
 *
 * Row mapping stays here. Above this file there are no column names, no
 * snake_case fields, no JSON strings and no `?` placeholders — only the
 * interfaces in `src/memory/store.ts` and `src/session/store.ts`.
 *
 * ## Date, JSON and boolean representation
 *
 * SQLite has no native date, JSON or boolean types. Timestamps are ISO-8601
 * TEXT (UTC), JSON is TEXT, booleans are INTEGER 0/1. All three are converted at
 * this boundary so nothing above needs to know.
 *
 * ## Transactions
 *
 * The mutating sequences that must be atomic — appending a message (seq + row +
 * conversation counters), evaluation ingestion, run completion — use
 * `BEGIN IMMEDIATE`. The synchronous driver plus WAL makes that sufficient for
 * the one process this app runs.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AgentRunRecord,
  EvaluationCaseRecord,
  EvaluationResultRecord,
  FeedbackRecord,
  MemoryListOptions,
} from '../memory/store.ts';
import type {
  Memory,
  MemoryDraft,
  MemoryEvent,
  MemoryPatch,
  MemorySource,
  MemoryStatus,
  MemoryType,
} from '../memory/types.ts';
import type { ConversationListOptions, ConversationPatch } from '../session/store.ts';
import type {
  Conversation,
  ConversationSummary,
  HistoryStats,
  Message,
} from '../session/types.ts';
import type { Store } from '../store.ts';
import {
  SQLITE_MIGRATION_3,
  SQLITE_SCHEMA,
  SQLITE_SCHEMA_VERSION,
} from './sqlite-schema.ts';
import { PERMISSION_SCHEMA } from '../sandbox/schema.ts';

type SqlValue = string | number | null;

interface MemoryRow {
  id: string;
  user_id: string;
  type: string;
  content: string;
  importance: number;
  confidence: number;
  source: string;
  status: string;
  tags: string;
  superseded_by: string | null;
  source_message_id: string | null;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
  access_count: number;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  user_id: string;
  role: string;
  content: string;
  created_at: string;
  seq: number;
}

interface ConversationRow {
  id: string;
  user_id: string;
  title: string | null;
  started_at: string;
  last_turn_at: string | null;
  turn_count: number;
  archived_at: string | null;
  model_id: string | null;
}

interface SummaryRow {
  conversation_id: string;
  summary: string;
  through_seq: number;
  summary_tokens: number;
  model: string;
  prompt_version: string;
  updated_at: string;
}

interface FeedbackRow {
  message_id: string;
  user_id: string;
  rating: string;
  note: string | null;
  created_at: string;
}

const MEMORY_COLUMNS = `
  id, user_id, type, content, importance, confidence, source, status, tags,
  superseded_by, source_message_id, created_at, updated_at, last_accessed_at, access_count
`;

const MESSAGE_COLUMNS = `id, conversation_id, user_id, role, content, created_at, seq`;

const CONVERSATION_COLUMNS =
  'id, user_id, title, started_at, last_turn_at, turn_count, archived_at, model_id';

const UPDATABLE_COLUMNS: Readonly<Record<keyof MemoryPatch, string>> = {
  content: 'content',
  importance: 'importance',
  confidence: 'confidence',
  status: 'status',
  tags: 'tags',
};

export class SqliteStore implements Store {
  /**
   * The raw connection, for tests and diagnostics.
   *
   * Not part of `Store`: application code goes through the interface. The
   * integration test uses it to assert schema properties — cascades, JSON
   * columns — that a domain method cannot expose.
   */
  readonly database: DatabaseSync;
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.database = db;
    this.#db = db;
  }

  // --------------------------------------------------------------- users -----

  async ensureUser(userId: string, externalId?: string | null): Promise<void> {
    this.#run(
      `INSERT INTO users (id, external_id, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         external_id = COALESCE(excluded.external_id, users.external_id),
         updated_at = excluded.updated_at`,
      userId,
      externalId ?? null,
      nowIso(),
    );
  }

  async deleteUser(userId: string): Promise<boolean> {
    // Foreign keys do the cascade. `agent_runs` is SET NULL on purpose: the
    // measurement outlives the person.
    return this.#run('DELETE FROM users WHERE id = ?', userId).changes > 0;
  }

  async listUsersByExternalPrefix(
    prefix: string,
    options: { olderThan?: Date; limit?: number } = {},
  ): Promise<{ id: string; externalId: string }[]> {
    // `substr`, not `LIKE`: a `%` or `_` in the prefix must not become a
    // wildcard. This is the query a deletion sweep runs off.
    const cutoff = options.olderThan?.toISOString() ?? null;
    const rows = this.#all<{ id: string; external_id: string }>(
      `SELECT id, external_id FROM users
        WHERE external_id IS NOT NULL
          AND substr(external_id, 1, ?) = ?
          AND (? IS NULL OR created_at < ?)
        ORDER BY created_at
        LIMIT ?`,
      prefix.length,
      prefix,
      cutoff,
      cutoff,
      options.limit ?? 1000,
    );
    return rows.map((row) => ({ id: row.id, externalId: row.external_id }));
  }

  // ------------------------------------------------------------ memories -----

  async createMemory(userId: string, draft: MemoryDraft): Promise<Memory> {
    const id = randomUUID();
    this.#run(
      `INSERT INTO memories
         (id, user_id, type, content, importance, confidence, source, status, tags,
          source_message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      userId,
      draft.type,
      draft.content,
      draft.importance ?? 0.5,
      draft.confidence ?? 0.5,
      draft.source,
      draft.status ?? 'active',
      JSON.stringify([...(draft.tags ?? [])]),
      draft.sourceMessageId ?? null,
    );

    const row = this.#get<MemoryRow>(
      `SELECT ${MEMORY_COLUMNS} FROM memories WHERE id = ? AND user_id = ?`,
      id,
      userId,
    );
    if (!row) throw new Error('memory insert produced no row');
    return toMemory(row);
  }

  async getMemory(userId: string, id: string): Promise<Memory | null> {
    const row = this.#get<MemoryRow>(
      `SELECT ${MEMORY_COLUMNS} FROM memories WHERE id = ? AND user_id = ?`,
      id,
      userId,
    );
    return row ? toMemory(row) : null;
  }

  async updateMemory(userId: string, id: string, patch: MemoryPatch): Promise<Memory | null> {
    const assignments: string[] = [];
    const values: SqlValue[] = [];

    for (const [field, column] of Object.entries(UPDATABLE_COLUMNS)) {
      const value = patch[field as keyof MemoryPatch];
      if (value === undefined) continue;
      values.push(field === 'tags' ? JSON.stringify([...(value as readonly string[])]) : (value as SqlValue));
      assignments.push(`${column} = ?`);
    }

    if (assignments.length === 0) return this.getMemory(userId, id);

    assignments.push('updated_at = ?');
    values.push(nowIso(), id, userId);
    this.#run(
      `UPDATE memories SET ${assignments.join(', ')} WHERE id = ? AND user_id = ?`,
      ...values,
    );
    return this.getMemory(userId, id);
  }

  async deleteMemory(userId: string, id: string): Promise<boolean> {
    // Soft delete: memory_events and superseded_by still point at this row.
    const updated = await this.updateMemory(userId, id, { status: 'deleted' });
    return updated !== null;
  }

  async listMemories(userId: string, options: MemoryListOptions = {}): Promise<Memory[]> {
    const conditions = ['user_id = ?'];
    const values: SqlValue[] = [userId];

    if (options.types && options.types.length > 0) {
      conditions.push(`type IN (${placeholders(options.types.length)})`);
      values.push(...options.types);
    }
    if (options.statuses && options.statuses.length > 0) {
      conditions.push(`status IN (${placeholders(options.statuses.length)})`);
      values.push(...options.statuses);
    }

    let sql = `SELECT ${MEMORY_COLUMNS} FROM memories WHERE ${conditions.join(' AND ')}
               ORDER BY updated_at DESC`;
    if (options.limit !== undefined) {
      sql += ' LIMIT ?';
      values.push(options.limit);
    }
    return this.#all<MemoryRow>(sql, ...values).map(toMemory);
  }

  async markAccessed(userId: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    this.#run(
      `UPDATE memories
          SET access_count = access_count + 1, last_accessed_at = ?
        WHERE user_id = ? AND id IN (${placeholders(ids.length)})`,
      nowIso(),
      userId,
      ...ids,
    );
  }

  async logMemoryEvent(event: MemoryEvent): Promise<void> {
    this.#run(
      `INSERT INTO memory_events (memory_id, user_id, action, actor, reason, detail)
       VALUES (?, ?, ?, ?, ?, ?)`,
      event.memoryId,
      event.userId,
      event.action,
      event.actor,
      event.reason ?? null,
      JSON.stringify(event.detail ?? {}),
    );
  }

  // ------------------------------------------------------- conversations -----

  async createConversation(
    userId: string,
    title?: string | null,
    modelId?: string | null,
  ): Promise<Conversation> {
    const id = randomUUID();
    this.#run(
      'INSERT INTO conversations (id, user_id, title, model_id) VALUES (?, ?, ?, ?)',
      id,
      userId,
      title ?? null,
      modelId ?? null,
    );
    const conversation = await this.getConversation(userId, id);
    if (!conversation) throw new Error('conversation insert produced no row');
    return conversation;
  }

  async getConversation(userId: string, conversationId: string): Promise<Conversation | null> {
    const row = this.#get<ConversationRow>(
      `SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE id = ? AND user_id = ?`,
      conversationId,
      userId,
    );
    return row ? toConversation(row) : null;
  }

  async updateConversation(
    userId: string,
    conversationId: string,
    patch: ConversationPatch,
  ): Promise<Conversation | null> {
    const sets: string[] = [];
    const values: SqlValue[] = [];

    if (patch.title !== undefined) {
      sets.push('title = ?');
      values.push(patch.title);
    }
    if (patch.archived !== undefined) {
      sets.push('archived_at = ?');
      values.push(patch.archived ? nowIso() : null);
    }
    if (patch.modelId !== undefined) {
      sets.push('model_id = ?');
      values.push(patch.modelId);
    }
    if (sets.length === 0) return this.getConversation(userId, conversationId);

    values.push(conversationId, userId);
    this.#run(
      `UPDATE conversations SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`,
      ...values,
    );
    return this.getConversation(userId, conversationId);
  }

  async deleteConversation(userId: string, conversationId: string): Promise<boolean> {
    return (
      this.#run('DELETE FROM conversations WHERE id = ? AND user_id = ?', conversationId, userId)
        .changes > 0
    );
  }

  async ensureConversation(userId: string, conversationId?: string | null): Promise<Conversation> {
    if (conversationId) {
      const existing = await this.getConversation(userId, conversationId);
      if (existing) return existing;
    }

    const requested = conversationId ?? randomUUID();
    const inserted = this.#run(
      `INSERT INTO conversations (id, user_id) VALUES (?, ?)
       ON CONFLICT (id) DO NOTHING`,
      requested,
      userId,
    );
    if (inserted.changes > 0) {
      const conversation = await this.getConversation(userId, requested);
      if (conversation) return conversation;
    }

    // The requested id exists but belongs to someone else. A stale or copied
    // client id must not hand over another person's thread, and it must not fail
    // an ordinary turn either: this user gets a fresh conversation.
    const fresh = randomUUID();
    this.#run('INSERT INTO conversations (id, user_id) VALUES (?, ?)', fresh, userId);
    const conversation = await this.getConversation(userId, fresh);
    if (!conversation) throw new Error('conversation insert produced no row');
    return conversation;
  }

  async nameConversation(userId: string, conversationId: string, title: string): Promise<void> {
    this.#run(
      'UPDATE conversations SET title = ? WHERE id = ? AND user_id = ? AND title IS NULL',
      title,
      conversationId,
      userId,
    );
  }

  async appendMessage(message: {
    conversationId: string;
    userId: string;
    role: Message['role'];
    content: string;
  }): Promise<Message> {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const owned = this.#get<{ one: number }>(
        'SELECT 1 AS one FROM conversations WHERE id = ? AND user_id = ?',
        message.conversationId,
        message.userId,
      );
      if (!owned) throw new Error(`unknown conversation ${message.conversationId} for this user`);

      const sequence = this.#get<{ next_seq: number }>(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM messages WHERE conversation_id = ?',
        message.conversationId,
      );
      const seq = Number(sequence?.next_seq ?? 1);
      const id = randomUUID();
      const now = nowIso();

      this.#run(
        `INSERT INTO messages
           (id, conversation_id, user_id, role, content, token_estimate, seq, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        message.conversationId,
        message.userId,
        message.role,
        message.content,
        Math.ceil(message.content.length / 4),
        seq,
        now,
      );

      this.#run(
        `UPDATE conversations
            SET last_turn_at = ?, archived_at = NULL,
                turn_count = turn_count + ?
          WHERE id = ?`,
        now,
        message.role === 'user' ? 1 : 0,
        message.conversationId,
      );

      const row = this.#get<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`,
        id,
      );
      if (!row) throw new Error('message insert produced no row');
      this.#db.exec('COMMIT');
      return toMessage(row);
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  async recentMessages(conversationId: string, limit: number): Promise<Message[]> {
    const rows = this.#all<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE conversation_id = ?
        ORDER BY seq DESC LIMIT ?`,
      conversationId,
      limit,
    );
    return rows.reverse().map(toMessage);
  }

  async messagesAfter(
    conversationId: string,
    afterSeq: number,
    limit: number,
  ): Promise<Message[]> {
    return this.#all<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages
        WHERE conversation_id = ? AND seq > ?
        ORDER BY seq ASC LIMIT ?`,
      conversationId,
      afterSeq,
      limit,
    ).map(toMessage);
  }

  async getSummary(conversationId: string): Promise<ConversationSummary | null> {
    const row = this.#get<SummaryRow>(
      `SELECT conversation_id, summary, through_seq, summary_tokens,
              model, prompt_version, updated_at
         FROM conversation_summaries WHERE conversation_id = ?`,
      conversationId,
    );
    return row ? toSummary(row) : null;
  }

  async saveSummary(summary: ConversationSummary): Promise<void> {
    this.#run(
      `INSERT INTO conversation_summaries
         (conversation_id, summary, through_seq, summary_tokens, model, prompt_version, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (conversation_id) DO UPDATE SET
         summary = excluded.summary,
         through_seq = excluded.through_seq,
         summary_tokens = excluded.summary_tokens,
         model = excluded.model,
         prompt_version = excluded.prompt_version,
         updated_at = excluded.updated_at`,
      summary.conversationId,
      summary.summary,
      summary.throughSeq,
      summary.summaryTokens,
      summary.model,
      summary.promptVersion,
      summary.updatedAt.toISOString(),
    );
  }

  async listConversations(
    userId: string,
    options: ConversationListOptions = {},
  ): Promise<Conversation[]> {
    const limit = options.limit ?? 30;
    const archivedFilter = options.includeArchived ? '' : 'AND archived_at IS NULL';
    return this.#all<ConversationRow>(
      `SELECT ${CONVERSATION_COLUMNS} FROM conversations
        WHERE user_id = ? ${archivedFilter}
        ORDER BY (archived_at IS NOT NULL) ASC,
                 (last_turn_at IS NULL) ASC,
                 last_turn_at DESC,
                 started_at DESC
        LIMIT ?`,
      userId,
      limit,
    ).map(toConversation);
  }

  async listMessages(userId: string, conversationId: string, limit = 200): Promise<Message[]> {
    return this.#all<MessageRow>(
      `SELECT m.id, m.conversation_id, m.user_id, m.role, m.content, m.created_at, m.seq
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE m.conversation_id = ? AND c.user_id = ?
        ORDER BY m.seq ASC
        LIMIT ?`,
      conversationId,
      userId,
      limit,
    ).map(toMessage);
  }

  async historyStats(userId: string): Promise<HistoryStats> {
    const row = this.#get<{
      conversations: number;
      messages: number;
      first_at: string | null;
      last_at: string | null;
    }>(
      `SELECT (SELECT count(*) FROM conversations WHERE user_id = ?) AS conversations,
              (SELECT count(*) FROM messages      WHERE user_id = ?) AS messages,
              (SELECT min(started_at) FROM conversations WHERE user_id = ?) AS first_at,
              (SELECT max(created_at) FROM messages      WHERE user_id = ?) AS last_at`,
      userId,
      userId,
      userId,
      userId,
    );
    return {
      conversations: Number(row?.conversations ?? 0),
      messages: Number(row?.messages ?? 0),
      firstAt: row?.first_at ? new Date(row.first_at) : null,
      lastAt: row?.last_at ? new Date(row.last_at) : null,
    };
  }

  // ---------------------------------------------------------------- runs -----

  async recordRun(run: AgentRunRecord): Promise<void> {
    this.#run(
      `INSERT INTO agent_runs
         (id, user_id, conversation_id, model, prompt_version, status, used_tools,
          tool_calls, input_fingerprint, output_fingerprint, risk_level, duration_ms, error, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      run.id,
      run.userId,
      run.conversationId,
      run.model,
      run.promptVersion,
      run.status,
      run.usedTools ? 1 : 0,
      JSON.stringify(run.toolCalls),
      run.inputFingerprint,
      run.outputFingerprint,
      run.riskLevel,
      run.durationMs,
      run.error,
      run.status === 'running' ? null : nowIso(),
    );
  }

  async finishRun(
    id: string,
    patch: Partial<Omit<AgentRunRecord, 'id' | 'userId' | 'conversationId' | 'model' | 'promptVersion'>>,
  ): Promise<void> {
    const assignments: string[] = ['ended_at = ?'];
    const values: SqlValue[] = [nowIso()];

    const fields: [keyof typeof patch, string][] = [
      ['status', 'status'],
      ['usedTools', 'used_tools'],
      ['toolCalls', 'tool_calls'],
      ['outputFingerprint', 'output_fingerprint'],
      ['riskLevel', 'risk_level'],
      ['durationMs', 'duration_ms'],
      ['error', 'error'],
    ];

    for (const [field, column] of fields) {
      const value = patch[field];
      if (value === undefined) continue;
      if (field === 'toolCalls') values.push(JSON.stringify(value));
      else if (field === 'usedTools') values.push(value ? 1 : 0);
      else values.push(value as SqlValue);
      assignments.push(`${column} = ?`);
    }

    values.push(id);
    this.#run(`UPDATE agent_runs SET ${assignments.join(', ')} WHERE id = ?`, ...values);
  }

  async upsertEvaluationCases(cases: readonly EvaluationCaseRecord[]): Promise<void> {
    if (cases.length === 0) return;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      for (const entry of cases) {
        this.#run(
          `INSERT INTO evaluation_cases
             (id, category, title, user_message, expected_behaviors, forbidden_behaviors, checks, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             category = excluded.category,
             title = excluded.title,
             user_message = excluded.user_message,
             expected_behaviors = excluded.expected_behaviors,
             forbidden_behaviors = excluded.forbidden_behaviors,
             checks = excluded.checks,
             updated_at = excluded.updated_at`,
          entry.id,
          entry.category,
          entry.title,
          entry.userMessage,
          JSON.stringify([...entry.expectedBehaviors]),
          JSON.stringify([...entry.forbiddenBehaviors]),
          JSON.stringify(entry.checks),
          nowIso(),
        );
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  async saveEvaluationResults(results: readonly EvaluationResultRecord[]): Promise<void> {
    if (results.length === 0) return;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      for (const result of results) {
        this.#run(
          `INSERT INTO evaluation_results
             (run_id, case_id, reply, passed, score, prompt_version, model, mode, violations)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          result.runId,
          result.caseId,
          result.reply,
          result.passed ? 1 : 0,
          result.score,
          result.promptVersion,
          result.model,
          result.mode,
          JSON.stringify(result.violations),
        );
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  // --------------------------------------------------------- preferences -----

  async getPreference(userId: string, key: string): Promise<unknown | null> {
    const row = this.#get<{ value: string }>(
      'SELECT value FROM user_preferences WHERE user_id = ? AND key = ?',
      userId,
      key,
    );
    return row ? parseJson(row.value, null) : null;
  }

  async setPreference(userId: string, key: string, value: unknown): Promise<void> {
    this.#run(
      `INSERT INTO user_preferences (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, key) DO UPDATE SET
         value = excluded.value, updated_at = excluded.updated_at`,
      userId,
      key,
      JSON.stringify(value),
      nowIso(),
    );
  }

  async listPreferences(userId: string): Promise<Record<string, unknown>> {
    const rows = this.#all<{ key: string; value: string }>(
      'SELECT key, value FROM user_preferences WHERE user_id = ?',
      userId,
    );
    const out: Record<string, unknown> = {};
    for (const row of rows) out[row.key] = parseJson(row.value, null);
    return out;
  }

  // ------------------------------------------------------------ feedback -----

  async saveFeedback(feedback: {
    messageId: string;
    userId: string;
    rating: 'good' | 'bad';
    note?: string | null;
  }): Promise<void> {
    this.#run(
      `INSERT INTO message_feedback (message_id, user_id, rating, note, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (message_id, user_id) DO UPDATE SET
         rating = excluded.rating, note = excluded.note, created_at = excluded.created_at`,
      feedback.messageId,
      feedback.userId,
      feedback.rating,
      feedback.note ?? null,
      nowIso(),
    );
  }

  async listFeedback(userId: string, limit = 100): Promise<FeedbackRecord[]> {
    return this.#all<FeedbackRow>(
      `SELECT message_id, user_id, rating, note, created_at
         FROM message_feedback WHERE user_id = ?
        ORDER BY created_at DESC LIMIT ?`,
      userId,
      limit,
    ).map(toFeedback);
  }

  // ------------------------------------------------------------ plumbing -----

  async ping(): Promise<boolean> {
    try {
      this.#db.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.#db.close();
  }

  // ------------------------------------------------------------ internals ----

  #all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.#db.prepare(sql).all(...params) as T[];
  }

  #get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.#db.prepare(sql).get(...params) as T | undefined;
  }

  #run(sql: string, ...params: SqlValue[]): { changes: number } {
    const result = this.#db.prepare(sql).run(...params);
    return { changes: Number(result.changes) };
  }
}

/** Open (and, on first use, initialise) a SQLite store. */
export function openSqliteStore(path: string): SqliteStore {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

  const version = Number(
    (db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version ??
      0,
  );
  if (version > SQLITE_SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `database schema version ${version} is newer than this build (${SQLITE_SCHEMA_VERSION})`,
    );
  }
  if (version < 2) {
    // Version 1 has no sandbox tables; the full schema creates them (including
    // the version-3/4 columns and tables) without touching existing rows.
    db.exec(SQLITE_SCHEMA);
  } else {
    const sandboxColumns = db.prepare('PRAGMA table_info(sandboxes)').all() as { name: string }[];
    if (version < 3 && !sandboxColumns.some((column) => column.name === 'resource_profile')) {
      db.exec(SQLITE_MIGRATION_3);
    }
    if (version < 4) {
      migrateToVersion4(db);
    }
  }
  if (version < SQLITE_SCHEMA_VERSION) {
    db.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
  }
  return new SqliteStore(db);
}

// ------------------------------------------------------------------ mapping ---

function toMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type as MemoryType,
    content: row.content,
    importance: Number(row.importance),
    confidence: Number(row.confidence),
    source: row.source as MemorySource,
    status: row.status as MemoryStatus,
    tags: parseJson<string[]>(row.tags, []).filter((tag): tag is string => typeof tag === 'string'),
    supersededBy: row.superseded_by,
    sourceMessageId: row.source_message_id,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    lastAccessedAt: row.last_accessed_at ? new Date(row.last_accessed_at) : null,
    accessCount: Number(row.access_count),
  };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    userId: row.user_id,
    role: row.role as Message['role'],
    content: row.content,
    createdAt: new Date(row.created_at),
    seq: Number(row.seq),
  };
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    startedAt: new Date(row.started_at),
    lastTurnAt: row.last_turn_at ? new Date(row.last_turn_at) : null,
    turnCount: Number(row.turn_count),
    archivedAt: row.archived_at ? new Date(row.archived_at) : null,
    modelId: row.model_id,
  };
}

function toSummary(row: SummaryRow): ConversationSummary {
  return {
    conversationId: row.conversation_id,
    summary: row.summary,
    throughSeq: Number(row.through_seq),
    summaryTokens: Number(row.summary_tokens),
    model: row.model,
    promptVersion: row.prompt_version,
    updatedAt: new Date(row.updated_at),
  };
}

function toFeedback(row: FeedbackRow): FeedbackRecord {
  return {
    messageId: row.message_id,
    userId: row.user_id,
    rating: row.rating as 'good' | 'bad',
    note: row.note,
    createdAt: new Date(row.created_at),
  };
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function nowIso(): string {
  return new Date().toISOString();
}


/**
 * Version 3 → 4.
 *
 * Written as code rather than one SQL string because `ALTER TABLE … ADD COLUMN`
 * is not idempotent in SQLite: a file that crashed halfway through the migration
 * would fail on the second run with "duplicate column name". Each column is
 * checked before it is added, so a partially migrated database converges.
 */
function migrateToVersion4(db: DatabaseSync): void {
  db.exec(PERMISSION_SCHEMA);
  const columns: readonly { table: string; column: string; ddl: string }[] = [
    { table: 'sandboxes', column: 'config_digest', ddl: "TEXT NOT NULL DEFAULT ''" },
    { table: 'sandbox_approvals', column: 'grant_id', ddl: 'TEXT' },
    { table: 'sandbox_approvals', column: 'organization_id', ddl: 'TEXT' },
    { table: 'sandbox_approvals', column: 'project_id', ddl: 'TEXT' },
    { table: 'sandbox_approvals', column: 'session_id', ddl: 'TEXT' },
    { table: 'sandbox_approvals', column: 'sandbox_id', ddl: 'TEXT' },
    { table: 'sandbox_approvals', column: 'principal_id', ddl: 'TEXT' },
    { table: 'sandbox_approvals', column: 'source', ddl: "TEXT NOT NULL DEFAULT 'human_approval'" },
    { table: 'sandbox_approvals', column: 'status', ddl: "TEXT NOT NULL DEFAULT 'active'" },
    { table: 'sandbox_approvals', column: 'scope_level', ddl: "TEXT NOT NULL DEFAULT 'task'" },
    { table: 'sandbox_approvals', column: 'request_id', ddl: 'TEXT' },
    { table: 'sandbox_approvals', column: 'approval_request_id', ddl: 'TEXT' },
    { table: 'sandbox_approvals', column: 'used_at', ddl: 'TEXT' },
    { table: 'executions', column: 'decision_id', ddl: 'TEXT' },
    { table: 'executions', column: 'permission_mode', ddl: 'TEXT' },
    { table: 'executions', column: 'permission_policy_version', ddl: 'TEXT' },
  ];
  for (const entry of columns) {
    if (hasColumn(db, entry.table, entry.column)) continue;
    db.exec(`ALTER TABLE ${entry.table} ADD COLUMN ${entry.column} ${entry.ddl}`);
  }
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((row) => row.name === column);
}
