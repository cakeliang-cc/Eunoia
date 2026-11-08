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
import { MCP_SCHEMA } from '../mcp/schema.ts';
import { CHANGESET_SCHEMA } from '../session/changeset-schema.ts';
import { TOOLKIT_SCHEMA } from '../session/toolkit-schema.ts';
import { TEAM_SCHEMA } from '../teams/schema.ts';

/**
 * Version 2 adds the sandbox platform's tables (ADR 017); version 3 records the
 * resource profile on each sandbox so recovery rebuilds with the same limits;
 * version 4 adds the permission layer (ADR 020) and `sandboxes.config_digest`;
 * version 5 adds the task-scoped working directory (ADR 021): cwd columns on
 * `sandbox_tasks`, `cwd_version` on `executions` and `task_cwd_operations`;
 * version 6 adds the foreign-key and hot-query indexes that were missing from
 * the first schema (`messages(user_id, created_at)`, `memories(user_id,
 * updated_at)`, and the cascade columns on `agent_runs`, `message_feedback` and
 * `evaluation_results`). Without them `historyStats` scanned `messages` twice
 * per turn and `EXPLAIN QUERY PLAN` showed `SCAN agent_runs` on user deletion;
 * version 7 adds interrupt-and-continue: `messages.interrupted` marks a reply
 * the person stopped mid-generation, and `agent_runs.status` accepts
 * `'interrupted'` so a stopped turn is not counted as a failure. A CHECK
 * constraint cannot be altered in SQLite, so that half of version 7 rebuilds
 * the table (`migrateToVersion7`); version 8 adds turn admission and execution
 * history: `turn_requests` (one running row per conversation, plus the request
 * digest an idempotent retry is answered from), `turn_events` (tool calls
 * written before they run, results written after), and `agent_runs.finish_reason`
 * so a completed row can say *how* it completed. Version 8 only adds tables and
 * one nullable column, so it needs no table rebuild; version 9 adds multimodal
 * content: `messages.content_parts` (the versioned block list, nullable for old
 * rows), `media_assets` (private immutable images plus their derived variants)
 * and `message_assets` (the ordered reference join). Version 9 is additive and
 * idempotent, so an interrupted migration can be run again.
 * Version 10 adds the persistent model transcript: `model_epochs` (a frozen
 * prompt/tool/provider interval), `model_items` (immutable ordered replay
 * entries), `model_steps` (one row per request attempt with ordered input and
 * output item ids and per-request usage) and `model_context_state` (the
 * background-block comparison baseline). It also adds `turn_requests.turn_usage`
 * so a turn can report summed step usage without pretending it is a bill.
 * Version 10 is additive and idempotent.
 * Version 11 adds the MCP host: server configuration, identity-scoped catalog
 * snapshots, prepared/sent tool actions, approval and elicitation interactions,
 * remote task handles, sealed credentials, conversation bindings, resource
 * snapshots and non-image artifacts. It is additive and idempotent (ADR 033).
 * Version 13 adds user-operable turn undo: `workspace_changesets` (one per
 * durable turn, with the digests around it and an optional checkpoint) and
 * `workspace_changeset_files` (per-file before/after facts and whether the file
 * has been restored). Version 14 adds the developer toolkit's durable facts.
 * Version 15 adds the Agent Team/Subagent domain: teams, runs, members,
 * activations, tasks, attempts, messages, artifacts, events, the whole-team
 * budget ledger and image resource grants. It is numbered 15 because 12 was
 * used by the parallel team branch before the branches were unified; reusing a
 * version number would make a database stamped by one build silently skip the
 * other DDL.
 * The base schema is idempotent, so a version-1 file gets the tables by executing
 * the full schema; later files get the new columns by `ALTER TABLE`.
 */
