/**
 * One-off: copy the old Postgres data for one user into SQLite.
 *
 * This is not part of the runtime. Postgres was removed in ADR 016; this script
 * exists so the data that was already there is not lost, not so the old stack
 * comes back. It deliberately reads through `docker exec psql` instead of adding
 * `pg` back as a dependency: the only thing it needs from Docker is a one-time
 * export, and a stopped daemon should not be able to break the product again.
 *
 * Usage:
 *
 *     npm run migrate:legacy
 *     LEGACY_USER_ID=<uuid> npm run migrate:legacy
 *
 * Defaults to `SINGLE_USER_ID` — the real user in this local install. It does
 * not copy evaluation leftovers: the old database contains hundreds of
 * throwaway users whose only conversations are two-message evaluation runs, and
 * copying them would undo the retention sweep this project already built.
 *
 * The migration is idempotent for this user: existing rows are updated/ignored,
 * not duplicated.
 */

import { execFileSync } from 'node:child_process';
import { openSqliteStore } from '../src/db/sqlite-store.ts';
import { sqlitePath } from '../src/db/select.ts';

type Row = Record<string, unknown>;

const container = process.env.LEGACY_CONTAINER?.trim() || 'designfree-db';
const dbUser = process.env.LEGACY_DB_USER?.trim() || 'designfree';
const dbName = process.env.LEGACY_DB_NAME?.trim() || 'designfree';
const userId = (process.env.LEGACY_USER_ID ?? process.env.SINGLE_USER_ID ?? '').trim();

if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
  throw new Error('LEGACY_USER_ID (or SINGLE_USER_ID) must be a UUID');
}

function queryJson(sql: string): Row[] {
  const output = execFileSync(
    'docker',
    ['exec', container, 'psql', '-U', dbUser, '-d', dbName, '-At', '-c', sql],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  ).trim();
  if (output.length === 0) return [];
  return JSON.parse(output) as Row[];
}

function rows(table: string, columns: string, where: string): Row[] {
  return queryJson(
    `SELECT COALESCE(json_agg(t), '[]'::json) FROM (SELECT ${columns} FROM ${table} WHERE ${where}) t`,
  );
}

const legacyUser = queryJson(
  `SELECT COALESCE(json_agg(t), '[]'::json) FROM (
     SELECT id, external_id, display_name, created_at, updated_at
       FROM users WHERE id = '${userId}'
   ) t`,
);
if (legacyUser.length === 0) {
  throw new Error(`user ${userId} was not found in the legacy database`);
}

const conversations = rows(
  'conversations',
  'id, user_id, title, started_at, last_turn_at, turn_count, archived_at, model_id',
  `user_id = '${userId}'`,
);
const messages = rows(
  'messages',
  'id, conversation_id, user_id, role, content, created_at, token_estimate, seq',
  `user_id = '${userId}'`,
);
const summaries = rows(
  'conversation_summaries',
  'conversation_id, summary, through_seq, summary_tokens, model, prompt_version, updated_at',
  `conversation_id IN (SELECT id FROM conversations WHERE user_id = '${userId}')`,
);
const memories = rows(
  'memories',
  `id, user_id, type, content, importance, confidence, source, tags, status,
   superseded_by, source_message_id, created_at, updated_at, last_accessed_at, access_count`,
  `user_id = '${userId}'`,
);
const memoryEvents = rows(
  'memory_events',
  'memory_id, user_id, action, actor, reason, detail, created_at',
  `user_id = '${userId}'`,
);
const preferences = rows(
  'user_preferences',
  'user_id, key, value, created_at, updated_at',
  `user_id = '${userId}'`,
);
const feedback = rows(
  'message_feedback',
  'message_id, user_id, rating, note, created_at',
  `user_id = '${userId}'`,
);
const runs = rows(
  'agent_runs',
  `id, user_id, conversation_id, model, prompt_version, status, used_tools,
   tool_calls, input_fingerprint, output_fingerprint, risk_level, duration_ms, error,
   started_at, ended_at`,
  `user_id = '${userId}'`,
);

const iso = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
};
const json = (value: unknown): string => JSON.stringify(value ?? null);
const bool = (value: unknown): number => (value === true || value === 1 ? 1 : 0);
const num = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);
const text = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

const store = openSqliteStore(sqlitePath());
const db = store.database;

