/**
 * The Postgres implementation of `Store` (ADR 002).
 *
 * Row mapping is confined to this file: nothing above it sees a column name, a
 * snake_case identifier, or a `pg` result. That boundary is what makes the
 * in-memory store a genuine stand-in rather than a mock — both satisfy the same
 * interface in domain types, so a behaviour proven against one is a statement
 * about the application.
 *
 * Queries are parameterised throughout; there is no string interpolation of user
 * content anywhere. The only identifiers built as text are column names in
 * `updateMemory`, and those come from a frozen allow-list rather than from input.
 */

import type { Pool, PoolClient } from 'pg';
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

/** Columns selected for a memory. `embedding` is unread until ADR 004 is undone. */
const MEMORY_COLUMNS = `
  id, user_id, type, content, importance, confidence, source, status, tags,
  superseded_by, source_message_id, created_at, updated_at, last_accessed_at, access_count
`;

interface MemoryRow {
  id: string;
  user_id: string;
  type: string;
  content: string;
  importance: number;
  confidence: number;
  source: string;
  status: string;
  tags: string[] | null;
  superseded_by: string | null;
  source_message_id: string | null;
  created_at: Date;
  updated_at: Date;
  last_accessed_at: Date | null;
  access_count: number;
}

function toMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type as MemoryType,
    content: row.content,
    // `real` columns arrive as numbers, but a numeric string would silently
    // break every comparison downstream, so coerce rather than trust.
    importance: Number(row.importance),
    confidence: Number(row.confidence),
    source: row.source as MemorySource,
    status: row.status as MemoryStatus,
    tags: row.tags ?? [],
    supersededBy: row.superseded_by,
    sourceMessageId: row.source_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAccessedAt: row.last_accessed_at,
    accessCount: Number(row.access_count),
  };
}

interface MessageRow {
  id: string;
  conversation_id: string;
  user_id: string;
  role: string;
  content: string;
  created_at: Date;
  seq: string | number;
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    userId: row.user_id,
    role: row.role as Message['role'],
    content: row.content,
    createdAt: row.created_at,
    seq: Number(row.seq),
  };
}

interface ConversationRow {
  id: string;
  user_id: string;
  title: string | null;
  started_at: Date;
  last_turn_at: Date | null;
  turn_count: number;
  archived_at: Date | null;
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    startedAt: row.started_at,
    lastTurnAt: row.last_turn_at,
    turnCount: Number(row.turn_count),
    archivedAt: row.archived_at,
  };
}

interface ConversationSummaryRow {
  conversation_id: string;
  summary: string;
  through_seq: string | number;
  summary_tokens: number;
  model: string;
  prompt_version: string;
  updated_at: Date;
}

function toSummary(row: ConversationSummaryRow): ConversationSummary {
  return {
    conversationId: row.conversation_id,
    summary: row.summary,
    throughSeq: Number(row.through_seq),
    summaryTokens: Number(row.summary_tokens),
    model: row.model,
    promptVersion: row.prompt_version,
    updatedAt: row.updated_at,
  };
}

/** Maps a patch field to its column. The allow-list, not the caller, decides. */
const UPDATABLE_COLUMNS: Readonly<Record<keyof MemoryPatch, string>> = {
  content: 'content',
  importance: 'importance',
  confidence: 'confidence',
  status: 'status',
  tags: 'tags',
};

export class PostgresStore implements Store {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  // --------------------------------------------------------------- users -----

