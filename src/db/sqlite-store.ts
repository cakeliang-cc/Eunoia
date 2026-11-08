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
import type { CreateTurnResult, TurnStore } from '../session/turn-store.ts';
import type {
  NewTurnEvent,
  TurnEventRecord,
  TurnFinishPatch,
  TurnRecord,
} from '../session/turn-types.ts';
import type { Store } from '../store.ts';
import type { WebDocumentRecord } from '../web/store.ts';
import type { QuestionSchema, QuestionStatus, UserQuestionRecord } from '../questions/types.ts';
import type { DevJobRecord, JobStatus } from '../processes/types.ts';
import type {
  ChangesetFileRecord,
  ChangesetStatus,
  NewChangesetInput,
  WorkspaceChangesetRecord,
  WorkspaceChangesetSummary,
} from '../session/changeset.ts';
import type { UserContentV1 } from '../agent/content.ts';
import { contentText } from '../agent/content.ts';
import type { ImageAsset, ImageMediaType, MediaAssetStatus } from '../media/types.ts';
import type { MediaAssetStore } from '../media/store.ts';
import {
  SQLITE_MIGRATION_3,
  SQLITE_MIGRATION_6,
  SQLITE_MIGRATION_8,
  SQLITE_MIGRATION_9,
  SQLITE_MIGRATION_10,
  SQLITE_MIGRATION_11,
  SQLITE_MIGRATION_13,
  SQLITE_MIGRATION_14,
  SQLITE_SCHEMA,
  SQLITE_SCHEMA_VERSION,
} from './sqlite-schema.ts';
import { CWD_SCHEMA, PERMISSION_SCHEMA } from '../sandbox/schema.ts';
import { StatementCache } from './statements.ts';
import type {
  CreateEpochInput,
  ModelTranscriptStore,
  PrepareStepInput,
  PrepareStepResult,
  StepPatch,
} from '../session/model-transcript-store.ts';
import { TranscriptRevisionConflictError } from '../session/model-transcript-store.ts';
import type {
  ModelContextState,
  ModelEpoch,
  ModelItem,
  ModelStepRecord,
  NewModelContextState,
  NewModelItem,
  RequestProjection,
  StepUsage,
} from '../session/model-transcript.ts';
import {
  itemContentHash,
  MODEL_TRANSCRIPT_VERSION,
  TRANSCRIPT_RENDER_VERSION,
} from '../session/model-transcript.ts';

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
  content_parts: string | null;
  interrupted: number;
  created_at: string;
  seq: number;
}

interface MediaAssetRow {
  id: string;
  user_id: string;
  conversation_id: string;
  name: string;
  media_type: string;
  bytes: number;
  width: number;
  height: number;
  sha256: string;
  storage_key: string;
  normalized_key: string;
  normalized_width: number;
  normalized_height: number;
  normalized_bytes: number;
  normalized_sha256: string;
  request_key: string;
  request_width: number;
  request_height: number;
  request_bytes: number;
  request_sha256: string;
  processor_version: string;
  policy_revision: string;
  status: string;
  lease_expires_at: string | null;
  created_at: string;
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

interface ModelEpochRow {
  id: string;
  user_id: string;
  conversation_id: string;
  parent_epoch_id: string | null;
  reason: string;
  instructions: string;
  prompt_version: string;
  tools: string;
  tools_hash: string;
  provider_id: string;
  model_id: string;
  protocol_revision: string;
  encoder_revision: string;
  window_item_ids: string;
  window_revision: number;
  seeded_through_seq: number;
  active: number;
  created_at: string;
  ended_at: string | null;
}

interface ModelItemRow {
  id: string;
  conversation_id: string;
  epoch_id: string;
  seq: number;
  idempotency_key: string;
  request_id: string | null;
  turn_id: string | null;
  step: number | null;
  kind: string;
  source: string;
  scope: string;
  content_version: string;
  payload: string;
  content_hash: string;
  message_id: string | null;
  call_id: string | null;
  status: string;
  created_at: string;
}

interface ModelStepRow {
  attempt_id: string;
  request_id: string;
  turn_id: string;
  conversation_id: string;
  step: number;
  attempt_no: number;
  epoch_id: string;
  epoch_revision: number;
  input_item_ids: string;
  output_item_ids: string;
  request_config_digest: string;
  projection: string | null;
  status: string;
  response_id: string | null;
  usage: string | null;
  error: string | null;
  finish_reason: string | null;
  created_at: string;
  completed_at: string | null;
}

interface ModelContextStateRow {
  conversation_id: string;
  epoch_id: string;
  key: string;
  scope: string;
  content_hash: string;
  render_version: string;
  revision: number;
  latest_item_id: string;
  cleared: number;
  updated_at: string;
}

interface TurnRow {
  id: string;
  turn_id: string;
  user_id: string;
  conversation_id: string;
  request_hash: string;
  status: string;
  finish_reason: string | null;
  reply: string;
  message_id: string | null;
  error: string | null;
  model: string | null;
  steps: number;
  context_tokens: number | null;
  accepted: number | null;
  acceptance: string;
  usage: string | null;
  turn_usage: string | null;
  started_at: string;
  ended_at: string | null;
}

interface TurnEventRow {
  id: number;
  turn_id: string;
  conversation_id: string;
  seq: number;
  kind: string;
  call_id: string | null;
  tool_name: string | null;
  status: string;
  execution_id: string | null;
  payload: string;
  created_at: string;
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

const MESSAGE_COLUMNS = `id, conversation_id, user_id, role, content, content_parts,
  interrupted, created_at, seq`;

const MEDIA_COLUMNS = `id, user_id, conversation_id, name, media_type, bytes, width, height,
  sha256, storage_key, normalized_key, normalized_width, normalized_height, normalized_bytes,
  normalized_sha256, request_key, request_width, request_height, request_bytes, request_sha256,
  processor_version, policy_revision, status, lease_expires_at, created_at`;

const TURN_COLUMNS = `id, turn_id, user_id, conversation_id, request_hash, status, finish_reason,
  reply, message_id, error, model, steps, context_tokens, accepted, acceptance, usage,
  turn_usage, started_at, ended_at`;

const TURN_EVENT_COLUMNS = `id, turn_id, conversation_id, seq, kind, call_id, tool_name,
  status, execution_id, payload, created_at`;

const CONVERSATION_COLUMNS =
  'id, user_id, title, started_at, last_turn_at, turn_count, archived_at, model_id';

const UPDATABLE_COLUMNS: Readonly<Record<keyof MemoryPatch, string>> = {
  content: 'content',
  importance: 'importance',
  confidence: 'confidence',
  status: 'status',
  tags: 'tags',
};

export class SqliteStore implements Store, TurnStore, MediaAssetStore, ModelTranscriptStore {
  /**
   * The raw connection, for tests and diagnostics.
   *
   * Not part of `Store`: application code goes through the interface. The
   * integration test uses it to assert schema properties — cascades, JSON
   * columns — that a domain method cannot expose.
   */
  readonly database: DatabaseSync;
  readonly #db: DatabaseSync;
  readonly #statements: StatementCache;

