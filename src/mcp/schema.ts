/**
 * SQLite schema for the MCP host (ADR 033, schema version 11).
 *
 * Additive and idempotent, like versions 8–10: an interrupted migration can run
 * again, and a fresh database gets the same tables from the base schema.
 *
 * The tables store facts that must survive a restart *and* remain honest about
 * what did not: a call that was sent and never answered keeps a null conclusion,
 * an unknown conclusion, and one row. Nothing here has a default that pretends
 * an action succeeded.
 */

export const MCP_SCHEMA = `
-- One configured server. The full validated configuration is JSON: its shape is
-- versioned by the application (McpServerConfig), not by columns, so a new
-- optional field does not require a table rewrite.
CREATE TABLE IF NOT EXISTS mcp_servers (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  required        INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0, 1)),
  transport       TEXT NOT NULL CHECK (transport IN ('stdio', 'http')),
  config          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT '{}',
  config_revision INTEGER NOT NULL CHECK (config_revision >= 1),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS mcp_servers_user_idx
  ON mcp_servers (user_id, updated_at DESC);

-- One snapshot per authentication identity. An account change writes a new
-- row rather than overwriting the old one, so a late reply from the old
-- identity cannot replace the catalog the current account is using.
CREATE TABLE IF NOT EXISTS mcp_catalogs (
  server_id       TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  identity        TEXT NOT NULL,
  revision        TEXT NOT NULL,
  snapshot        TEXT NOT NULL,
  fetched_at      TEXT NOT NULL,
  invalidated_at  TEXT,
  invalid_reason  TEXT,
  PRIMARY KEY (server_id, identity)
);

CREATE INDEX IF NOT EXISTS mcp_catalogs_user_idx ON mcp_catalogs (user_id);

-- One row per tool call the host prepared. state/conclusion are separate on
-- purpose: "the local turn is over" is not "the remote side did not act".
CREATE TABLE IF NOT EXISTS mcp_actions (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id           TEXT,
  step              INTEGER,
  call_id           TEXT NOT NULL,
  server_id         TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  identity          TEXT NOT NULL,
  catalog_revision  TEXT NOT NULL,
  contract_hash     TEXT NOT NULL,
  tool_name         TEXT NOT NULL,
  arguments_json    TEXT NOT NULL,
  arguments_digest  TEXT NOT NULL,
  classification    TEXT NOT NULL,
  state             TEXT NOT NULL,
  conclusion        TEXT,
  error             TEXT,
  result_json       TEXT,
  sent_at           TEXT,
  finished_at       TEXT,
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS mcp_actions_user_idx
  ON mcp_actions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mcp_actions_conversation_idx
  ON mcp_actions (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS mcp_actions_server_idx
  ON mcp_actions (server_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mcp_actions_state_idx
  ON mcp_actions (state, created_at);

-- A pending approval or elicitation. resume_key is UNIQUE: a double click, a
-- retried request or two tabs cannot execute the same action twice.
CREATE TABLE IF NOT EXISTS mcp_interactions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id         TEXT,
  action_id       TEXT REFERENCES mcp_actions(id) ON DELETE SET NULL,
  server_id       TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('approval', 'elicitation')),
  status          TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected',
                                                   'cancelled', 'expired')),
  summary         TEXT NOT NULL,
  payload         TEXT NOT NULL DEFAULT '{}',
  resume_key      TEXT NOT NULL UNIQUE,
  expires_at      TEXT NOT NULL,
  response        TEXT,
  created_at      TEXT NOT NULL,
  resolved_at     TEXT
);

CREATE INDEX IF NOT EXISTS mcp_interactions_pending_idx
  ON mcp_interactions (conversation_id, status, created_at);
CREATE INDEX IF NOT EXISTS mcp_interactions_user_idx
  ON mcp_interactions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mcp_interactions_action_idx
  ON mcp_interactions (action_id);

-- A remote task handle. The remote id is never enough to address a task: every
-- lookup is scoped by owner and server, so one account cannot poll another's.
CREATE TABLE IF NOT EXISTS mcp_tasks (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  server_id        TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  action_id        TEXT REFERENCES mcp_actions(id) ON DELETE SET NULL,
  remote_task_id   TEXT NOT NULL,
  identity         TEXT NOT NULL,
  status           TEXT NOT NULL,
  poll_interval_ms INTEGER NOT NULL,
  ttl_ms           INTEGER,
  deadline_at      TEXT,
  last_checked_at  TEXT,
  result_json      TEXT,
  error            TEXT,
  created_at       TEXT NOT NULL,
  UNIQUE (server_id, identity, remote_task_id)
);

CREATE INDEX IF NOT EXISTS mcp_tasks_user_idx ON mcp_tasks (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mcp_tasks_poll_idx ON mcp_tasks (status, last_checked_at);

-- Sealed secrets only. The application key is never in this file; without it a
-- row is undecryptable, which is the honest state after a backup restore.
CREATE TABLE IF NOT EXISTS mcp_credentials (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_id   TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  sealed      TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  aad         TEXT NOT NULL,
  scope       TEXT,
  account     TEXT,
  expires_at  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (server_id, kind)
);

CREATE INDEX IF NOT EXISTS mcp_credentials_user_idx ON mcp_credentials (user_id);

-- Which servers a conversation may use. A missing row means "not enabled here",
-- not "all servers": the binding is an allow list.
CREATE TABLE IF NOT EXISTS mcp_conversation_servers (
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  server_id       TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (conversation_id, server_id)
);

CREATE INDEX IF NOT EXISTS mcp_conversation_servers_server_idx
  ON mcp_conversation_servers (server_id);

-- A resource's content at the moment the person selected it. The model history
-- keeps this snapshot even after the server says the resource changed.
CREATE TABLE IF NOT EXISTS mcp_resource_snapshots (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  server_id       TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  uri             TEXT NOT NULL,
  identity        TEXT NOT NULL,
  mime_type       TEXT,
  text            TEXT,
  blob_key        TEXT,
  bytes           INTEGER NOT NULL,
  sha256          TEXT NOT NULL,
  fetched_at      TEXT NOT NULL,
  expires_at      TEXT,
  invalidated_at  TEXT
);

CREATE INDEX IF NOT EXISTS mcp_resource_snapshots_conversation_idx
  ON mcp_resource_snapshots (conversation_id, fetched_at DESC);

-- Non-image binary results. Kept out of media_assets on purpose: they have no
-- width, height or decodable pixels, and pretending otherwise would put a
-- guessed aspect ratio into the image budget.
CREATE TABLE IF NOT EXISTS mcp_artifacts (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  action_id       TEXT REFERENCES mcp_actions(id) ON DELETE SET NULL,
  mime_type       TEXT NOT NULL,
  bytes           INTEGER NOT NULL CHECK (bytes >= 0),
  sha256          TEXT NOT NULL,
  storage_key     TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS mcp_artifacts_conversation_idx
  ON mcp_artifacts (conversation_id, created_at DESC);
`;
