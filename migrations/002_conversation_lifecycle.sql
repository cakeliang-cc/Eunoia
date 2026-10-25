-- 002_conversation_lifecycle.sql
--
-- Archive is a state, not a delete. A conversation that is put away keeps its
-- messages and can be restored; deleting it is a separate, destructive action
-- with its own endpoint. Keeping `archived_at` nullable rather than a boolean
-- records *when* it happened, which is the only fact a later retention sweep
-- would need.

ALTER TABLE conversations ADD COLUMN archived_at timestamptz;

-- The history list is "this user's active conversations, newest first". The
-- existing index covers the user and recency but not the archive filter, so the
-- planner would read archived rows and discard them.
CREATE INDEX conversations_user_archived_idx
  ON conversations (user_id, archived_at);
