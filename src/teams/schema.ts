/**
 * The SQL for the Agent Team persistence layer.
 *
 * The string is executed by the main SQLite schema, so it has to be safe on a
 * fresh database *and* on one that already has these tables: every statement is
 * `IF NOT EXISTS`, and no `PRAGMA` is touched here. Schema versioning belongs to
 * the database that includes this string, not to this module.
 *
 * ## Representation
 *
 * Same convention as `src/db/sqlite-store.ts`: timestamps are ISO-8601 TEXT,
 * JSON is TEXT, booleans are INTEGER 0/1. Nothing above this layer sees a column
 * name.
 *
 * ## Constraints that carry meaning
 *
 *   - `UNIQUE (owner_id, root_conversation_id, input_hash)` on runs is the
 *     idempotency key for "this exact request already started a run".
 *   - The partial unique index on `team_activations (member_id) WHERE
 *     status = 'running'` is the "one running activation per member" rule. A
 *     partial index is used rather than a table-level constraint because every
 *     other status, including `queued`, must allow many rows.
 *   - `UNIQUE (sender_id, recipient_id, client_message_id)` on messages makes a
 *     retry idempotent without a read-modify-write window.
 *   - `UNIQUE (run_id, sequence)` on events keeps the per-run cursor dense; a
 *     duplicate sequence is a bug, not something to paper over.
 *   - `UNIQUE (run_id, request_key)` on budget entries is the per-request
 *     reservation key.
 */