  constructor(db: DatabaseSync) {
    this.database = db;
    this.#db = db;
    this.#statements = new StatementCache(db);
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

  async recordRetrieval(input: {
    userId: string;
    memoryIds: readonly string[];
    event: MemoryEvent;
  }): Promise<void> {
    // One transaction for the access counters and the audit row. Retrieval runs
    // on every turn, and two independent commits meant two WAL fsyncs per turn
    // for data nothing in the reply depends on.
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      if (input.memoryIds.length > 0) {
        this.#run(
          `UPDATE memories
              SET access_count = access_count + 1, last_accessed_at = ?
            WHERE user_id = ? AND id IN (${placeholders(input.memoryIds.length)})`,
          nowIso(),
          input.userId,
          ...input.memoryIds,
        );
      }
      this.#run(
        `INSERT INTO memory_events (memory_id, user_id, action, actor, reason, detail)
         VALUES (?, ?, ?, ?, ?, ?)`,
        input.event.memoryId,
        input.event.userId,
        input.event.action,
        input.event.actor,
        input.event.reason ?? null,
        JSON.stringify(input.event.detail ?? {}),
      );
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
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
    interrupted?: boolean;
    /** The structured fact. When present the text projection is derived here. */
    contentParts?: UserContentV1 | null;
    /** Image references to bind in the same transaction, in content order. */
    assetIds?: readonly string[];
  }): Promise<Message> {
    if (message.contentParts && message.contentParts.version !== 1) {
      throw new Error(`unsupported content version ${String(message.contentParts.version)}`);
    }
    // The projection has one source when structured content exists. A caller
    // cannot pass a different `content` and have both stored.
    const projection = message.contentParts ? contentText(message.contentParts) : message.content;
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
           (id, conversation_id, user_id, role, content, content_parts, token_estimate,
            seq, created_at, interrupted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        message.conversationId,
        message.userId,
        message.role,
        projection,
        message.contentParts ? JSON.stringify(message.contentParts) : null,
        Math.ceil(projection.length / 4),
        seq,
        now,
        message.interrupted === true ? 1 : 0,
      );

      // Bound in the same transaction as the message. A partial write cannot
      // leave a message whose images are still drafts (or a draft marked bound
      // to a message that was rolled back).
      this.#bindMessageAssets(
        message.userId,
        message.conversationId,
        id,
        message.role === 'user' ? (message.assetIds ?? []) : [],
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

  async lastUserMessage(userId: string, conversationId: string): Promise<Message | null> {
    const row = this.#get<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages
        WHERE conversation_id = ? AND user_id = ? AND role = 'user'
        ORDER BY seq DESC LIMIT 1`,
      conversationId,
      userId,
    );
    return row ? toMessage(row) : null;
  }

  async deleteMessagesAfter(
    userId: string,
    conversationId: string,
    seq: number,
  ): Promise<number> {
    const result = this.#run(
      `DELETE FROM messages
        WHERE conversation_id = ? AND user_id = ? AND seq > ?`,
      conversationId,
      userId,
      seq,
    );
    if (result.changes > 0) {
      this.#run(
        `UPDATE conversations SET last_turn_at = ? WHERE id = ? AND user_id = ?`,
        nowIso(),
        conversationId,
        userId,
      );
      await this.releaseUnreferencedAssets(conversationId);
    }
    return result.changes;
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
      `SELECT m.id, m.conversation_id, m.user_id, m.role, m.content, m.content_parts,
              m.interrupted, m.created_at, m.seq
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
          tool_calls, input_fingerprint, output_fingerprint, risk_level, duration_ms,
          finish_reason, error, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      run.finishReason ?? null,
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
      ['finishReason', 'finish_reason'],
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


  // --------------------------------------------------------------- media -----

  async createMediaAsset(asset: ImageAsset): Promise<void> {
    this.#run(
      `INSERT INTO media_assets
         (id, user_id, conversation_id, name, media_type, bytes, width, height, sha256,
          storage_key, normalized_key, normalized_width, normalized_height, normalized_bytes,
          normalized_sha256, request_key, request_width, request_height, request_bytes,
          request_sha256, processor_version, policy_revision, status, lease_expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      asset.id,
      asset.userId,
      asset.conversationId,
      asset.name,
      asset.mediaType,
      asset.bytes,
      asset.width,
      asset.height,
      asset.sha256,
      asset.storageKey,
      asset.normalized.key,
      asset.normalized.width,
      asset.normalized.height,
      asset.normalized.bytes,
      asset.normalized.sha256,
      asset.request.key,
      asset.request.width,
      asset.request.height,
      asset.request.bytes,
      asset.request.sha256,
      asset.normalized.processorVersion,
      asset.normalized.policyRevision,
      asset.status,
      asset.leaseExpiresAt ? asset.leaseExpiresAt.toISOString() : null,
      asset.createdAt.toISOString(),
    );
  }

  async getMediaAsset(userId: string, assetId: string): Promise<ImageAsset | null> {
    const row = this.#get<MediaAssetRow>(
      `SELECT ${MEDIA_COLUMNS} FROM media_assets WHERE id = ? AND user_id = ?`,
      assetId,
      userId,
    );
    return row ? toMediaAsset(row) : null;
  }

  async listMediaAssets(userId: string, assetIds: readonly string[]): Promise<ImageAsset[]> {
    if (assetIds.length === 0) return [];
    const placeholders = assetIds.map(() => '?').join(', ');
    return this.#all<MediaAssetRow>(
      `SELECT ${MEDIA_COLUMNS} FROM media_assets WHERE user_id = ? AND id IN (${placeholders})`,
      userId,
      ...assetIds,
    ).map(toMediaAsset);
  }

  async listConversationMedia(userId: string, conversationId: string): Promise<ImageAsset[]> {
    return this.#all<MediaAssetRow>(
      `SELECT ${MEDIA_COLUMNS} FROM media_assets
        WHERE user_id = ? AND conversation_id = ? ORDER BY created_at ASC`,
      userId,
      conversationId,
    ).map(toMediaAsset);
  }

  async listUserMedia(userId: string): Promise<ImageAsset[]> {
    return this.#all<MediaAssetRow>(
      `SELECT ${MEDIA_COLUMNS} FROM media_assets WHERE user_id = ? ORDER BY created_at ASC`,
      userId,
    ).map(toMediaAsset);
  }

  async messageAssetIds(messageId: string): Promise<string[]> {
    return this.#all<{ asset_id: string }>(
      'SELECT asset_id FROM message_assets WHERE message_id = ? ORDER BY position ASC',
      messageId,
    ).map((row) => row.asset_id);
  }

  async setMediaLease(
    userId: string,
    assetIds: readonly string[],
    until: Date | null,
  ): Promise<void> {
    if (assetIds.length === 0) return;
    const placeholders = assetIds.map(() => '?').join(', ');
    this.#run(
      `UPDATE media_assets SET lease_expires_at = ?
        WHERE user_id = ? AND id IN (${placeholders})`,
      until ? until.toISOString() : null,
      userId,
      ...assetIds,
    );
  }

  async deletePendingMediaAsset(
    userId: string,
    assetId: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    const result = this.#run(
      `DELETE FROM media_assets
        WHERE id = ? AND user_id = ? AND status = 'pending'
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
          AND NOT EXISTS (SELECT 1 FROM message_assets WHERE asset_id = ?)
          AND NOT EXISTS (SELECT 1 FROM model_items AS mi
                           WHERE mi.conversation_id = media_assets.conversation_id
                             AND mi.payload LIKE '%' || media_assets.id || '%')`,
      assetId,
      userId,
      now.toISOString(),
      assetId,
    );
    return result.changes > 0;
  }

  async bindMediaAsset(userId: string, assetId: string): Promise<void> {
    this.#run(
      `UPDATE media_assets SET status = 'bound', lease_expires_at = NULL
        WHERE user_id = ? AND id = ? AND status = 'pending'`,
      userId,
      assetId,
    );
  }

  async deleteMediaAssets(assetIds: readonly string[]): Promise<void> {
    if (assetIds.length === 0) return;
    const placeholders = assetIds.map(() => '?').join(', ');
    this.#run(`DELETE FROM media_assets WHERE id IN (${placeholders})`, ...assetIds);
  }

  async listCollectableMedia(now: Date, graceMs: number): Promise<ImageAsset[]> {
    const cutoff = new Date(now.getTime() - graceMs).toISOString();
    return this.#all<MediaAssetRow>(
      `SELECT ${MEDIA_COLUMNS} FROM media_assets AS a
        WHERE a.created_at <= ?
          AND (a.lease_expires_at IS NULL OR a.lease_expires_at <= ?)
          AND (
            a.status = 'released'
            OR (a.status = 'pending'
                AND NOT EXISTS (SELECT 1 FROM message_assets AS r WHERE r.asset_id = a.id)
                AND NOT EXISTS (SELECT 1 FROM model_items AS mi
                                 WHERE mi.conversation_id = a.conversation_id
                                   AND mi.payload LIKE '%' || a.id || '%'))
          )
        ORDER BY a.created_at ASC`,
      cutoff,
      now.toISOString(),
    ).map(toMediaAsset);
  }

  async releaseUnreferencedAssets(conversationId: string): Promise<void> {
    this.#run(
      `UPDATE media_assets SET status = 'released', lease_expires_at = NULL
        WHERE conversation_id = ? AND status = 'bound'
          AND NOT EXISTS (SELECT 1 FROM message_assets AS r WHERE r.asset_id = media_assets.id)
          AND NOT EXISTS (SELECT 1 FROM model_items AS mi
                           WHERE mi.conversation_id = media_assets.conversation_id
                             AND mi.payload LIKE '%' || media_assets.id || '%')`,
      conversationId,
    );
  }

  #bindMessageAssets(
    userId: string,
    conversationId: string,
    messageId: string,
    assetIds: readonly string[],
  ): void {
    for (const [position, assetId] of assetIds.entries()) {
      const row = this.#get<{ user_id: string; conversation_id: string; status: string }>(
        'SELECT user_id, conversation_id, status FROM media_assets WHERE id = ?',
        assetId,
      );
      if (
        !row ||
        row.user_id !== userId ||
        row.conversation_id !== conversationId ||
        row.status === 'released'
      ) {
        throw new Error(`media asset ${assetId} is not available to this conversation`);
      }
      this.#run(
        `INSERT INTO message_assets (message_id, asset_id, conversation_id, position)
         VALUES (?, ?, ?, ?)`,
        messageId,
        assetId,
        conversationId,
        position,
      );
      this.#run(`UPDATE media_assets SET status = 'bound' WHERE id = ?`, assetId);
    }
  }

  // --------------------------------------------------------------- turns -----

  async createTurn(record: TurnRecord): Promise<CreateTurnResult> {
    try {
      const inserted = this.#run(
        `INSERT INTO turn_requests
           (id, turn_id, user_id, conversation_id, request_hash, status, finish_reason,
            reply, message_id, error, model, steps, context_tokens, accepted, acceptance,
            usage, turn_usage, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
        record.id,
        record.turnId,
        record.userId,
        record.conversationId,
        record.requestHash,
        record.status,
        record.finishReason,
        record.reply,
        record.messageId,
        record.error,
        record.model,
        record.steps,
        record.contextTokens,
        record.accepted === null ? null : record.accepted ? 1 : 0,
        JSON.stringify(record.acceptance),
        record.usage ? JSON.stringify(record.usage) : null,
        record.turnUsage ? JSON.stringify(record.turnUsage) : null,
        record.startedAt.toISOString(),
        record.endedAt ? record.endedAt.toISOString() : null,
      );
      return inserted.changes > 0 ? 'created' : 'exists';
    } catch (error) {
      // The partial unique index on (conversation_id) WHERE status = 'running'
      // is the lock. Its violation is the 409, not an internal error.
      if (isUniqueViolation(error)) return 'busy';
      throw error;
    }
  }

  async getTurn(id: string): Promise<TurnRecord | null> {
    // A brand-new database may be opened by a process running an older build of
    // this migration; without the table, "no turn" is the truthful answer rather
    // than a crash on the chat path.
    if (!hasTable(this.#db, 'turn_requests')) return null;
    const row = this.#get<TurnRow>(`SELECT ${TURN_COLUMNS} FROM turn_requests WHERE id = ?`, id);
    return row ? toTurn(row) : null;
  }

  async activeTurn(conversationId: string): Promise<TurnRecord | null> {
    if (!hasTable(this.#db, 'turn_requests')) return null;
    const row = this.#get<TurnRow>(
      `SELECT ${TURN_COLUMNS} FROM turn_requests
        WHERE conversation_id = ? AND status = 'running'
        ORDER BY started_at DESC LIMIT 1`,
      conversationId,
    );
    return row ? toTurn(row) : null;
  }

  async finishTurn(id: string, patch: TurnFinishPatch): Promise<TurnRecord | null> {
    if (!hasTable(this.#db, 'turn_requests')) return null;
    const assignments: string[] = ['status = ?', 'finish_reason = ?', 'ended_at = ?'];
    const values: SqlValue[] = [patch.status, patch.finishReason, nowIso()];

    const fields: [keyof TurnFinishPatch, string][] = [
      ['reply', 'reply'],
      ['messageId', 'message_id'],
      ['error', 'error'],
      ['steps', 'steps'],
      ['contextTokens', 'context_tokens'],
    ];
    for (const [field, column] of fields) {
      const value = patch[field];
      if (value === undefined) continue;
      values.push(value as SqlValue);
      assignments.push(`${column} = ?`);
    }
    if (patch.accepted !== undefined) {
      values.push(patch.accepted ? 1 : 0);
      assignments.push('accepted = ?');
    }
    if (patch.acceptance !== undefined) {
      values.push(JSON.stringify(patch.acceptance));
      assignments.push('acceptance = ?');
    }
    if (patch.usage !== undefined) {
      values.push(patch.usage === null ? null : JSON.stringify(patch.usage));
      assignments.push('usage = ?');
    }
    if (patch.turnUsage !== undefined) {
      values.push(patch.turnUsage === null ? null : JSON.stringify(patch.turnUsage));
      assignments.push('turn_usage = ?');
    }

    values.push(id);
    // `status = 'running'` is the guard: a finished turn is never rewritten, so
    // a late finish after recovery is a no-op rather than a second outcome.
    this.#run(
      `UPDATE turn_requests SET ${assignments.join(', ')} WHERE id = ? AND status = 'running'`,
      ...values,
    );
    return this.getTurn(id);
  }

  async listRunningTurns(): Promise<TurnRecord[]> {
    if (!hasTable(this.#db, 'turn_requests')) return [];
    return this.#all<TurnRow>(
      `SELECT ${TURN_COLUMNS} FROM turn_requests WHERE status = 'running' ORDER BY started_at ASC`,
    ).map(toTurn);
  }

  async appendTurnEvent(event: NewTurnEvent): Promise<TurnEventRecord> {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const next = this.#get<{ next_seq: number }>(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM turn_events WHERE turn_id = ?',
        event.turnId,
      );
      const seq = Number(next?.next_seq ?? 1);
      this.#run(
        `INSERT INTO turn_events
           (turn_id, conversation_id, seq, kind, call_id, tool_name, status, execution_id, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        event.turnId,
        event.conversationId,
        seq,
        event.kind,
        event.callId ?? null,
        event.toolName ?? null,
        event.status,
        event.executionId ?? null,
        JSON.stringify(event.payload ?? {}),
      );
      const row = this.#get<TurnEventRow>(
        `SELECT ${TURN_EVENT_COLUMNS} FROM turn_events WHERE turn_id = ? AND seq = ?`,
        event.turnId,
        seq,
      );
      if (!row) throw new Error('turn event insert produced no row');
      this.#db.exec('COMMIT');
      return toTurnEvent(row);
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  async listTurnEvents(turnId: string): Promise<TurnEventRecord[]> {
    if (!hasTable(this.#db, 'turn_events')) return [];
    return this.#all<TurnEventRow>(
      `SELECT ${TURN_EVENT_COLUMNS} FROM turn_events WHERE turn_id = ? ORDER BY seq ASC`,
      turnId,
    ).map(toTurnEvent);
  }

  async listConversationTurnEvents(
    conversationId: string,
    options: { readonly before?: Date; readonly limit?: number } = {},
  ): Promise<TurnEventRecord[]> {
    if (!hasTable(this.#db, 'turn_events')) return [];
    const limit = Math.max(1, Math.min(options.limit ?? 4_000, 20_000));
    const before = options.before ? options.before.toISOString() : null;
    // Newest-first for the LIMIT, then reversed for the caller. The subquery
    // form would work too, but two queries here would mean two chances to read
    // an inconsistent tail under a concurrent turn.
    const rows = this.#all<TurnEventRow>(
      `SELECT ${TURN_EVENT_COLUMNS} FROM turn_events
        WHERE conversation_id = ? AND (? IS NULL OR created_at <= ?)
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
      conversationId,
      before,
      before,
      limit,
    );
    return rows.reverse().map(toTurnEvent);
  }

  async settleTurnEvent(
    turnId: string,
    seq: number,
    status: TurnEventRecord['status'],
    detail?: Record<string, unknown>,
  ): Promise<void> {
    if (!hasTable(this.#db, 'turn_events')) return;
    const row = this.#get<{ payload: string; execution_id: string | null }>(
      'SELECT payload, execution_id FROM turn_events WHERE turn_id = ? AND seq = ?',
      turnId,
      seq,
    );
    if (!row) return;
    const payload = detail
      ? { ...parseJson<Record<string, unknown>>(row.payload, {}), ...detail }
      : parseJson<Record<string, unknown>>(row.payload, {});
    const executionId =
      typeof detail?.executionId === 'string' ? detail.executionId : row.execution_id;
    this.#run(
      'UPDATE turn_events SET status = ?, payload = ?, execution_id = ? WHERE turn_id = ? AND seq = ?',
      status,
      JSON.stringify(payload),
      executionId,
      turnId,
      seq,
    );
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


  // ---------------------------------------------------- model transcript -----

  async createEpoch(input: CreateEpochInput): Promise<ModelEpoch> {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#run(
        `UPDATE model_epochs SET active = 0, ended_at = ?
          WHERE conversation_id = ? AND active = 1`,
        input.createdAt.toISOString(),
        input.conversationId,
      );
      this.#assertItemsBelongToConversation(input.conversationId, input.windowItemIds);
      this.#run(
        `INSERT INTO model_epochs
           (id, user_id, conversation_id, parent_epoch_id, reason, instructions,
            prompt_version, tools, tools_hash, provider_id, model_id,
            protocol_revision, encoder_revision, window_item_ids, window_revision,
            seeded_through_seq, active, created_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL)`,
        input.id,
        input.userId,
        input.conversationId,
        input.parentEpochId,
        input.reason,
        input.instructions,
        input.promptVersion,
        JSON.stringify(input.tools),
        input.toolsHash,
        input.providerId,
        input.modelId,
        input.protocolRevision,
        input.encoderRevision,
        JSON.stringify(input.windowItemIds),
        input.windowRevision,
        input.seededThroughSeq,
        input.createdAt.toISOString(),
      );
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    const epoch = await this.getEpoch(input.id);
    if (!epoch) throw new Error('epoch insert produced no row');
    return epoch;
  }

  async activeEpoch(conversationId: string): Promise<ModelEpoch | null> {
    const row = this.#get<ModelEpochRow>(
      `SELECT * FROM model_epochs WHERE conversation_id = ? AND active = 1`,
      conversationId,
    );
    return row ? toModelEpoch(row) : null;
  }

  async listEpochs(conversationId: string): Promise<ModelEpoch[]> {
    return this.#all<ModelEpochRow>(
      `SELECT * FROM model_epochs WHERE conversation_id = ? ORDER BY created_at ASC`,
      conversationId,
    ).map(toModelEpoch);
  }

  async getEpoch(epochId: string): Promise<ModelEpoch | null> {
    const row = this.#get<ModelEpochRow>('SELECT * FROM model_epochs WHERE id = ?', epochId);
    return row ? toModelEpoch(row) : null;
  }

  async appendItems(items: readonly NewModelItem[]): Promise<ModelItem[]> {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const appended = items.map((entry) => this.#insertItem(entry));
      this.#db.exec('COMMIT');
      return appended;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  async listItems(conversationId: string, ids?: readonly string[]): Promise<ModelItem[]> {
    if (ids && ids.length === 0) return [];
    const rows = ids
      ? this.#all<ModelItemRow>(
          `SELECT * FROM model_items
            WHERE conversation_id = ? AND id IN (${placeholders(ids.length)})
            ORDER BY seq ASC`,
          conversationId,
          ...ids,
        )
      : this.#all<ModelItemRow>(
          `SELECT * FROM model_items WHERE conversation_id = ? ORDER BY seq ASC`,
          conversationId,
        );
    return rows.map(toModelItem);
  }

  async listEpochItems(epochId: string): Promise<ModelItem[]> {
    return this.#all<ModelItemRow>(
      `SELECT * FROM model_items WHERE epoch_id = ? ORDER BY seq ASC`,
      epochId,
    ).map(toModelItem);
  }

