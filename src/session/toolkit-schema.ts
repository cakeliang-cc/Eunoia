/**
 * SQLite schema for the developer toolkit (ADR 038, version 14).
 *
 * Additive and idempotent. It stores the durable facts the tools need after a
 * restart: fetched web snapshots, long-running jobs, previews, and questions.
 */

export const TOOLKIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS web_documents (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  action_id       TEXT,
  requested_url   TEXT NOT NULL,
  final_url       TEXT NOT NULL,
  status          INTEGER NOT NULL,
  mime_type       TEXT NOT NULL,
  title           TEXT,
  text            TEXT NOT NULL,
  bytes           INTEGER NOT NULL,
  truncated       INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  fetched_at      TEXT NOT NULL,
  sha256          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS web_documents_conversation_idx
  ON web_documents (conversation_id, fetched_at DESC);

CREATE TABLE IF NOT EXISTS dev_jobs (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id         TEXT,
  member_id       TEXT,
  task_id         TEXT NOT NULL,
  tool_call_id    TEXT,
  command         TEXT NOT NULL,
  cwd             TEXT NOT NULL,
  marker          TEXT NOT NULL,
  pid             INTEGER,
  status          TEXT NOT NULL,
  exit_code       INTEGER,
  stdout_path     TEXT NOT NULL,
  stderr_path     TEXT NOT NULL,
  stdin_fifo      TEXT,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  expires_at      TEXT,
  error           TEXT
);

CREATE INDEX IF NOT EXISTS dev_jobs_conversation_idx
  ON dev_jobs (conversation_id, started_at DESC);
CREATE INDEX IF NOT EXISTS dev_jobs_status_idx ON dev_jobs (status, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS dev_jobs_call_idx
  ON dev_jobs (user_id, conversation_id, tool_call_id)
  WHERE tool_call_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS dev_previews (
  id              TEXT PRIMARY KEY,
  job_id          TEXT NOT NULL REFERENCES dev_jobs(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  port            INTEGER NOT NULL,
  status          TEXT NOT NULL,
  url             TEXT,
  ready_at        TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS dev_previews_conversation_idx
  ON dev_previews (conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_questions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id         TEXT,
  call_id         TEXT,
  member_id       TEXT,
  generation      INTEGER NOT NULL,
  prompt          TEXT NOT NULL,
  schema_json     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'answered', 'cancelled', 'expired')),
  answer_json     TEXT,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  answered_at     TEXT
);

CREATE INDEX IF NOT EXISTS user_questions_pending_idx
  ON user_questions (conversation_id, status, created_at);
CREATE INDEX IF NOT EXISTS user_questions_user_idx
  ON user_questions (user_id, created_at DESC);
`;