export const SQLITE_SCHEMA_VERSION = 15;

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
  -- Plain-text projection. For a multimodal row this is derived from the text
  -- blocks of content_parts in the same transaction; it is never a second source
  -- of truth a client can write independently.
  content         TEXT NOT NULL,
  -- Versioned ordered content blocks (UserContentV1). NULL is an old row and is
  -- deterministically interpreted as one text block.
  content_parts   TEXT,
  interrupted     INTEGER NOT NULL DEFAULT 0 CHECK (interrupted IN (0, 1)),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  token_estimate  INTEGER,
  seq             INTEGER NOT NULL,
  UNIQUE (conversation_id, seq)
);

CREATE INDEX IF NOT EXISTS messages_conversation_time_idx
  ON messages (conversation_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS messages_conversation_seq_idx
  ON messages (conversation_id, seq);
-- historyStats counts and time-bounds a user's messages every turn; without
-- the leading user_id column that is a full table scan.
CREATE INDEX IF NOT EXISTS messages_user_time_idx
  ON messages (user_id, created_at);

-- Private, immutable image assets. The original bytes are never rewritten; the
-- normalized and request variants are separate, versioned rows of facts. A
-- client only ever receives the opaque id.
CREATE TABLE IF NOT EXISTS media_assets (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id     TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  media_type          TEXT NOT NULL CHECK (media_type IN ('image/jpeg', 'image/png', 'image/webp')),
  bytes               INTEGER NOT NULL CHECK (bytes > 0),
  width               INTEGER NOT NULL CHECK (width > 0),
  height              INTEGER NOT NULL CHECK (height > 0),
  sha256              TEXT NOT NULL,
  storage_key         TEXT NOT NULL,
  normalized_key      TEXT NOT NULL,
  normalized_width    INTEGER NOT NULL CHECK (normalized_width > 0),
  normalized_height   INTEGER NOT NULL CHECK (normalized_height > 0),
  normalized_bytes    INTEGER NOT NULL CHECK (normalized_bytes > 0),
  normalized_sha256   TEXT NOT NULL,
  request_key         TEXT NOT NULL,
  request_width       INTEGER NOT NULL CHECK (request_width > 0),
  request_height      INTEGER NOT NULL CHECK (request_height > 0),
  request_bytes       INTEGER NOT NULL CHECK (request_bytes > 0),
  request_sha256      TEXT NOT NULL,
  processor_version   TEXT NOT NULL,
  policy_revision     TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'bound', 'released')),
  lease_expires_at    TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS media_assets_conversation_idx
  ON media_assets (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS media_assets_user_idx
  ON media_assets (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS media_assets_collect_idx
  ON media_assets (status, created_at);

-- Ordered references. The join is the reference count: an asset with a row here
-- is in at least one message and may not be released as a draft.
CREATE TABLE IF NOT EXISTS message_assets (
  message_id      TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  asset_id        TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  position        INTEGER NOT NULL CHECK (position >= 0),
  -- Position, not asset id, is the key: one image may legitimately appear twice
  -- in a message, and both occurrences are separate visual inputs.
  PRIMARY KEY (message_id, position)
);

CREATE INDEX IF NOT EXISTS message_assets_asset_idx ON message_assets (asset_id);
CREATE INDEX IF NOT EXISTS message_assets_conversation_idx
  ON message_assets (conversation_id);

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
-- Retrieval lists a user's most recently updated memories before scoring them.
-- Without this the query uses an arbitrary user_id index and sorts every row in
-- a temp B-tree (USE TEMP B-TREE FOR ORDER BY in EXPLAIN QUERY PLAN).
CREATE INDEX IF NOT EXISTS memories_user_updated_idx
  ON memories (user_id, updated_at DESC);

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
                       CHECK (status IN ('running', 'completed', 'failed', 'safety_replaced',
                                         'interrupted')),
  used_tools         INTEGER NOT NULL DEFAULT 0,
  tool_calls         TEXT NOT NULL DEFAULT '[]',
  input_fingerprint  TEXT,
  output_fingerprint TEXT,
  risk_level         TEXT CHECK (risk_level IN ('none', 'elevated', 'crisis')),
  -- How the turn ended: completed / cancelled / incomplete_stream /
  -- loop_exhausted / budget_exhausted / failed / crashed (ADR 029). The status
  -- column says which class of outcome it was; this says why.
  finish_reason      TEXT,
  error              TEXT
);

CREATE INDEX IF NOT EXISTS agent_runs_time_idx ON agent_runs (started_at DESC);
-- Both columns are ON DELETE SET NULL. SQLite only uses an index for that
-- lookup when one exists, so deleting a person scanned this table.
CREATE INDEX IF NOT EXISTS agent_runs_user_idx ON agent_runs (user_id);
CREATE INDEX IF NOT EXISTS agent_runs_conversation_idx ON agent_runs (conversation_id);

-- One execution of a turn, from admission to outcome. The partial unique index
-- *is* the conversation lock: two requests can both read "no running turn" and
-- still only one INSERT succeeds, which a SELECT-then-INSERT in application code
-- cannot promise. The request digest is what makes a client retry idempotent.
CREATE TABLE IF NOT EXISTS turn_requests (
  id              TEXT PRIMARY KEY,
  turn_id         TEXT NOT NULL,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  request_hash    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running', 'completed', 'interrupted', 'failed')),
  finish_reason   TEXT,
  reply           TEXT NOT NULL DEFAULT '',
  message_id      TEXT,
  error           TEXT,
  model           TEXT,
  steps           INTEGER NOT NULL DEFAULT 0,
  context_tokens  INTEGER,
  accepted        INTEGER,
  acceptance      TEXT NOT NULL DEFAULT '[]',
  -- Actual provider usage for the last request of the turn, as JSON. NULL means
  -- no usage was observed, which is not the same as zero. Image-token detail is
  -- not split by the provider and is marked unknown rather than inferred.
  usage           TEXT,
  -- Summed known usage across every attempt of the turn, with measuredSteps /
  -- totalSteps / incomplete. Separate from usage on purpose: last request and
  -- whole turn are different numbers (ADR 032).
  turn_usage      TEXT,
  started_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at        TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS turn_requests_active_idx
  ON turn_requests (conversation_id) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS turn_requests_user_idx
  ON turn_requests (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS turn_requests_conversation_idx
  ON turn_requests (conversation_id, started_at DESC);

-- What the model asked for and what came back, in order. A tool call is written
-- before it runs and its result after, so a crash leaves a call with no result
-- rather than nothing at all. UNKNOWN is a terminal status here: it records
-- that nobody observed the outcome, which is the honest answer after a crash.
CREATE TABLE IF NOT EXISTS turn_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id         TEXT NOT NULL REFERENCES turn_requests(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('tool_call', 'tool_result', 'assistant_text')),
  call_id         TEXT,
  tool_name       TEXT,
  status          TEXT NOT NULL CHECK (status IN ('requested', 'running', 'succeeded',
                                                  'failed', 'unknown')),
  execution_id    TEXT,
  payload         TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (turn_id, seq)
);

CREATE INDEX IF NOT EXISTS turn_events_turn_idx ON turn_events (turn_id, seq);

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
CREATE INDEX IF NOT EXISTS evaluation_results_case_idx ON evaluation_results (case_id);

-- ------------------------------------------------------- model transcript ---
-- One frozen replay interval. Ordinary turns append inside it; compaction, a
-- model/provider/prompt/tool change or an explicit recovery boundary starts a
-- new epoch and leaves the old one readable for audit.
CREATE TABLE IF NOT EXISTS model_epochs (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  parent_epoch_id   TEXT REFERENCES model_epochs(id) ON DELETE SET NULL,
  reason            TEXT NOT NULL,
  instructions      TEXT NOT NULL,
  prompt_version    TEXT NOT NULL,
  tools             TEXT NOT NULL DEFAULT '[]',
  tools_hash        TEXT NOT NULL,
  provider_id       TEXT NOT NULL,
  model_id          TEXT NOT NULL,
  protocol_revision TEXT NOT NULL,
  encoder_revision  TEXT NOT NULL,
  window_item_ids   TEXT NOT NULL DEFAULT '[]',
  window_revision   INTEGER NOT NULL DEFAULT 0,
  seeded_through_seq INTEGER NOT NULL DEFAULT 0,
  active            INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at        TEXT NOT NULL,
  ended_at          TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS model_epochs_active_idx
  ON model_epochs (conversation_id) WHERE active = 1;
CREATE INDEX IF NOT EXISTS model_epochs_conversation_idx
  ON model_epochs (conversation_id, created_at);

-- Immutable ordered entries. idempotency_key is what makes a retried step
-- append nothing; seq is the conversation-wide order a window references.
CREATE TABLE IF NOT EXISTS model_items (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  epoch_id        TEXT NOT NULL REFERENCES model_epochs(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_id      TEXT,
  turn_id         TEXT,
  step            INTEGER,
  kind            TEXT NOT NULL,
  source          TEXT NOT NULL,
  scope           TEXT NOT NULL,
  content_version TEXT NOT NULL,
  payload         TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  message_id      TEXT,
  call_id         TEXT,
  status          TEXT NOT NULL DEFAULT 'complete',
  created_at      TEXT NOT NULL,
  UNIQUE (conversation_id, idempotency_key),
  UNIQUE (conversation_id, seq)
);

CREATE INDEX IF NOT EXISTS model_items_epoch_idx
  ON model_items (epoch_id, seq);
CREATE INDEX IF NOT EXISTS model_items_message_idx
  ON model_items (conversation_id, message_id);
CREATE INDEX IF NOT EXISTS model_items_request_idx
  ON model_items (request_id, step);

-- One request attempt. Unknown usage stays NULL; the status distinguishes a
-- local preparation from a provider acknowledgement.
CREATE TABLE IF NOT EXISTS model_steps (
  attempt_id            TEXT PRIMARY KEY,
  request_id            TEXT NOT NULL,
  turn_id               TEXT NOT NULL,
  conversation_id       TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  step                  INTEGER NOT NULL,
  attempt_no            INTEGER NOT NULL,
  epoch_id              TEXT NOT NULL REFERENCES model_epochs(id) ON DELETE CASCADE,
  epoch_revision        INTEGER NOT NULL,
  input_item_ids        TEXT NOT NULL DEFAULT '[]',
  output_item_ids       TEXT NOT NULL DEFAULT '[]',
  request_config_digest TEXT NOT NULL,
  projection            TEXT,
  status                TEXT NOT NULL,
  response_id           TEXT,
  usage                 TEXT,
  error                 TEXT,
  finish_reason         TEXT,
  created_at            TEXT NOT NULL,
  completed_at          TEXT,
  UNIQUE (request_id, step, attempt_no)
);

CREATE INDEX IF NOT EXISTS model_steps_request_idx ON model_steps (request_id, step);
CREATE INDEX IF NOT EXISTS model_steps_conversation_idx
  ON model_steps (conversation_id, created_at DESC);

-- The block baseline the active window has incorporated. cleared = 1 is a
-- real state: an explicit tombstone that later re-activation must supersede.
CREATE TABLE IF NOT EXISTS model_context_state (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  epoch_id        TEXT NOT NULL REFERENCES model_epochs(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  scope           TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  render_version  TEXT NOT NULL,
  revision        INTEGER NOT NULL,
  latest_item_id  TEXT NOT NULL,
  cleared         INTEGER NOT NULL DEFAULT 0 CHECK (cleared IN (0, 1)),
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (epoch_id, key)
);

CREATE INDEX IF NOT EXISTS model_context_state_conversation_idx
  ON model_context_state (conversation_id, epoch_id);

${SANDBOX_SCHEMA}

${MCP_SCHEMA}

${CHANGESET_SCHEMA}

${TOOLKIT_SCHEMA}

${TEAM_SCHEMA}
`;

/** Applied to a version-2 database that already has the sandbox tables. */
export const SQLITE_MIGRATION_3 = `
ALTER TABLE sandboxes ADD COLUMN resource_profile TEXT NOT NULL DEFAULT 'default';
`;

/**
 * Version 5 → 6: the hot-query and cascade indexes.
 *
 * Only indexes, so this is safe to re-run and safe to interrupt; `IF NOT EXISTS`
 * also makes it a no-op for a database created from the current base schema.
 */
export const SQLITE_MIGRATION_6 = `
CREATE INDEX IF NOT EXISTS messages_user_time_idx
  ON messages (user_id, created_at);

-- Private, immutable image assets. The original bytes are never rewritten; the
-- normalized and request variants are separate, versioned rows of facts. A
-- client only ever receives the opaque id.
CREATE TABLE IF NOT EXISTS media_assets (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id     TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  media_type          TEXT NOT NULL CHECK (media_type IN ('image/jpeg', 'image/png', 'image/webp')),
  bytes               INTEGER NOT NULL CHECK (bytes > 0),
  width               INTEGER NOT NULL CHECK (width > 0),
  height              INTEGER NOT NULL CHECK (height > 0),
  sha256              TEXT NOT NULL,
  storage_key         TEXT NOT NULL,
  normalized_key      TEXT NOT NULL,
  normalized_width    INTEGER NOT NULL CHECK (normalized_width > 0),
  normalized_height   INTEGER NOT NULL CHECK (normalized_height > 0),
  normalized_bytes    INTEGER NOT NULL CHECK (normalized_bytes > 0),
  normalized_sha256   TEXT NOT NULL,
  request_key         TEXT NOT NULL,
  request_width       INTEGER NOT NULL CHECK (request_width > 0),
  request_height      INTEGER NOT NULL CHECK (request_height > 0),
  request_bytes       INTEGER NOT NULL CHECK (request_bytes > 0),
  request_sha256      TEXT NOT NULL,
  processor_version   TEXT NOT NULL,
  policy_revision     TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'bound', 'released')),
  lease_expires_at    TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS media_assets_conversation_idx
  ON media_assets (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS media_assets_user_idx
  ON media_assets (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS media_assets_collect_idx
  ON media_assets (status, created_at);

-- Ordered references. The join is the reference count: an asset with a row here
-- is in at least one message and may not be released as a draft.
CREATE TABLE IF NOT EXISTS message_assets (
  message_id      TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  asset_id        TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  position        INTEGER NOT NULL CHECK (position >= 0),
  -- Position, not asset id, is the key: one image may legitimately appear twice
  -- in a message, and both occurrences are separate visual inputs.
  PRIMARY KEY (message_id, position)
);

CREATE INDEX IF NOT EXISTS message_assets_asset_idx ON message_assets (asset_id);
CREATE INDEX IF NOT EXISTS message_assets_conversation_idx
  ON message_assets (conversation_id);
CREATE INDEX IF NOT EXISTS memories_user_updated_idx
  ON memories (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS agent_runs_user_idx ON agent_runs (user_id);
CREATE INDEX IF NOT EXISTS agent_runs_conversation_idx ON agent_runs (conversation_id);
CREATE INDEX IF NOT EXISTS evaluation_results_case_idx ON evaluation_results (case_id);
`;

/**
 * Version 7 → 8: turn admission and execution history.
 *
 * Additive only. `IF NOT EXISTS` makes the tables a no-op for a database created
 * from the current base schema, and the one column is added by the caller after
 * a `PRAGMA table_info` check, because SQLite has no `ADD COLUMN IF NOT EXISTS`.
 */
export const SQLITE_MIGRATION_8 = `
CREATE TABLE IF NOT EXISTS turn_requests (
  id              TEXT PRIMARY KEY,
  turn_id         TEXT NOT NULL,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  request_hash    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running', 'completed', 'interrupted', 'failed')),
  finish_reason   TEXT,
  reply           TEXT NOT NULL DEFAULT '',
  message_id      TEXT,
  error           TEXT,
  model           TEXT,
  steps           INTEGER NOT NULL DEFAULT 0,
  context_tokens  INTEGER,
  accepted        INTEGER,
  acceptance      TEXT NOT NULL DEFAULT '[]',
  started_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at        TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS turn_requests_active_idx
  ON turn_requests (conversation_id) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS turn_requests_user_idx
  ON turn_requests (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS turn_requests_conversation_idx
  ON turn_requests (conversation_id, started_at DESC);

CREATE TABLE IF NOT EXISTS turn_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id         TEXT NOT NULL REFERENCES turn_requests(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('tool_call', 'tool_result', 'assistant_text')),
  call_id         TEXT,
  tool_name       TEXT,
  status          TEXT NOT NULL CHECK (status IN ('requested', 'running', 'succeeded',
                                                  'failed', 'unknown')),
  execution_id    TEXT,
  payload         TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (turn_id, seq)
);

CREATE INDEX IF NOT EXISTS turn_events_turn_idx ON turn_events (turn_id, seq);
`;


/**
 * Version 8 → 9: multimodal messages and private media.
 *
 * Additive only. The media tables are `IF NOT EXISTS`, and the message column is
 * added by the caller after a `PRAGMA table_info` check because SQLite has no
 * `ADD COLUMN IF NOT EXISTS`. The base schema already carries both, so a fresh
 * database applies this migration as a no-op.
 */
export const SQLITE_MIGRATION_9 = `
CREATE TABLE IF NOT EXISTS media_assets (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id     TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  media_type          TEXT NOT NULL CHECK (media_type IN ('image/jpeg', 'image/png', 'image/webp')),
  bytes               INTEGER NOT NULL CHECK (bytes > 0),
  width               INTEGER NOT NULL CHECK (width > 0),
  height              INTEGER NOT NULL CHECK (height > 0),
  sha256              TEXT NOT NULL,
  storage_key         TEXT NOT NULL,
  normalized_key      TEXT NOT NULL,
  normalized_width    INTEGER NOT NULL CHECK (normalized_width > 0),
  normalized_height   INTEGER NOT NULL CHECK (normalized_height > 0),
  normalized_bytes    INTEGER NOT NULL CHECK (normalized_bytes > 0),
  normalized_sha256   TEXT NOT NULL,
  request_key         TEXT NOT NULL,
  request_width       INTEGER NOT NULL CHECK (request_width > 0),
  request_height      INTEGER NOT NULL CHECK (request_height > 0),
  request_bytes       INTEGER NOT NULL CHECK (request_bytes > 0),
  request_sha256      TEXT NOT NULL,
  processor_version   TEXT NOT NULL,
  policy_revision     TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'bound', 'released')),
  lease_expires_at    TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS media_assets_conversation_idx
  ON media_assets (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS media_assets_user_idx
  ON media_assets (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS media_assets_collect_idx
  ON media_assets (status, created_at);

CREATE TABLE IF NOT EXISTS message_assets (
  message_id      TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  asset_id        TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  position        INTEGER NOT NULL CHECK (position >= 0),
  -- Position, not asset id, is the key: one image may legitimately appear twice
  -- in a message, and both occurrences are separate visual inputs.
  PRIMARY KEY (message_id, position)
);

CREATE INDEX IF NOT EXISTS message_assets_asset_idx ON message_assets (asset_id);
CREATE INDEX IF NOT EXISTS message_assets_conversation_idx
  ON message_assets (conversation_id);
`;

/**
 * Version 9 → 10: the persistent model transcript.
 *
 * Additive and idempotent. `turn_requests.turn_usage` is added by the caller
 * after a `PRAGMA table_info` check, because SQLite has no
 * `ADD COLUMN IF NOT EXISTS`; everything else is `IF NOT EXISTS` DDL.
 */
export const SQLITE_MIGRATION_10 = `
CREATE TABLE IF NOT EXISTS model_epochs (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  parent_epoch_id   TEXT REFERENCES model_epochs(id) ON DELETE SET NULL,
  reason            TEXT NOT NULL,
  instructions      TEXT NOT NULL,
  prompt_version    TEXT NOT NULL,
  tools             TEXT NOT NULL DEFAULT '[]',
  tools_hash        TEXT NOT NULL,
  provider_id       TEXT NOT NULL,
  model_id          TEXT NOT NULL,
  protocol_revision TEXT NOT NULL,
  encoder_revision  TEXT NOT NULL,
  window_item_ids   TEXT NOT NULL DEFAULT '[]',
  window_revision   INTEGER NOT NULL DEFAULT 0,
  seeded_through_seq INTEGER NOT NULL DEFAULT 0,
  active            INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at        TEXT NOT NULL,
  ended_at          TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS model_epochs_active_idx
  ON model_epochs (conversation_id) WHERE active = 1;
CREATE INDEX IF NOT EXISTS model_epochs_conversation_idx
  ON model_epochs (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS model_items (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  epoch_id        TEXT NOT NULL REFERENCES model_epochs(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_id      TEXT,
  turn_id         TEXT,
  step            INTEGER,
  kind            TEXT NOT NULL,
  source          TEXT NOT NULL,
  scope           TEXT NOT NULL,
  content_version TEXT NOT NULL,
  payload         TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  message_id      TEXT,
  call_id         TEXT,
  status          TEXT NOT NULL DEFAULT 'complete',
  created_at      TEXT NOT NULL,
  UNIQUE (conversation_id, idempotency_key),
  UNIQUE (conversation_id, seq)
);

CREATE INDEX IF NOT EXISTS model_items_epoch_idx
  ON model_items (epoch_id, seq);
CREATE INDEX IF NOT EXISTS model_items_message_idx
  ON model_items (conversation_id, message_id);
CREATE INDEX IF NOT EXISTS model_items_request_idx
  ON model_items (request_id, step);

CREATE TABLE IF NOT EXISTS model_steps (
  attempt_id            TEXT PRIMARY KEY,
  request_id            TEXT NOT NULL,
  turn_id               TEXT NOT NULL,
  conversation_id       TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  step                  INTEGER NOT NULL,
  attempt_no            INTEGER NOT NULL,
  epoch_id              TEXT NOT NULL REFERENCES model_epochs(id) ON DELETE CASCADE,
  epoch_revision        INTEGER NOT NULL,
  input_item_ids        TEXT NOT NULL DEFAULT '[]',
  output_item_ids       TEXT NOT NULL DEFAULT '[]',
  request_config_digest TEXT NOT NULL,
  projection            TEXT,
  status                TEXT NOT NULL,
  response_id           TEXT,
  usage                 TEXT,
  error                 TEXT,
  finish_reason         TEXT,
  created_at            TEXT NOT NULL,
  completed_at          TEXT,
  UNIQUE (request_id, step, attempt_no)
);

CREATE INDEX IF NOT EXISTS model_steps_request_idx ON model_steps (request_id, step);
CREATE INDEX IF NOT EXISTS model_steps_conversation_idx
  ON model_steps (conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS model_context_state (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  epoch_id        TEXT NOT NULL REFERENCES model_epochs(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  scope           TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  render_version  TEXT NOT NULL,
  revision        INTEGER NOT NULL,
  latest_item_id  TEXT NOT NULL,
  cleared         INTEGER NOT NULL DEFAULT 0 CHECK (cleared IN (0, 1)),
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (epoch_id, key)
);

CREATE INDEX IF NOT EXISTS model_context_state_conversation_idx
  ON model_context_state (conversation_id, epoch_id);
`;

/**
 * Version 10 → 11: the MCP host tables.
 *
 * Additive and idempotent, so an interrupted migration can be re-run. A fresh
 * database applies this as a no-op because the base schema already carries the
 * same DDL.
 */
export const SQLITE_MIGRATION_11 = MCP_SCHEMA;

/**
 * Version 12 → 13: turn-scoped workspace change sets.
 *
 * Additive and idempotent; the base schema already carries the same DDL.
 */
export const SQLITE_MIGRATION_13 = CHANGESET_SCHEMA;

/**
 * Version 13 → 14: the developer toolkit's durable facts.
 *
 * Additive and idempotent; the base schema carries the same DDL.
 */
export const SQLITE_MIGRATION_14 = TOOLKIT_SCHEMA;

/**
 * Version 14 → 15: the Agent Team tables.
 *
 * Additive and idempotent; the base schema carries the same DDL.
 */
export const SQLITE_MIGRATION_15 = TEAM_SCHEMA;