  async knownMessageIds(conversationId: string): Promise<Set<string>> {
    const rows = this.#all<{ message_id: string }>(
      `SELECT DISTINCT message_id FROM model_items
        WHERE conversation_id = ? AND message_id IS NOT NULL`,
      conversationId,
    );
    return new Set(rows.map((row) => row.message_id));
  }

  async contextState(conversationId: string, epochId: string): Promise<ModelContextState[]> {
    return this.#all<ModelContextStateRow>(
      `SELECT * FROM model_context_state
        WHERE conversation_id = ? AND epoch_id = ?
        ORDER BY key ASC`,
      conversationId,
      epochId,
    ).map(toModelContextState);
  }

  async saveContextState(states: readonly NewModelContextState[]): Promise<void> {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      for (const state of states) this.#upsertContextState(state);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  async updateWindow(
    epochId: string,
    expectedRevision: number,
    itemIds: readonly string[],
  ): Promise<ModelEpoch> {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const epoch = this.#get<ModelEpochRow>(
        'SELECT * FROM model_epochs WHERE id = ?',
        epochId,
      );
      if (!epoch) throw new Error(`model epoch ${epochId} not found`);
      if (Number(epoch.window_revision) !== expectedRevision) {
        throw new TranscriptRevisionConflictError(
          epoch.id,
          expectedRevision,
          Number(epoch.window_revision),
        );
      }
      this.#assertItemsBelongToConversation(epoch.conversation_id, itemIds);
      this.#run(
        `UPDATE model_epochs
            SET window_item_ids = ?, window_revision = window_revision + 1
          WHERE id = ?`,
        JSON.stringify(itemIds),
        epochId,
      );
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    const updated = await this.getEpoch(epochId);
    if (!updated) throw new Error('epoch update produced no row');
    return updated;
  }

  async prepareStep(input: PrepareStepInput): Promise<PrepareStepResult> {
    const existing = this.#get<ModelStepRow>(
      `SELECT * FROM model_steps WHERE request_id = ? AND step = ? AND attempt_no = ?`,
      input.step.requestId,
      input.step.step,
      input.step.attemptNo,
    );
    if (existing) {
      const items = await this.listItems(input.step.conversationId, input.step.inputItemIds);
      return {
        items,
        step: toModelStep(existing),
        epoch: await this.getEpoch(existing.epoch_id),
      };
    }

    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const appended = input.items.map((entry) => this.#insertItem(entry));
      if (input.window) {
        const epoch = this.#get<ModelEpochRow>(
          'SELECT * FROM model_epochs WHERE id = ?',
          input.window.epochId,
        );
        if (!epoch) throw new Error(`model epoch ${input.window.epochId} not found`);
        if (Number(epoch.window_revision) !== input.window.expectedRevision) {
          throw new TranscriptRevisionConflictError(
            epoch.id,
            input.window.expectedRevision,
            Number(epoch.window_revision),
          );
        }
        this.#assertItemsBelongToConversation(epoch.conversation_id, input.window.itemIds);
        this.#run(
          `UPDATE model_epochs
              SET window_item_ids = ?, window_revision = window_revision + 1
            WHERE id = ?`,
          JSON.stringify(input.window.itemIds),
          input.window.epochId,
        );
      }
      for (const state of input.state ?? []) this.#upsertContextState(state);
      this.#run(
        `INSERT INTO model_steps
           (attempt_id, request_id, turn_id, conversation_id, step, attempt_no,
            epoch_id, epoch_revision, input_item_ids, output_item_ids,
            request_config_digest, projection, status, response_id, usage,
            error, finish_reason, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, NULL)`,
        input.step.attemptId,
        input.step.requestId,
        input.step.turnId,
        input.step.conversationId,
        input.step.step,
        input.step.attemptNo,
        input.step.epochId,
        input.step.epochRevision,
        JSON.stringify(input.step.inputItemIds),
        JSON.stringify(input.step.outputItemIds ?? []),
        input.step.requestConfigDigest,
        input.step.projection ? JSON.stringify(input.step.projection) : null,
        input.step.status,
        input.step.createdAt.toISOString(),
      );
      this.#db.exec('COMMIT');
      const step = await this.getStep(input.step.attemptId);
      if (!step) throw new Error('step insert produced no row');
      return {
        items: appended,
        step,
        epoch: await this.getEpoch(input.step.epochId),
      };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  async updateStep(attemptId: string, patch: StepPatch): Promise<ModelStepRecord | null> {
    const sets: string[] = [];
    const values: SqlValue[] = [];
    if (patch.status !== undefined) {
      sets.push('status = ?');
      values.push(patch.status);
    }
    if (patch.outputItemIds !== undefined) {
      sets.push('output_item_ids = ?');
      values.push(JSON.stringify(patch.outputItemIds));
    }
    if (patch.usage !== undefined) {
      sets.push('usage = ?');
      values.push(patch.usage ? JSON.stringify(patch.usage) : null);
    }
    if (patch.responseId !== undefined) {
      sets.push('response_id = ?');
      values.push(patch.responseId);
    }
    if (patch.error !== undefined) {
      sets.push('error = ?');
      values.push(patch.error);
    }
    if (patch.finishReason !== undefined) {
      sets.push('finish_reason = ?');
      values.push(patch.finishReason);
    }
    if (patch.projection !== undefined) {
      sets.push('projection = ?');
      values.push(patch.projection ? JSON.stringify(patch.projection) : null);
    }
    if (patch.completedAt !== undefined) {
      sets.push('completed_at = ?');
      values.push(patch.completedAt?.toISOString() ?? null);
    }
    if (sets.length > 0) {
      values.push(attemptId);
      this.#run(`UPDATE model_steps SET ${sets.join(', ')} WHERE attempt_id = ?`, ...values);
    }
    return this.getStep(attemptId);
  }

  async getStep(attemptId: string): Promise<ModelStepRecord | null> {
    const row = this.#get<ModelStepRow>(
      'SELECT * FROM model_steps WHERE attempt_id = ?',
      attemptId,
    );
    return row ? toModelStep(row) : null;
  }

  async listSteps(requestId: string): Promise<ModelStepRecord[]> {
    return this.#all<ModelStepRow>(
      `SELECT * FROM model_steps WHERE request_id = ? ORDER BY step ASC, attempt_no ASC`,
      requestId,
    ).map(toModelStep);
  }

  async listRecentSteps(conversationId: string, limit: number): Promise<ModelStepRecord[]> {
    return this.#all<ModelStepRow>(
      `SELECT * FROM model_steps WHERE conversation_id = ?
        ORDER BY created_at DESC LIMIT ?`,
      conversationId,
      limit,
    ).map(toModelStep);
  }

  async linkAssistantMessage(
    conversationId: string,
    requestId: string,
    messageId: string,
  ): Promise<void> {
    this.#run(
      `UPDATE model_items SET message_id = ?
        WHERE id = (
          SELECT id FROM model_items
           WHERE conversation_id = ? AND request_id = ? AND kind = 'assistant'
           ORDER BY seq DESC LIMIT 1
        )`,
      messageId,
      conversationId,
      requestId,
    );
  }

  async deleteTranscript(conversationId: string): Promise<void> {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#run('DELETE FROM model_context_state WHERE conversation_id = ?', conversationId);
      this.#run('DELETE FROM model_steps WHERE conversation_id = ?', conversationId);
      this.#run('DELETE FROM model_items WHERE conversation_id = ?', conversationId);
      this.#run('DELETE FROM model_epochs WHERE conversation_id = ?', conversationId);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  #insertItem(entry: NewModelItem): ModelItem {
    const existing = this.#get<ModelItemRow>(
      `SELECT * FROM model_items WHERE conversation_id = ? AND idempotency_key = ?`,
      entry.conversationId,
      entry.idempotencyKey,
    );
    if (existing) return toModelItem(existing);
    const epoch = this.#get<{ conversation_id: string }>(
      'SELECT conversation_id FROM model_epochs WHERE id = ?',
      entry.epochId,
    );
    if (!epoch) throw new Error(`model item references unknown epoch ${entry.epochId}`);
    if (epoch.conversation_id !== entry.conversationId) {
      throw new Error(`model item ${entry.idempotencyKey} belongs to another conversation`);
    }
    const max = this.#get<{ seq: number | null }>(
      'SELECT MAX(seq) AS seq FROM model_items WHERE conversation_id = ?',
      entry.conversationId,
    );
    const seq = Number(max?.seq ?? 0) + 1;
    const payload = entry.payload;
    const id = entry.id ?? randomUUID();
    const contentHash = entry.contentHash ?? itemContentHash(payload);
    this.#run(
      `INSERT INTO model_items
         (id, conversation_id, epoch_id, seq, idempotency_key, request_id, turn_id,
          step, kind, source, scope, content_version, payload, content_hash,
          message_id, call_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      entry.conversationId,
      entry.epochId,
      seq,
      entry.idempotencyKey,
      entry.requestId ?? null,
      entry.turnId ?? null,
      entry.step ?? null,
      entry.kind,
      entry.source,
      entry.scope,
      entry.contentVersion ?? MODEL_TRANSCRIPT_VERSION,
      JSON.stringify(payload),
      contentHash,
      entry.messageId ?? null,
      entry.callId ?? null,
      entry.status ?? 'complete',
      nowIso(),
    );
    const row = this.#get<ModelItemRow>('SELECT * FROM model_items WHERE id = ?', id);
    if (!row) throw new Error('model item insert produced no row');
    return toModelItem(row);
  }

  #upsertContextState(input: NewModelContextState): void {
    this.#run(
      `INSERT INTO model_context_state
         (conversation_id, epoch_id, key, scope, content_hash, render_version,
          revision, latest_item_id, cleared, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (epoch_id, key) DO UPDATE SET
         scope = excluded.scope,
         content_hash = excluded.content_hash,
         render_version = excluded.render_version,
         revision = excluded.revision,
         latest_item_id = excluded.latest_item_id,
         cleared = excluded.cleared,
         updated_at = excluded.updated_at`,
      input.conversationId,
      input.epochId,
      input.key,
      input.scope,
      input.contentHash,
      input.renderVersion ?? TRANSCRIPT_RENDER_VERSION,
      input.revision,
      input.latestItemId,
      input.cleared ? 1 : 0,
      nowIso(),
    );
  }

  #assertItemsBelongToConversation(conversationId: string, ids: readonly string[]): void {
    for (const id of ids) {
      const row = this.#get<{ conversation_id: string }>(
        'SELECT conversation_id FROM model_items WHERE id = ?',
        id,
      );
      if (!row) throw new Error(`model item ${id} not found`);
      if (row.conversation_id !== conversationId) {
        throw new Error(`model item ${id} belongs to another conversation`);
      }
    }
  }

  // ------------------------------------------------------------ processes -----

  async createDevJob(record: DevJobRecord): Promise<void> {
    this.#run(
      `INSERT INTO dev_jobs
         (id, user_id, conversation_id, turn_id, member_id, task_id, tool_call_id, command, cwd,
          marker, pid, status, exit_code, stdout_path, stderr_path, stdin_fifo,
          started_at, ended_at, expires_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.userId,
      record.conversationId,
      record.turnId,
      record.memberId,
      record.taskId,
      record.toolCallId,
      record.command,
      record.cwd,
      record.marker,
      record.pid,
      record.status,
      record.exitCode,
      record.stdoutPath,
      record.stderrPath,
      record.stdinFifo,
      record.startedAt,
      record.endedAt,
      record.expiresAt,
      record.error,
    );
  }

  async updateDevJob(
    userId: string,
    id: string,
    patch: Partial<
      Pick<DevJobRecord, 'pid' | 'status' | 'exitCode' | 'endedAt' | 'error' | 'expiresAt'>
    >,
  ): Promise<void> {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    const add = (column: string, value: string | number | null): void => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.pid !== undefined) add('pid', patch.pid);
    if (patch.status !== undefined) add('status', patch.status);
    if (patch.exitCode !== undefined) add('exit_code', patch.exitCode);
    if (patch.endedAt !== undefined) add('ended_at', patch.endedAt);
    if (patch.error !== undefined) add('error', patch.error);
    if (patch.expiresAt !== undefined) add('expires_at', patch.expiresAt);
    if (sets.length === 0) return;
    values.push(userId, id);
    this.#run(`UPDATE dev_jobs SET ${sets.join(', ')} WHERE user_id = ? AND id = ?`, ...values);
  }

  async getDevJob(userId: string, id: string): Promise<DevJobRecord | null> {
    const row = this.#get<Record<string, unknown>>(
      'SELECT * FROM dev_jobs WHERE user_id = ? AND id = ?',
      userId,
      id,
    );
    return row ? toDevJob(row) : null;
  }

  async getDevJobByCall(
    userId: string,
    conversationId: string,
    toolCallId: string,
  ): Promise<DevJobRecord | null> {
    const row = this.#get<Record<string, unknown>>(
      `SELECT * FROM dev_jobs
        WHERE user_id = ? AND conversation_id = ? AND tool_call_id = ?`,
      userId,
      conversationId,
      toolCallId,
    );
    return row ? toDevJob(row) : null;
  }

  async listDevJobs(userId: string, conversationId: string): Promise<DevJobRecord[]> {
    return this.#all<Record<string, unknown>>(
      `SELECT * FROM dev_jobs WHERE user_id = ? AND conversation_id = ?
        ORDER BY started_at DESC LIMIT 20`,
      userId,
      conversationId,
    ).map(toDevJob);
  }

  async listRunningDevJobs(): Promise<DevJobRecord[]> {
    return this.#all<Record<string, unknown>>(
      `SELECT * FROM dev_jobs WHERE status IN ('running', 'starting') ORDER BY started_at`,
    ).map(toDevJob);
  }

  // ----------------------------------------------------------- questions -----

  async createUserQuestion(record: UserQuestionRecord): Promise<void> {
    this.#run(
      `INSERT INTO user_questions
         (id, user_id, conversation_id, turn_id, call_id, member_id, generation,
          prompt, schema_json, status, answer_json, created_at, expires_at, answered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.userId,
      record.conversationId,
      record.turnId,
      record.callId,
      record.memberId,
      record.generation,
      record.prompt,
      JSON.stringify(record.schema),
      record.status,
      record.answer === null ? null : JSON.stringify(record.answer),
      record.createdAt,
      record.expiresAt,
      record.answeredAt,
    );
  }

  async getUserQuestion(userId: string, id: string): Promise<UserQuestionRecord | null> {
    const row = this.#get<Record<string, unknown>>(
      'SELECT * FROM user_questions WHERE user_id = ? AND id = ?',
      userId,
      id,
    );
    return row ? toQuestion(row) : null;
  }

  async getUserQuestionByCall(
    userId: string,
    conversationId: string,
    callId: string,
  ): Promise<UserQuestionRecord | null> {
    const row = this.#get<Record<string, unknown>>(
      `SELECT * FROM user_questions
        WHERE user_id = ? AND conversation_id = ? AND call_id = ?
        ORDER BY created_at DESC LIMIT 1`,
      userId,
      conversationId,
      callId,
    );
    return row ? toQuestion(row) : null;
  }

  async listPendingQuestions(
    userId: string,
    conversationId: string,
  ): Promise<UserQuestionRecord[]> {
    return this.#all<Record<string, unknown>>(
      `SELECT * FROM user_questions
        WHERE user_id = ? AND conversation_id = ? AND status = 'pending'
        ORDER BY created_at`,
      userId,
      conversationId,
    ).map(toQuestion);
  }

  async resolveUserQuestion(input: {
    readonly userId: string;
    readonly id: string;
    readonly status: Exclude<QuestionStatus, 'pending'>;
    readonly answer: Record<string, unknown> | null;
    readonly at: string;
  }): Promise<boolean> {
    return (
      this.#run(
        `UPDATE user_questions
            SET status = ?, answer_json = ?, answered_at = ?
          WHERE user_id = ? AND id = ? AND status = 'pending'`,
        input.status,
        input.answer === null ? null : JSON.stringify(input.answer),
        input.at,
        input.userId,
        input.id,
      ).changes > 0
    );
  }

  async expireUserQuestions(now: Date): Promise<number> {
    return this.#run(
      `UPDATE user_questions SET status = 'expired', answered_at = ?
        WHERE status = 'pending' AND expires_at <= ?`,
      now.toISOString(),
      now.toISOString(),
    ).changes;
  }

  // --------------------------------------------------------------- web ------

  async saveWebDocument(record: WebDocumentRecord): Promise<void> {
    this.#run(
      `INSERT INTO web_documents
         (id, user_id, conversation_id, action_id, requested_url, final_url, status,
          mime_type, title, text, bytes, truncated, fetched_at, sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.userId,
      record.conversationId,
      record.actionId,
      record.requestedUrl,
      record.finalUrl,
      record.status,
      record.mimeType,
      record.title,
      record.text,
      record.bytes,
      record.truncated ? 1 : 0,
      record.fetchedAt,
      record.sha256,
    );
  }

  async getWebDocument(userId: string, id: string): Promise<WebDocumentRecord | null> {
    const row = this.#get<Record<string, unknown>>(
      'SELECT * FROM web_documents WHERE user_id = ? AND id = ?',
      userId,
      id,
    );
    if (!row) return null;
    return {
      id: String(row.id),
      userId: String(row.user_id),
      conversationId: String(row.conversation_id),
      actionId: row.action_id === null ? null : String(row.action_id),
      requestedUrl: String(row.requested_url),
      finalUrl: String(row.final_url),
      status: Number(row.status),
      mimeType: String(row.mime_type),
      title: row.title === null ? null : String(row.title),
      text: String(row.text),
      bytes: Number(row.bytes),
      truncated: Number(row.truncated) === 1,
      fetchedAt: String(row.fetched_at),
      sha256: String(row.sha256),
    };
  }

  // ---------------------------------------------------------- changesets -----

  async createWorkspaceChangeset(input: NewChangesetInput): Promise<void> {
    const summary = input.summary;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#run(
        `INSERT INTO workspace_changesets
           (id, user_id, conversation_id, turn_id, workspace_id, checkpoint_id,
            before_digest, after_digest, file_count, added, modified, deleted,
            status, created_at, undone_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        summary.id,
        summary.userId,
        summary.conversationId,
        summary.turnId,
        summary.workspaceId,
        summary.checkpointId,
        summary.beforeDigest,
        summary.afterDigest,
        summary.fileCount,
        summary.added,
        summary.modified,
        summary.deleted,
        summary.status,
        summary.createdAt,
        summary.undoneAt,
      );
      for (const file of input.files) {
        this.#run(
          `INSERT INTO workspace_changeset_files
             (changeset_id, path, kind, before_sha, after_sha, before_bytes,
              after_bytes, before_content, restore_source, restored)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          summary.id,
          file.path,
          file.kind,
          file.beforeSha,
          file.afterSha,
          file.beforeBytes,
          file.afterBytes,
          file.beforeContent,
          file.restoreSource,
          file.restored ? 1 : 0,
        );
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  async getWorkspaceChangeset(
    userId: string,
    id: string,
  ): Promise<WorkspaceChangesetRecord | null> {
    const row = this.#get<Record<string, unknown>>(
      'SELECT * FROM workspace_changesets WHERE user_id = ? AND id = ?',
      userId,
      id,
    );
    if (!row) return null;
    const files = this.#all<Record<string, unknown>>(
      'SELECT * FROM workspace_changeset_files WHERE changeset_id = ? ORDER BY path',
      id,
    ).map(toChangesetFile);
    return { ...toChangesetSummary(row), files };
  }

  async getWorkspaceChangesetForTurn(
    userId: string,
    conversationId: string,
    turnId: string,
  ): Promise<WorkspaceChangesetRecord | null> {
    const row = this.#get<Record<string, unknown>>(
      `SELECT * FROM workspace_changesets
        WHERE user_id = ? AND conversation_id = ? AND turn_id = ?`,
      userId,
      conversationId,
      turnId,
    );
    if (!row) return null;
    return this.getWorkspaceChangeset(userId, String(row.id));
  }

  async listWorkspaceChangesets(
    userId: string,
    conversationId: string,
    limit = 50,
  ): Promise<WorkspaceChangesetSummary[]> {
    return this.#all<Record<string, unknown>>(
      `SELECT * FROM workspace_changesets
        WHERE user_id = ? AND conversation_id = ?
        ORDER BY created_at DESC LIMIT ?`,
      userId,
      conversationId,
      limit,
    ).map(toChangesetSummary);
  }

  async finishWorkspaceUndo(input: {
    readonly userId: string;
    readonly changesetId: string;
    readonly restoredPaths: readonly string[];
    readonly status: ChangesetStatus;
    readonly undoneAt: string;
  }): Promise<void> {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      for (const path of input.restoredPaths) {
        this.#run(
          `UPDATE workspace_changeset_files SET restored = 1
            WHERE changeset_id = ? AND path = ?`,
          input.changesetId,
          path,
        );
      }
      this.#run(
        `UPDATE workspace_changesets SET status = ?, undone_at = ?
          WHERE user_id = ? AND id = ?`,
        input.status,
        input.undoneAt,
        input.userId,
        input.changesetId,
      );
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  // ------------------------------------------------------------ plumbing -----

  async ping(): Promise<boolean> {
    try {
      this.#statements.get('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.#statements.clear();
    this.#db.close();
  }

  // ------------------------------------------------------------ internals ----

  #all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.#statements.get(sql).all(...params) as T[];
  }

  #get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.#statements.get(sql).get(...params) as T | undefined;
  }

  #run(sql: string, ...params: SqlValue[]): { changes: number } {
    const result = this.#statements.get(sql).run(...params);
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
    if (version < 5) {
      migrateToVersion5(db);
    }
    if (version < 6) {
      db.exec(SQLITE_MIGRATION_6);
    }
    if (version < 7) {
      migrateToVersion7(db);
    }
    if (version < 8) {
      migrateToVersion8(db);
    }
    if (version < 9) {
      migrateToVersion9(db);
    }
    if (version < 10) {
      migrateToVersion10(db);
    }
    if (version < 11) {
      db.exec(SQLITE_MIGRATION_11);
    }
    if (version < 13) {
      db.exec(SQLITE_MIGRATION_13);
    }
    if (version < 14) {
      db.exec(SQLITE_MIGRATION_14);
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
    contentParts: parseContentParts(row.content_parts),
    interrupted: Number(row.interrupted) === 1,
    createdAt: new Date(row.created_at),
    seq: Number(row.seq),
  };
}

