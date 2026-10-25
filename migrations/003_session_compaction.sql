-- 003_session_compaction.sql
--
-- Two additions, both required by the summary checkpoint:
--
--   1. `messages.seq` — a stable per-conversation ordinal. `created_at` ties are
--      possible, and a boundary that says "up to message X" must be unambiguous.
--      The backfill preserves the order the application already used
--      (`created_at, id`), so enabling seq does not reshuffle existing history.
--
--   2. `conversation_summaries` — one rolling checkpoint per conversation.
--      Kept separate from `conversations` so the history list never reads a
--      multi-kilobyte summary to render a title and a timestamp.

ALTER TABLE messages ADD COLUMN seq bigint;

WITH ordered AS (
  SELECT id, row_number() OVER (
    PARTITION BY conversation_id
    ORDER BY created_at, id
  ) AS ordinal
  FROM messages
)
UPDATE messages AS m
   SET seq = ordered.ordinal
  FROM ordered
 WHERE m.id = ordered.id;

ALTER TABLE messages ALTER COLUMN seq SET NOT NULL;

-- Per-conversation ordering and the boundary lookup both use this.
CREATE UNIQUE INDEX messages_conversation_seq_idx
  ON messages (conversation_id, seq);

CREATE TABLE conversation_summaries (
  conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  summary         text NOT NULL,
  through_seq     bigint NOT NULL CHECK (through_seq >= 0),
  summary_tokens  integer NOT NULL CHECK (summary_tokens >= 0),
  model           text NOT NULL,
  prompt_version  text NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
