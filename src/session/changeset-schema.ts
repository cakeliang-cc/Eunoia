/**
 * SQLite schema for turn-scoped workspace undo (ADR 036, schema version 12).
 *
 * The rows are facts about files, not a copy of them: content is stored only
 * for edits the agent made through the file tools, and command-changed files
 * point at a checkpoint. Deleting a conversation removes its history of undo
 * offers, but never deletes workspace files by itself.
 */

export const CHANGESET_SCHEMA = `
-- One turn's workspace diff. UNIQUE(conversation_id, turn_id) makes a retried
-- turn settle one change set instead of stacking a second one.
CREATE TABLE IF NOT EXISTS workspace_changesets (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id         TEXT NOT NULL,
  workspace_id    TEXT NOT NULL,
  checkpoint_id   TEXT,
  before_digest   TEXT NOT NULL,
  after_digest    TEXT NOT NULL,
  file_count      INTEGER NOT NULL CHECK (file_count >= 0),
  added           INTEGER NOT NULL DEFAULT 0,
  modified        INTEGER NOT NULL DEFAULT 0,
  deleted         INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'available'
                    CHECK (status IN ('available', 'undone', 'partial')),
  created_at      TEXT NOT NULL,
  undone_at       TEXT,
  UNIQUE (conversation_id, turn_id)
);

CREATE INDEX IF NOT EXISTS workspace_changesets_conversation_idx
  ON workspace_changesets (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS workspace_changesets_user_idx
  ON workspace_changesets (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS workspace_changeset_files (
  changeset_id   TEXT NOT NULL REFERENCES workspace_changesets(id) ON DELETE CASCADE,
  path           TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('added', 'modified', 'deleted')),
  before_sha     TEXT,
  after_sha      TEXT,
  before_bytes   INTEGER,
  after_bytes    INTEGER,
  -- The before text for a file the agent wrote/edited. NULL when the before
  -- state is only available from the checkpoint (or not at all).
  before_content TEXT,
  restore_source TEXT NOT NULL CHECK (restore_source IN ('journal', 'checkpoint', 'none')),
  restored       INTEGER NOT NULL DEFAULT 0 CHECK (restored IN (0, 1)),
  PRIMARY KEY (changeset_id, path)
);
`;