  async ensureUser(userId: string, externalId?: string | null): Promise<void> {
    await this.#pool.query(
      `INSERT INTO users (id, external_id) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET
         -- COALESCE, so a later call without an external id does not erase one
         -- an earlier call supplied. The id is the identity; the external id is
         -- a note about where it came from, and losing it silently would make
         -- a user un-sweepable.
         external_id = COALESCE(EXCLUDED.external_id, users.external_id),
         updated_at  = now()`,
      [userId, externalId ?? null],
    );
  }

  async deleteUser(userId: string): Promise<boolean> {
    // One statement. Cascades do the rest, and `agent_runs` nulls its `user_id`
    // rather than going with them — see the interface for why the measurement
    // outlives the person.
    const { rowCount } = await this.#pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    return (rowCount ?? 0) > 0;
  }

  async listUsersByExternalPrefix(
    prefix: string,
    options: { olderThan?: Date; limit?: number } = {},
  ): Promise<{ id: string; externalId: string }[]> {
    // `starts_with`, not `LIKE $1 || '%'`: in `LIKE` a `%` or `_` inside the
    // prefix is a wildcard, so a caller passing one would widen the match. This
    // is the query a delete runs off, which makes "matches more than it was
    // asked to" the one bug here worth being paranoid about.
    const { rows } = await this.#pool.query<{ id: string; external_id: string }>(
      `SELECT id, external_id FROM users
        WHERE starts_with(external_id, $1)
          AND ($2::timestamptz IS NULL OR created_at < $2)
        ORDER BY created_at
        LIMIT $3`,
      [prefix, options.olderThan ?? null, options.limit ?? 1000],
    );
    return rows.map((row) => ({ id: row.id, externalId: row.external_id }));
  }

  // ------------------------------------------------------------ memories -----

  async createMemory(userId: string, draft: MemoryDraft): Promise<Memory> {
    const { rows } = await this.#pool.query<MemoryRow>(
      `INSERT INTO memories
         (user_id, type, content, importance, confidence, source, status, tags, source_message_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${MEMORY_COLUMNS}`,
      [
        userId,
        draft.type,
        draft.content,
        draft.importance ?? 0.5,
        draft.confidence ?? 0.5,
        draft.source,
        draft.status ?? 'active',
        [...(draft.tags ?? [])],
        draft.sourceMessageId ?? null,
      ],
    );

    const row = rows[0];
    if (!row) throw new Error('INSERT ... RETURNING produced no row');
    return toMemory(row);
  }

  async getMemory(userId: string, id: string): Promise<Memory | null> {
    const { rows } = await this.#pool.query<MemoryRow>(
      `SELECT ${MEMORY_COLUMNS} FROM memories WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    return rows[0] ? toMemory(rows[0]) : null;
  }

  async updateMemory(userId: string, id: string, patch: MemoryPatch): Promise<Memory | null> {
    const assignments: string[] = [];
    const values: unknown[] = [id, userId];

    for (const [field, column] of Object.entries(UPDATABLE_COLUMNS)) {
      const value = patch[field as keyof MemoryPatch];
      if (value === undefined) continue;
      values.push(field === 'tags' ? [...(value as readonly string[])] : value);
      assignments.push(`${column} = $${values.length}`);
    }

    if (assignments.length === 0) return this.getMemory(userId, id);

    assignments.push('updated_at = now()');

    const { rows } = await this.#pool.query<MemoryRow>(
      `UPDATE memories SET ${assignments.join(', ')}
       WHERE id = $1 AND user_id = $2
       RETURNING ${MEMORY_COLUMNS}`,
      values,
    );
    return rows[0] ? toMemory(rows[0]) : null;
  }

  async deleteMemory(userId: string, id: string): Promise<boolean> {
    // Soft delete. `memory_events` references this row, and `superseded_by` may
    // point at it; removing it would strand both.
    const updated = await this.updateMemory(userId, id, { status: 'deleted' });
    return updated !== null;
  }

  async listMemories(userId: string, options: MemoryListOptions = {}): Promise<Memory[]> {
    const conditions = ['user_id = $1'];
    const values: unknown[] = [userId];

    if (options.types && options.types.length > 0) {
      values.push([...options.types]);
      conditions.push(`type = ANY($${values.length})`);
    }
    if (options.statuses && options.statuses.length > 0) {
      values.push([...options.statuses]);
      conditions.push(`status = ANY($${values.length})`);
    }

    let sql = `SELECT ${MEMORY_COLUMNS} FROM memories WHERE ${conditions.join(' AND ')}
               ORDER BY updated_at DESC`;
    if (options.limit !== undefined) {
      values.push(options.limit);
      sql += ` LIMIT $${values.length}`;
    }

    const { rows } = await this.#pool.query<MemoryRow>(sql, values);
    return rows.map(toMemory);
  }

  async markAccessed(userId: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.#pool.query(
      `UPDATE memories
          SET access_count = access_count + 1, last_accessed_at = now()
        WHERE user_id = $1 AND id = ANY($2)`,
      [userId, [...ids]],
    );
  }

  async logMemoryEvent(event: MemoryEvent): Promise<void> {
    await this.#pool.query(
      `INSERT INTO memory_events (memory_id, user_id, action, actor, reason, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        event.memoryId,
        event.userId,
        event.action,
        event.actor,
        event.reason ?? null,
        JSON.stringify(event.detail ?? {}),
      ],
    );
  }

  // ------------------------------------------------------- conversations -----

  async createConversation(userId: string, title?: string | null): Promise<Conversation> {
    const { rows } = await this.#pool.query<ConversationRow>(
      `INSERT INTO conversations (user_id, title)
       VALUES ($1, $2)
       RETURNING id, user_id, title, started_at, last_turn_at, turn_count, archived_at`,
      [userId, title ?? null],
    );
    const row = rows[0];
    if (!row) throw new Error('conversation insert produced no row');
    return toConversation(row);
  }

  async getConversation(userId: string, conversationId: string): Promise<Conversation | null> {
    const { rows } = await this.#pool.query<ConversationRow>(
      `SELECT id, user_id, title, started_at, last_turn_at, turn_count, archived_at
         FROM conversations WHERE id = $1 AND user_id = $2`,
      [conversationId, userId],
    );
    return rows[0] ? toConversation(rows[0]) : null;
  }

  async updateConversation(
    userId: string,
    conversationId: string,
    patch: ConversationPatch,
  ): Promise<Conversation | null> {
    const values: unknown[] = [conversationId, userId];
    const sets: string[] = [];

    if (patch.title !== undefined) {
      values.push(patch.title);
      sets.push(`title = $${values.length}`);
    }
    if (patch.archived !== undefined) {
      sets.push(patch.archived ? 'archived_at = now()' : 'archived_at = NULL');
    }
    if (sets.length === 0) return this.getConversation(userId, conversationId);

    const { rows } = await this.#pool.query<ConversationRow>(
      `UPDATE conversations SET ${sets.join(', ')}
        WHERE id = $1 AND user_id = $2
        RETURNING id, user_id, title, started_at, last_turn_at, turn_count, archived_at`,
      values,
    );
    return rows[0] ? toConversation(rows[0]) : null;
  }

  async deleteConversation(userId: string, conversationId: string): Promise<boolean> {
    const result = await this.#pool.query(
      `DELETE FROM conversations WHERE id = $1 AND user_id = $2`,
      [conversationId, userId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async ensureConversation(userId: string, conversationId?: string | null): Promise<Conversation> {
    if (conversationId) {
      const existing = await this.#pool.query<ConversationRow>(
        `SELECT id, user_id, title, started_at, last_turn_at, turn_count, archived_at
           FROM conversations WHERE id = $1 AND user_id = $2`,
        [conversationId, userId],
      );
      if (existing.rows[0]) return toConversation(existing.rows[0]);
    }

    const { rows } = await this.#pool.query<ConversationRow>(
      `INSERT INTO conversations (user_id, id)
       VALUES ($1, COALESCE($2::uuid, gen_random_uuid()))
       ON CONFLICT (id) DO NOTHING
       RETURNING id, user_id, title, started_at, last_turn_at, turn_count, archived_at`,
      [userId, conversationId ?? null],
    );
    if (rows[0]) return toConversation(rows[0]);

    /**
     * The requested id exists but is not this user's.
     *
     * A plain insert here raised a duplicate-key error, which surfaced as a 500
     * on an ordinary situation: a client holding a stale conversation id, or one
     * copied from somewhere else. The turn does not need to fail, and it must not
     * succeed by handing over someone else's thread — so this user gets a new
     * conversation, which is what the client is told to continue with.
     */
    const fresh = await this.#pool.query<ConversationRow>(
      `INSERT INTO conversations (user_id) VALUES ($1)
       RETURNING id, user_id, title, started_at, last_turn_at, turn_count, archived_at`,
      [userId],
    );

    const row = fresh.rows[0];
    if (!row) throw new Error('conversation insert produced no row');
    return toConversation(row);
  }

  async nameConversation(userId: string, conversationId: string, title: string): Promise<void> {
    await this.#pool.query(
      `UPDATE conversations SET title = $3
        WHERE id = $1 AND user_id = $2 AND title IS NULL`,
      [conversationId, userId, title],
    );
  }

  async appendMessage(message: {
    conversationId: string;
    userId: string;
    role: Message['role'];
    content: string;
  }): Promise<Message> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');

      // Lock and verify ownership before writing. The two foreign keys alone do
      // not say that this message belongs to *this* conversation's owner, so a
      // store caller with a mismatched pair used to be able to write a message
      // under one person into another person's thread.
      const owned = await client.query(
        `SELECT 1 FROM conversations WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [message.conversationId, message.userId],
      );
      if (!owned.rows[0]) {
        throw new Error(`unknown conversation ${message.conversationId} for this user`);
      }

      // The conversation row is locked above, so this max is safe even under
      // concurrent appends to the same conversation.
      const sequence = await client.query<{ next_seq: string }>(
        `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
           FROM messages WHERE conversation_id = $1`,
        [message.conversationId],
      );
      const seq = Number(sequence.rows[0]?.next_seq ?? 1);

      const { rows } = await client.query<MessageRow>(
        `INSERT INTO messages (conversation_id, user_id, role, content, token_estimate, seq)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, conversation_id, user_id, role, content, created_at, seq`,
        [
          message.conversationId,
          message.userId,
          message.role,
          message.content,
          Math.ceil(message.content.length / 4),
          seq,
        ],
      );

      await client.query(
        `UPDATE conversations
            SET last_turn_at = now(),
                -- A reply in an archived thread is a resume, not a new message
                -- in a hidden one. Unarchive it so the list and the transcript
                -- cannot disagree about whether it is active.
                archived_at = NULL,
                turn_count = turn_count + CASE WHEN $2 = 'user' THEN 1 ELSE 0 END
          WHERE id = $1`,
        [message.conversationId, message.role],
      );

      await client.query('COMMIT');
      const row = rows[0];
      if (!row) throw new Error('message insert produced no row');
      return toMessage(row);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async recentMessages(conversationId: string, limit: number): Promise<Message[]> {
    // Newest-first with a LIMIT, then reversed, so the database reads the tail
    // of the conversation rather than the whole thing.
    const { rows } = await this.#pool.query<MessageRow>(
      `SELECT id, conversation_id, user_id, role, content, created_at, seq
         FROM messages WHERE conversation_id = $1
        ORDER BY seq DESC
        LIMIT $2`,
      [conversationId, limit],
    );
    return rows.reverse().map(toMessage);
  }

  async messagesAfter(
    conversationId: string,
    afterSeq: number,
    limit: number,
  ): Promise<Message[]> {
    const { rows } = await this.#pool.query<MessageRow>(
      `SELECT id, conversation_id, user_id, role, content, created_at, seq
         FROM messages
        WHERE conversation_id = $1 AND seq > $2
        ORDER BY seq ASC
        LIMIT $3`,
      [conversationId, afterSeq, limit],
    );
    return rows.map(toMessage);
  }

  async getSummary(conversationId: string): Promise<ConversationSummary | null> {
    const { rows } = await this.#pool.query<ConversationSummaryRow>(
      `SELECT conversation_id, summary, through_seq, summary_tokens,
              model, prompt_version, updated_at
         FROM conversation_summaries
        WHERE conversation_id = $1`,
      [conversationId],
    );
    return rows[0] ? toSummary(rows[0]) : null;
  }

  async saveSummary(summary: ConversationSummary): Promise<void> {
    await this.#pool.query(
      `INSERT INTO conversation_summaries
         (conversation_id, summary, through_seq, summary_tokens, model, prompt_version, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (conversation_id) DO UPDATE SET
         summary = EXCLUDED.summary,
         through_seq = EXCLUDED.through_seq,
         summary_tokens = EXCLUDED.summary_tokens,
         model = EXCLUDED.model,
         prompt_version = EXCLUDED.prompt_version,
         updated_at = EXCLUDED.updated_at`,
      [
        summary.conversationId,
        summary.summary,
        summary.throughSeq,
        summary.summaryTokens,
        summary.model,
        summary.promptVersion,
        summary.updatedAt,
      ],
    );
  }

  async listConversations(
    userId: string,
    options: ConversationListOptions = {},
  ): Promise<Conversation[]> {
    const limit = options.limit ?? 30;
    const archivedFilter = options.includeArchived ? '' : 'AND archived_at IS NULL';
    const { rows } = await this.#pool.query<ConversationRow>(
      `SELECT id, user_id, title, started_at, last_turn_at, turn_count, archived_at
         FROM conversations
        WHERE user_id = $1 ${archivedFilter}
        ORDER BY (archived_at IS NOT NULL) ASC,
                 last_turn_at DESC NULLS LAST,
                 started_at DESC
        LIMIT $2`,
      [userId, limit],
    );
    return rows.map(toConversation);
  }

  async listMessages(userId: string, conversationId: string, limit = 200): Promise<Message[]> {
    const { rows } = await this.#pool.query<MessageRow>(
      `SELECT m.id, m.conversation_id, m.user_id, m.role, m.content, m.created_at, m.seq
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE m.conversation_id = $1 AND c.user_id = $2
        ORDER BY m.seq ASC
        LIMIT $3`,
      [conversationId, userId, limit],
    );
    return rows.map(toMessage);
  }

  async historyStats(userId: string): Promise<HistoryStats> {
    // Four scalar subqueries in one round trip, rather than four queries or a
    // join that would multiply the counts against each other.
    const { rows } = await this.#pool.query<{
      conversations: string;
      messages: string;
      first_at: Date | null;
      last_at: Date | null;
    }>(
      `SELECT (SELECT count(*) FROM conversations WHERE user_id = $1) AS conversations,
              (SELECT count(*) FROM messages      WHERE user_id = $1) AS messages,
              (SELECT min(started_at) FROM conversations WHERE user_id = $1) AS first_at,
              (SELECT max(created_at) FROM messages      WHERE user_id = $1) AS last_at`,
      [userId],
    );

    const row = rows[0];
    // `count(*)` comes back as a string: Postgres bigint does not fit a JS
    // number, so the driver hands over the text rather than silently rounding.
    return {
      conversations: Number(row?.conversations ?? 0),
      messages: Number(row?.messages ?? 0),
      firstAt: row?.first_at ?? null,
      lastAt: row?.last_at ?? null,
    };
  }

  // ---------------------------------------------------------------- runs -----

  async recordRun(run: AgentRunRecord): Promise<void> {
    await this.#pool.query(
      `INSERT INTO agent_runs
         (id, user_id, conversation_id, model, prompt_version, status, used_tools,
          tool_calls, input_fingerprint, output_fingerprint, risk_level, duration_ms, error, ended_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
               CASE WHEN $6 = 'running' THEN NULL ELSE now() END)`,
      [
        run.id,
        run.userId,
        run.conversationId,
        run.model,
        run.promptVersion,
        run.status,
        run.usedTools,
        JSON.stringify(run.toolCalls),
        run.inputFingerprint,
        run.outputFingerprint,
        run.riskLevel,
        run.durationMs,
        run.error,
      ],
    );
  }

  async finishRun(
    id: string,
    patch: Partial<Omit<AgentRunRecord, 'id' | 'userId' | 'conversationId' | 'model' | 'promptVersion'>>,
  ): Promise<void> {
    const assignments: string[] = ['ended_at = now()'];
    const values: unknown[] = [id];

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
      values.push(field === 'toolCalls' ? JSON.stringify(value) : value);
      assignments.push(`${column} = $${values.length}`);
    }

    await this.#pool.query(`UPDATE agent_runs SET ${assignments.join(', ')} WHERE id = $1`, values);
  }

  async upsertEvaluationCases(cases: readonly EvaluationCaseRecord[]): Promise<void> {
    if (cases.length === 0) return;

    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      for (const entry of cases) {
        await client.query(
          `INSERT INTO evaluation_cases
             (id, category, title, user_message, expected_behaviors, forbidden_behaviors, checks)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (id) DO UPDATE SET
             category = EXCLUDED.category,
             title = EXCLUDED.title,
             user_message = EXCLUDED.user_message,
             expected_behaviors = EXCLUDED.expected_behaviors,
             forbidden_behaviors = EXCLUDED.forbidden_behaviors,
             checks = EXCLUDED.checks,
             updated_at = now()`,
          [
            entry.id,
            entry.category,
            entry.title,
            entry.userMessage,
            [...entry.expectedBehaviors],
            [...entry.forbiddenBehaviors],
            JSON.stringify(entry.checks),
          ],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async saveEvaluationResults(results: readonly EvaluationResultRecord[]): Promise<void> {
    if (results.length === 0) return;

    const client: PoolClient = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      for (const result of results) {
        await client.query(
          `INSERT INTO evaluation_results
             (run_id, case_id, reply, passed, score, prompt_version, model, mode, violations)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            result.runId,
            result.caseId,
            result.reply,
            result.passed,
            result.score,
            result.promptVersion,
            result.model,
            result.mode,
            JSON.stringify(result.violations),
          ],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // --------------------------------------------------------- preferences -----

  async getPreference(userId: string, key: string): Promise<unknown | null> {
    const { rows } = await this.#pool.query<{ value: unknown }>(
      'SELECT value FROM user_preferences WHERE user_id = $1 AND key = $2',
      [userId, key],
    );
    return rows[0]?.value ?? null;
  }

  async setPreference(userId: string, key: string, value: unknown): Promise<void> {
    await this.#pool.query(
      `INSERT INTO user_preferences (user_id, key, value) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [userId, key, JSON.stringify(value)],
    );
  }

  async listPreferences(userId: string): Promise<Record<string, unknown>> {
    const { rows } = await this.#pool.query<{ key: string; value: unknown }>(
      'SELECT key, value FROM user_preferences WHERE user_id = $1',
      [userId],
    );
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  // ------------------------------------------------------------ feedback -----

  async saveFeedback(feedback: {
    messageId: string;
    userId: string;
    rating: 'good' | 'bad';
    note?: string | null;
  }): Promise<void> {
    await this.#pool.query(
      `INSERT INTO message_feedback (message_id, user_id, rating, note)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (message_id, user_id)
       DO UPDATE SET rating = EXCLUDED.rating, note = EXCLUDED.note, created_at = now()`,
      [feedback.messageId, feedback.userId, feedback.rating, feedback.note ?? null],
    );
  }

  async listFeedback(userId: string, limit = 100): Promise<FeedbackRecord[]> {
    const { rows } = await this.#pool.query<{
      message_id: string;
      user_id: string;
      rating: string;
      note: string | null;
      created_at: Date;
    }>(
      `SELECT message_id, user_id, rating, note, created_at
         FROM message_feedback WHERE user_id = $1
        ORDER BY created_at DESC LIMIT $2`,
      [userId, limit],
    );
    return rows.map((row) => ({
      messageId: row.message_id,
      userId: row.user_id,
      rating: row.rating as 'good' | 'bad',
      note: row.note,
      createdAt: row.created_at,
    }));
  }

  // ------------------------------------------------------------ plumbing -----

  async ping(): Promise<boolean> {
    try {
      await this.#pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