function toMediaAsset(row: MediaAssetRow): ImageAsset {
  return {
    id: row.id,
    userId: row.user_id,
    conversationId: row.conversation_id,
    name: row.name,
    mediaType: row.media_type as ImageMediaType,
    bytes: Number(row.bytes),
    width: Number(row.width),
    height: Number(row.height),
    sha256: row.sha256,
    storageKey: row.storage_key,
    normalized: {
      key: row.normalized_key,
      width: Number(row.normalized_width),
      height: Number(row.normalized_height),
      bytes: Number(row.normalized_bytes),
      sha256: row.normalized_sha256,
      processorVersion: row.processor_version,
      policyRevision: row.policy_revision,
    },
    request: {
      key: row.request_key,
      width: Number(row.request_width),
      height: Number(row.request_height),
      bytes: Number(row.request_bytes),
      sha256: row.request_sha256,
      processorVersion: row.processor_version,
      policyRevision: row.policy_revision,
    },
    status: row.status as MediaAssetStatus,
    leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at) : null,
    createdAt: new Date(row.created_at),
  };
}

function parseContentParts(value: string | null): UserContentV1 | null {
  if (value === null || value.length === 0) return null;
  const parsed = parseJson<unknown>(value, null);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== 1 ||
    !Array.isArray((parsed as { parts?: unknown }).parts)
  ) {
    // Unknown versions are refused rather than silently read as empty text.
    throw new Error('stored message has unsupported content_parts');
  }
  return parsed as UserContentV1;
}