export const TEAM_SCHEMA = `
CREATE TABLE IF NOT EXISTS teams (
  id                    TEXT PRIMARY KEY,
  owner_id              TEXT NOT NULL,
  root_conversation_id  TEXT NOT NULL,
  enabled               INTEGER NOT NULL DEFAULT 1,
  config_revision       INTEGER NOT NULL DEFAULT 1,
  config_json           TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (owner_id, root_conversation_id)
);

CREATE INDEX IF NOT EXISTS teams_owner_idx
  ON teams (owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS team_runs (
  id                    TEXT PRIMARY KEY,
  team_id               TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  owner_id              TEXT NOT NULL,
  root_conversation_id  TEXT NOT NULL,
  root_turn_id          TEXT NOT NULL,
  root_request_id       TEXT NOT NULL,
  input_hash            TEXT NOT NULL,
  status                TEXT NOT NULL,
  budget_json           TEXT NOT NULL,
  root_member_id        TEXT,
  reason                TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  finished_at           TEXT,
  UNIQUE (owner_id, root_conversation_id, input_hash)
);

CREATE INDEX IF NOT EXISTS team_runs_team_idx
  ON team_runs (team_id, created_at DESC);

CREATE INDEX IF NOT EXISTS team_runs_active_idx
  ON team_runs (owner_id, root_conversation_id, status);

CREATE TABLE IF NOT EXISTS team_members (
  id                        TEXT PRIMARY KEY,
  team_id                   TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  parent_member_id          TEXT,
  internal_conversation_id  TEXT NOT NULL UNIQUE,
  name                      TEXT NOT NULL,
  role                      TEXT NOT NULL,
  depth                     INTEGER NOT NULL,
  status                    TEXT NOT NULL,
  profile_json              TEXT NOT NULL,
  permissions_json          TEXT NOT NULL,
  workspace_id              TEXT,
  workspace_mode            TEXT NOT NULL,
  context_mode              TEXT NOT NULL,
  fork_seq                  INTEGER,
  current_activation_id     TEXT,
  error                     TEXT,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  closed_at                 TEXT
);

CREATE INDEX IF NOT EXISTS team_members_team_idx
  ON team_members (team_id, created_at);

CREATE TABLE IF NOT EXISTS team_activations (
  id                 TEXT PRIMARY KEY,
  run_id             TEXT NOT NULL REFERENCES team_runs (id) ON DELETE CASCADE,
  member_id          TEXT NOT NULL,
  request_id         TEXT NOT NULL,
  generation         INTEGER NOT NULL,
  status             TEXT NOT NULL,
  checkpoint_json    TEXT NOT NULL,
  input_json         TEXT NOT NULL,
  result_json        TEXT,
  error              TEXT,
  created_at         TEXT NOT NULL,
  started_at         TEXT,
  finished_at        TEXT,
  lease_expires_at   TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS team_activations_running_idx
  ON team_activations (member_id) WHERE status = 'running';

CREATE INDEX IF NOT EXISTS team_activations_run_idx
  ON team_activations (run_id, created_at);

CREATE TABLE IF NOT EXISTS team_tasks (
  id                  TEXT PRIMARY KEY,
  team_id             TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  run_id              TEXT NOT NULL REFERENCES team_runs (id) ON DELETE CASCADE,
  revision            INTEGER NOT NULL DEFAULT 1,
  title               TEXT NOT NULL,
  specification       TEXT NOT NULL,
  acceptance          TEXT NOT NULL,
  required            INTEGER NOT NULL DEFAULT 1,
  dependencies_json   TEXT NOT NULL DEFAULT '[]',
  owner_id            TEXT,
  status              TEXT NOT NULL,
  write_scopes_json   TEXT NOT NULL DEFAULT '[]',
  created_by          TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  submitted_at        TEXT,
  accepted_at         TEXT,
  failure_reason      TEXT,
  current_attempt_id  TEXT
);

CREATE INDEX IF NOT EXISTS team_tasks_status_idx
  ON team_tasks (run_id, status);

CREATE INDEX IF NOT EXISTS team_tasks_created_idx
  ON team_tasks (run_id, created_at);

CREATE TABLE IF NOT EXISTS team_task_attempts (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL REFERENCES team_tasks (id) ON DELETE CASCADE,
  activation_id     TEXT,
  generation        INTEGER NOT NULL,
  lease_expires_at  TEXT,
  baseline_id       TEXT,
  submission_json   TEXT,
  review_json       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS team_task_attempts_task_idx
  ON team_task_attempts (task_id, created_at);

CREATE TABLE IF NOT EXISTS team_messages (
  id                 TEXT PRIMARY KEY,
  team_id            TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  run_id             TEXT NOT NULL REFERENCES team_runs (id) ON DELETE CASCADE,
  sender_id          TEXT NOT NULL,
  sender_kind        TEXT NOT NULL,
  recipient_id       TEXT NOT NULL,
  client_message_id  TEXT NOT NULL,
  body               TEXT NOT NULL,
  sequence           INTEGER NOT NULL,
  state              TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  injected_at        TEXT,
  processed_at       TEXT,
  activation_id      TEXT,
  error              TEXT,
  UNIQUE (sender_id, recipient_id, client_message_id)
);

CREATE INDEX IF NOT EXISTS team_messages_run_idx
  ON team_messages (run_id, sequence);

CREATE INDEX IF NOT EXISTS team_messages_recipient_idx
  ON team_messages (recipient_id, state);

CREATE TABLE IF NOT EXISTS team_artifacts (
  id                   TEXT PRIMARY KEY,
  team_id              TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  run_id               TEXT NOT NULL REFERENCES team_runs (id) ON DELETE CASCADE,
  task_id              TEXT,
  attempt_id           TEXT,
  member_id            TEXT NOT NULL,
  kind                 TEXT NOT NULL,
  manifest_json        TEXT NOT NULL,
  test_evidence_json   TEXT NOT NULL DEFAULT '[]',
  created_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS team_artifacts_run_idx
  ON team_artifacts (run_id, created_at);

CREATE TABLE IF NOT EXISTS team_events (
  id                TEXT PRIMARY KEY,
  team_id           TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  -- Not a foreign key on purpose: team-scoped events use the literal scope
  -- 'team' instead of a run id, and a synthetic scope must not need a fake run
  -- row. Run-scoped events still carry a real run id.
  run_id            TEXT NOT NULL,
  sequence          INTEGER NOT NULL,
  kind              TEXT NOT NULL,
  payload_json      TEXT NOT NULL DEFAULT '{}',
  idempotency_key   TEXT,
  created_at        TEXT NOT NULL,
  UNIQUE (run_id, sequence)
);

CREATE INDEX IF NOT EXISTS team_events_run_idx
  ON team_events (run_id, sequence);

CREATE TABLE IF NOT EXISTS team_budget_entries (
  id                      TEXT PRIMARY KEY,
  run_id                  TEXT NOT NULL REFERENCES team_runs (id) ON DELETE CASCADE,
  member_id               TEXT NOT NULL,
  activation_id           TEXT,
  request_key             TEXT NOT NULL,
  generation              INTEGER NOT NULL,
  status                  TEXT NOT NULL,
  reserved_input_tokens   INTEGER NOT NULL,
  reserved_output_tokens  INTEGER NOT NULL,
  input_tokens            INTEGER,
  output_tokens           INTEGER,
  cached_tokens           INTEGER,
  estimated_cost_usd      REAL,
  price_version           TEXT,
  created_at              TEXT NOT NULL,
  settled_at              TEXT,
  UNIQUE (run_id, request_key)
);

CREATE INDEX IF NOT EXISTS team_budget_entries_run_idx
  ON team_budget_entries (run_id, created_at);

CREATE TABLE IF NOT EXISTS team_integrations (
  id                 TEXT PRIMARY KEY,
  team_id            TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  run_id             TEXT NOT NULL REFERENCES team_runs (id) ON DELETE CASCADE,
  task_id            TEXT,
  base_version       TEXT NOT NULL,
  candidate_hash     TEXT NOT NULL,
  status             TEXT NOT NULL,
  conflicts_json     TEXT NOT NULL DEFAULT '[]',
  base_hashes_json   TEXT NOT NULL DEFAULT '{}',
  result_hashes_json TEXT NOT NULL DEFAULT '{}',
  verification_json  TEXT,
  journal_json       TEXT NOT NULL DEFAULT '[]',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  published_at       TEXT
);

CREATE INDEX IF NOT EXISTS team_integrations_run_idx
  ON team_integrations (run_id, created_at);
`;