try {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of legacyUser) {
      db.prepare(
        `INSERT INTO users (id, external_id, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           external_id = excluded.external_id,
           display_name = excluded.display_name,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
      ).run(
        String(row.id),
        text(row.external_id),
        text(row.display_name),
        iso(row.created_at) as string,
        iso(row.updated_at) as string,
      );
    }

    for (const row of conversations) {
      db.prepare(
        `INSERT INTO conversations
           (id, user_id, title, started_at, last_turn_at, turn_count, archived_at, model_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           title = excluded.title,
           started_at = excluded.started_at,
           last_turn_at = excluded.last_turn_at,
           turn_count = excluded.turn_count,
           archived_at = excluded.archived_at,
           model_id = excluded.model_id`,
      ).run(
        String(row.id),
        String(row.user_id),
        text(row.title),
        iso(row.started_at) as string,
        iso(row.last_turn_at),
        num(row.turn_count) ?? 0,
        iso(row.archived_at),
        text(row.model_id),
      );
    }

    for (const row of messages) {
      db.prepare(
        `INSERT INTO messages
           (id, conversation_id, user_id, role, content, created_at, token_estimate, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
      ).run(
        String(row.id),
        String(row.conversation_id),
        String(row.user_id),
        String(row.role),
        String(row.content),
        iso(row.created_at) as string,
        num(row.token_estimate),
        num(row.seq) ?? 0,
      );
    }

    for (const row of summaries) {
      db.prepare(
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
      ).run(
        String(row.conversation_id),
        String(row.summary),
        num(row.through_seq) ?? 0,
        num(row.summary_tokens) ?? 0,
        String(row.model),
        String(row.prompt_version),
        iso(row.updated_at) as string,
      );
    }

    for (const row of memories) {
      db.prepare(
        `INSERT INTO memories
           (id, user_id, type, content, importance, confidence, source, tags, status,
            superseded_by, source_message_id, created_at, updated_at, last_accessed_at, access_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
      ).run(
        String(row.id),
        String(row.user_id),
        String(row.type),
        String(row.content),
        Number(row.importance ?? 0.5),
        Number(row.confidence ?? 0.5),
        String(row.source),
        json(row.tags),
        String(row.status),
        text(row.superseded_by),
        text(row.source_message_id),
        iso(row.created_at) as string,
        iso(row.updated_at) as string,
        iso(row.last_accessed_at),
        num(row.access_count) ?? 0,
      );
    }

    for (const row of memoryEvents) {
      db.prepare(
        `INSERT INTO memory_events (memory_id, user_id, action, actor, reason, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        text(row.memory_id),
        String(row.user_id),
        String(row.action),
        String(row.actor),
        text(row.reason),
        json(row.detail),
        iso(row.created_at) as string,
      );
    }

    for (const row of preferences) {
      db.prepare(
        `INSERT INTO user_preferences (user_id, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user_id, key) DO UPDATE SET
           value = excluded.value, created_at = excluded.created_at, updated_at = excluded.updated_at`,
      ).run(
        String(row.user_id),
        String(row.key),
        json(row.value),
        iso(row.created_at) as string,
        iso(row.updated_at) as string,
      );
    }

    for (const row of feedback) {
      db.prepare(
        `INSERT INTO message_feedback (message_id, user_id, rating, note, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (message_id, user_id) DO UPDATE SET
           rating = excluded.rating, note = excluded.note, created_at = excluded.created_at`,
      ).run(
        String(row.message_id),
        String(row.user_id),
        String(row.rating),
        text(row.note),
        iso(row.created_at) as string,
      );
    }

    for (const row of runs) {
      db.prepare(
        `INSERT INTO agent_runs
           (id, user_id, conversation_id, model, prompt_version, started_at, ended_at,
            duration_ms, status, used_tools, tool_calls, input_fingerprint,
            output_fingerprint, risk_level, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
      ).run(
        String(row.id),
        text(row.user_id),
        text(row.conversation_id),
        String(row.model),
        String(row.prompt_version),
        iso(row.started_at) as string,
        iso(row.ended_at),
        num(row.duration_ms),
        String(row.status),
        bool(row.used_tools),
        json(row.tool_calls),
        text(row.input_fingerprint),
        text(row.output_fingerprint),
        text(row.risk_level),
        text(row.error),
      );
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  const counts = {
    users: (db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n,
    conversations: (
      db.prepare('SELECT count(*) AS n FROM conversations WHERE user_id = ?').get(userId) as {
        n: number;
      }
    ).n,
    messages: (
      db.prepare('SELECT count(*) AS n FROM messages WHERE user_id = ?').get(userId) as {
        n: number;
      }
    ).n,
    runs: (
      db.prepare('SELECT count(*) AS n FROM agent_runs WHERE user_id = ?').get(userId) as {
        n: number;
      }
    ).n,
  };
  process.stdout.write(
    `migrated user ${userId} → ${sqlitePath()}\n` +
      `  conversations=${counts.conversations} messages=${counts.messages} runs=${counts.runs}\n` +
      `  (legacy rows: conversations=${conversations.length} messages=${messages.length} runs=${runs.length})\n`,
  );
} finally {
  await store.close();
}