function toTurn(row: TurnRow): TurnRecord {
  return {
    id: row.id,
    turnId: row.turn_id,
    userId: row.user_id,
    conversationId: row.conversation_id,
    requestHash: row.request_hash,
    status: row.status as TurnRecord['status'],
    finishReason: (row.finish_reason as TurnRecord['finishReason']) ?? null,
    reply: row.reply,
    messageId: row.message_id,
    error: row.error,
    model: row.model,
    steps: Number(row.steps),
    contextTokens: row.context_tokens === null ? null : Number(row.context_tokens),
    accepted: row.accepted === null ? null : Number(row.accepted) === 1,
    acceptance: parseJson<TurnRecord['acceptance']>(row.acceptance, []),
    usage: row.usage === null ? null : parseJson<TurnRecord['usage']>(row.usage, null),
    turnUsage:
      row.turn_usage === null
        ? null
        : parseJson<NonNullable<TurnRecord['turnUsage']> | null>(row.turn_usage, null),
    startedAt: new Date(row.started_at),
    endedAt: row.ended_at ? new Date(row.ended_at) : null,
  };
}

function toTurnEvent(row: TurnEventRow): TurnEventRecord {
  return {
    turnId: row.turn_id,
    conversationId: row.conversation_id,
    seq: Number(row.seq),
    kind: row.kind as TurnEventRecord['kind'],
    callId: row.call_id,
    toolName: row.tool_name,
    status: row.status as TurnEventRecord['status'],
    executionId: row.execution_id,
    payload: parseJson<Record<string, unknown>>(row.payload, {}),
    createdAt: new Date(row.created_at),
  };
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message.includes('UNIQUE constraint failed');
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


function toModelEpoch(row: ModelEpochRow): ModelEpoch {
  return {
    id: row.id,
    userId: row.user_id,
    conversationId: row.conversation_id,
    parentEpochId: row.parent_epoch_id,
    reason: row.reason as ModelEpoch['reason'],
    instructions: row.instructions,
    promptVersion: row.prompt_version,
    tools: parseJson(row.tools, []),
    toolsHash: row.tools_hash,
    providerId: row.provider_id,
    modelId: row.model_id,
    protocolRevision: row.protocol_revision,
    encoderRevision: row.encoder_revision,
    windowItemIds: parseJson<string[]>(row.window_item_ids, []),
    windowRevision: Number(row.window_revision),
    seededThroughSeq: Number(row.seeded_through_seq),
    createdAt: new Date(row.created_at),
    endedAt: row.ended_at ? new Date(row.ended_at) : null,
  };
}

function toModelItem(row: ModelItemRow): ModelItem {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    epochId: row.epoch_id,
    seq: Number(row.seq),
    requestId: row.request_id,
    turnId: row.turn_id,
    step: row.step === null ? null : Number(row.step),
    kind: row.kind as ModelItem['kind'],
    source: row.source as ModelItem['source'],
    scope: row.scope as ModelItem['scope'],
    contentVersion: row.content_version,
    payload: parseJson(row.payload, { type: 'message', role: 'system', content: '' } as ModelItem['payload']),
    contentHash: row.content_hash,
    messageId: row.message_id,
    callId: row.call_id,
    status: row.status as ModelItem['status'],
    createdAt: new Date(row.created_at),
  };
}

