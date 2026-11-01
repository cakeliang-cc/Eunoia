/**
 * The SQLite schema (ADR 016, replacing ADR 002's Postgres + pgvector).
 *
 * Types are chosen to match the domain, not to imitate Postgres:
 *
 *   - ids are TEXT because the application generates UUIDs and SQLite has no
 *     uuid type; the values are still opaque strings to every caller.
 *   - timestamps are ISO-8601 TEXT in UTC. The driver hands them back as
 *     strings, and the store converts them to `Date` at the row boundary.
 *   - arrays and JSON are TEXT containing JSON. SQLite has no jsonb and no
 *     array type; parsing stays at the store boundary so nothing above sees it.
 *   - booleans are INTEGER 0/1.
 *
 * `PRAGMA user_version` is the schema version. The first store to open a file
 * applies version 1; a future migration adds a step rather than editing this
 * schema in place, because a database already on disk is the one case a
 * CREATE TABLE cannot fix.
 */

import { SANDBOX_SCHEMA } from '../sandbox/schema.ts';

/**
 * Version 2 adds the sandbox platform's tables (ADR 017); version 3 records the
 * resource profile on each sandbox so recovery rebuilds with the same limits.
 * The base schema is idempotent, so a version-1 file gets the tables by executing
 * the full schema; a version-2 file gets the new column by `ALTER TABLE`.
 */
export const SQLITE_SCHEMA_VERSION = 3;

export const SQLITE_SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  external_id  TEXT UNIQUE,
  display_name TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS conversations (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT,
  started_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_turn_at TEXT,
  turn_count   INTEGER NOT NULL DEFAULT 0,
  archived_at  TEXT,
  model_id     TEXT
);

CREATE INDEX IF NOT EXISTS conversations_user_recent_idx
  ON conversations (user_id, last_turn_at DESC);
CREATE INDEX IF NOT EXISTS conversations_user_archived_idx
  ON conversations (user_id, archived_at);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content         TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  token_estimate  INTEGER,
  seq             INTEGER NOT NULL,
  UNIQUE (conversation_id, seq)
);

CREATE INDEX IF NOT EXISTS messages_conversation_time_idx
  ON messages (conversation_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS messages_conversation_seq_idx
  ON messages (conversation_id, seq);

CREATE TABLE IF NOT EXISTS conversation_summaries (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  summary         TEXT NOT NULL,
  through_seq     INTEGER NOT NULL CHECK (through_seq >= 0),
  summary_tokens  INTEGER NOT NULL CHECK (summary_tokens >= 0),
  model           TEXT NOT NULL,
  prompt_version  TEXT NOT NULL,
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS memories (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type              TEXT NOT NULL CHECK (type IN ('episodic', 'semantic', 'narrative')),
  content           TEXT NOT NULL,
  importance        REAL NOT NULL DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1),
  confidence        REAL NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  source            TEXT NOT NULL CHECK (source IN ('user_explicit', 'user_stated', 'inferred')),
  tags              TEXT NOT NULL DEFAULT '[]',
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'unconfirmed', 'superseded', 'deleted')),
  superseded_by     TEXT REFERENCES memories(id) ON DELETE SET NULL,
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_accessed_at  TEXT,
  access_count      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS memories_user_status_idx ON memories (user_id, status);
CREATE INDEX IF NOT EXISTS memories_user_type_idx   ON memories (user_id, type);
CREATE INDEX IF NOT EXISTS memories_user_importance_idx
  ON memories (user_id, importance DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id  TEXT REFERENCES memories(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action     TEXT NOT NULL CHECK (action IN
               ('created', 'updated', 'superseded', 'deleted', 'retrieved', 'rejected')),
  actor      TEXT NOT NULL DEFAULT 'agent' CHECK (actor IN ('agent', 'user', 'system')),
  reason     TEXT,
  detail     TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS memory_events_user_time_idx ON memory_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS memory_events_memory_idx    ON memory_events (memory_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS message_feedback (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating     TEXT NOT NULL CHECK (rating IN ('good', 'bad')),
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS message_feedback_user_time_idx
  ON message_feedback (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_runs (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT REFERENCES users(id) ON DELETE SET NULL,
  conversation_id    TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  model              TEXT NOT NULL,
  prompt_version     TEXT NOT NULL,
  started_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at           TEXT,
  duration_ms        INTEGER,
  status             TEXT NOT NULL DEFAULT 'running'
                       CHECK (status IN ('running', 'completed', 'failed', 'safety_replaced')),
  used_tools         INTEGER NOT NULL DEFAULT 0,
  tool_calls         TEXT NOT NULL DEFAULT '[]',
  input_fingerprint  TEXT,
  output_fingerprint TEXT,
  risk_level         TEXT CHECK (risk_level IN ('none', 'elevated', 'crisis')),
  error              TEXT
);

CREATE INDEX IF NOT EXISTS agent_runs_time_idx ON agent_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS evaluation_cases (
  id                  TEXT PRIMARY KEY,
  category            TEXT NOT NULL,
  title               TEXT NOT NULL,
  user_message        TEXT NOT NULL,
  expected_behaviors  TEXT NOT NULL DEFAULT '[]',
  forbidden_behaviors TEXT NOT NULL DEFAULT '[]',
  checks              TEXT NOT NULL DEFAULT '[]',
  notes               TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS evaluation_results (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         TEXT NOT NULL,
  case_id        TEXT NOT NULL REFERENCES evaluation_cases(id) ON DELETE CASCADE,
  reply          TEXT,
  passed         INTEGER NOT NULL,
  score          REAL NOT NULL,
  prompt_version TEXT NOT NULL,
  model          TEXT NOT NULL,
  mode           TEXT NOT NULL CHECK (mode IN ('live', 'recorded')),
  violations     TEXT NOT NULL DEFAULT '[]',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS evaluation_results_run_idx ON evaluation_results (run_id);

${SANDBOX_SCHEMA}
`;

/** Applied to a version-2 database that already has the sandbox tables. */
export const SQLITE_MIGRATION_3 = `
ALTER TABLE sandboxes ADD COLUMN resource_profile TEXT NOT NULL DEFAULT 'default';
`;