function toModelStep(row: ModelStepRow): ModelStepRecord {
  return {
    attemptId: row.attempt_id,
    requestId: row.request_id,
    turnId: row.turn_id,
    conversationId: row.conversation_id,
    step: Number(row.step),
    attemptNo: Number(row.attempt_no),
    epochId: row.epoch_id,
    epochRevision: Number(row.epoch_revision),
    inputItemIds: parseJson<string[]>(row.input_item_ids, []),
    outputItemIds: parseJson<string[]>(row.output_item_ids, []),
    requestConfigDigest: row.request_config_digest,
    projection: row.projection
      ? (parseJson(row.projection, null) as RequestProjection | null)
      : null,
    status: row.status as ModelStepRecord['status'],
    responseId: row.response_id,
    usage: row.usage ? (parseJson(row.usage, null) as StepUsage | null) : null,
    error: row.error,
    finishReason: row.finish_reason,
    createdAt: new Date(row.created_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
  };
}

function toModelContextState(row: ModelContextStateRow): ModelContextState {
  return {
    conversationId: row.conversation_id,
    epochId: row.epoch_id,
    key: row.key,
    scope: row.scope as ModelContextState['scope'],
    contentHash: row.content_hash,
    renderVersion: row.render_version,
    revision: Number(row.revision),
    latestItemId: row.latest_item_id,
    cleared: Number(row.cleared) === 1,
    updatedAt: new Date(row.updated_at),
  };
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

/**
 * Version 4 → 5.
 *
 * Same reason as version 4: `ALTER TABLE … ADD COLUMN` is not idempotent in
 * SQLite, so each column is checked first and a partially migrated file
 * converges on the next open.
 *
 * Existing tasks get `workspace_root = '/workspace'` and
 * `current_cwd = workspace_root` rather than a best guess: the ADR is explicit
 * that a historical `cd` cannot be recovered from command text, and inventing a
 * directory is worse than starting at the workspace root.
 */
function migrateToVersion5(db: DatabaseSync): void {
  db.exec(CWD_SCHEMA);
  const columns: readonly { table: string; column: string; ddl: string }[] = [
    { table: 'sandbox_tasks', column: 'workspace_root', ddl: 'TEXT' },
    { table: 'sandbox_tasks', column: 'current_cwd', ddl: 'TEXT' },
    { table: 'sandbox_tasks', column: 'cwd_version', ddl: 'INTEGER NOT NULL DEFAULT 1' },
    { table: 'sandbox_tasks', column: 'cwd_invalidated_at', ddl: 'TEXT' },
    { table: 'sandbox_tasks', column: 'cwd_invalid_reason', ddl: 'TEXT' },
    { table: 'executions', column: 'cwd_version', ddl: 'INTEGER NOT NULL DEFAULT 1' },
  ];
  for (const entry of columns) {
    if (hasColumn(db, entry.table, entry.column)) continue;
    db.exec(`ALTER TABLE ${entry.table} ADD COLUMN ${entry.column} ${entry.ddl}`);
  }
  db.exec(
    `UPDATE sandbox_tasks
        SET workspace_root = COALESCE(workspace_root, '/workspace'),
            current_cwd = COALESCE(current_cwd, workspace_root, '/workspace'),
            cwd_version = COALESCE(cwd_version, 1)`,
  );
}

/**
 * Version 6 → 7.
 *
 * Two changes, and only one of them is an ordinary column addition. Widening
 * `agent_runs.status` means editing a CHECK constraint, which SQLite cannot do
 * in place, so that table is rebuilt: create the new shape beside the old one,
 * copy every row, drop the original, rename. The indexes go with the dropped
 * table and are recreated by name.
 *
 * A crash between the drop and the rename leaves `agent_runs_v7` as the only
 * copy. The next open finishes the rename instead of rebuilding from a table
 * that no longer exists, which is the difference between a migration and a
 * data-loss bug.
 */
function migrateToVersion7(db: DatabaseSync): void {
  if (!hasColumn(db, 'messages', 'interrupted')) {
    db.exec('ALTER TABLE messages ADD COLUMN interrupted INTEGER NOT NULL DEFAULT 0');
  }

  const existing = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_runs'")
    .get() as { sql?: string } | undefined;
  if (existing?.sql?.includes("'interrupted'")) return;

  if (!existing) {
    if (hasTable(db, 'agent_runs_v7')) {
      db.exec('ALTER TABLE agent_runs_v7 RENAME TO agent_runs');
      createAgentRunIndexes(db);
    }
    return;
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    // A leftover from an interrupted attempt is never the source of truth while
    // the original table is still here.
    db.exec('DROP TABLE IF EXISTS agent_runs_v7');
    db.exec(`
      CREATE TABLE agent_runs_v7 (
        id                 TEXT PRIMARY KEY,
        user_id            TEXT REFERENCES users(id) ON DELETE SET NULL,
        conversation_id    TEXT REFERENCES conversations(id) ON DELETE SET NULL,
        model              TEXT NOT NULL,
        prompt_version     TEXT NOT NULL,
        started_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        ended_at           TEXT,
        duration_ms        INTEGER,
        status             TEXT NOT NULL DEFAULT 'running'
                             CHECK (status IN ('running', 'completed', 'failed',
                                               'safety_replaced', 'interrupted')),
        used_tools         INTEGER NOT NULL DEFAULT 0,
        tool_calls         TEXT NOT NULL DEFAULT '[]',
        input_fingerprint  TEXT,
        output_fingerprint TEXT,
        risk_level         TEXT CHECK (risk_level IN ('none', 'elevated', 'crisis')),
        error              TEXT
      );
    `);
    db.exec(`
      INSERT INTO agent_runs_v7
        (id, user_id, conversation_id, model, prompt_version, started_at, ended_at,
         duration_ms, status, used_tools, tool_calls, input_fingerprint,
         output_fingerprint, risk_level, error)
      SELECT id, user_id, conversation_id, model, prompt_version, started_at, ended_at,
             duration_ms, status, used_tools, tool_calls, input_fingerprint,
             output_fingerprint, risk_level, error
        FROM agent_runs;
    `);
    db.exec('DROP TABLE agent_runs');
    db.exec('ALTER TABLE agent_runs_v7 RENAME TO agent_runs');
    createAgentRunIndexes(db);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function createAgentRunIndexes(db: DatabaseSync): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS agent_runs_time_idx ON agent_runs (started_at DESC);
    CREATE INDEX IF NOT EXISTS agent_runs_user_idx ON agent_runs (user_id);
    CREATE INDEX IF NOT EXISTS agent_runs_conversation_idx ON agent_runs (conversation_id);
  `);
}

/**
 * Version 7 → 8.
 *
 * Tables are additive, so the whole shape can be executed behind
 * `IF NOT EXISTS`. The one column is checked first: `ALTER TABLE … ADD COLUMN`
 * is not idempotent in SQLite, and a migration that crashed after adding it
 * must converge on the next open rather than fail with "duplicate column name".
 */
function migrateToVersion9(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
  if (!columns.some((column) => column.name === 'content_parts')) {
    db.exec('ALTER TABLE messages ADD COLUMN content_parts TEXT');
  }
  const turnColumns = db.prepare('PRAGMA table_info(turn_requests)').all() as { name: string }[];
  if (turnColumns.length > 0 && !turnColumns.some((column) => column.name === 'usage')) {
    db.exec('ALTER TABLE turn_requests ADD COLUMN usage TEXT');
  }
  db.exec(SQLITE_MIGRATION_9);
}

/**
 * Version 9 → 10: the persistent model transcript.
 *
 * Additive and idempotent. The one column is checked first because
 * `ALTER TABLE … ADD COLUMN` is not idempotent in SQLite.
 */
function migrateToVersion10(db: DatabaseSync): void {
  if (hasTable(db, 'turn_requests') && !hasColumn(db, 'turn_requests', 'turn_usage')) {
    db.exec('ALTER TABLE turn_requests ADD COLUMN turn_usage TEXT');
  }
  db.exec(SQLITE_MIGRATION_10);
}

function migrateToVersion8(db: DatabaseSync): void {
  if (!hasColumn(db, 'agent_runs', 'finish_reason')) {
    db.exec('ALTER TABLE agent_runs ADD COLUMN finish_reason TEXT');
  }
  db.exec(SQLITE_MIGRATION_8);
}

function hasTable(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare("SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  return row !== undefined;
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((row) => row.name === column);
}

function toChangesetSummary(row: Record<string, unknown>): WorkspaceChangesetSummary {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    conversationId: String(row.conversation_id),
    turnId: String(row.turn_id),
    workspaceId: String(row.workspace_id),
    checkpointId: row.checkpoint_id === null ? null : String(row.checkpoint_id),
    beforeDigest: String(row.before_digest),
    afterDigest: String(row.after_digest),
    fileCount: Number(row.file_count),
    added: Number(row.added),
    modified: Number(row.modified),
    deleted: Number(row.deleted),
    status: String(row.status) as WorkspaceChangesetSummary['status'],
    createdAt: String(row.created_at),
    undoneAt: row.undone_at === null ? null : String(row.undone_at),
  };
}

function toChangesetFile(row: Record<string, unknown>): ChangesetFileRecord {
  return {
    path: String(row.path),
    kind: String(row.kind) as ChangesetFileRecord['kind'],
    beforeSha: row.before_sha === null ? null : String(row.before_sha),
    afterSha: row.after_sha === null ? null : String(row.after_sha),
    beforeBytes: row.before_bytes === null ? null : Number(row.before_bytes),
    afterBytes: row.after_bytes === null ? null : Number(row.after_bytes),
    beforeContent: row.before_content === null ? null : String(row.before_content),
    restoreSource: String(row.restore_source) as ChangesetFileRecord['restoreSource'],
    restored: Number(row.restored) === 1,
  };
}

function toQuestion(row: Record<string, unknown>): UserQuestionRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    conversationId: String(row.conversation_id),
    turnId: row.turn_id === null ? null : String(row.turn_id),
    callId: row.call_id === null ? null : String(row.call_id),
    memberId: row.member_id === null ? null : String(row.member_id),
    generation: Number(row.generation),
    prompt: String(row.prompt),
    schema: JSON.parse(String(row.schema_json)) as QuestionSchema,
    status: String(row.status) as QuestionStatus,
    answer:
      row.answer_json === null
        ? null
        : (JSON.parse(String(row.answer_json)) as Record<string, unknown>),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    answeredAt: row.answered_at === null ? null : String(row.answered_at),
  };
}

function toDevJob(row: Record<string, unknown>): DevJobRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    conversationId: String(row.conversation_id),
    turnId: row.turn_id === null ? null : String(row.turn_id),
    memberId: row.member_id === null ? null : String(row.member_id),
    taskId: String(row.task_id),
    toolCallId: row.tool_call_id === null ? null : String(row.tool_call_id),
    command: String(row.command),
    cwd: String(row.cwd),
    marker: String(row.marker),
    pid: row.pid === null ? null : Number(row.pid),
    status: String(row.status) as JobStatus,
    exitCode: row.exit_code === null ? null : Number(row.exit_code),
    stdoutPath: String(row.stdout_path),
    stderrPath: String(row.stderr_path),
    stdinFifo: row.stdin_fifo === null ? null : String(row.stdin_fifo),
    startedAt: String(row.started_at),
    endedAt: row.ended_at === null ? null : String(row.ended_at),
    expiresAt: row.expires_at === null ? null : String(row.expires_at),
    error: row.error === null ? null : String(row.error),
  };
}
