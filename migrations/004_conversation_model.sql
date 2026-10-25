-- 004_conversation_model.sql
--
-- Model selection belongs to the conversation, not the process. A null value
-- means "inherit the current default"; an explicit id pins that thread so a
-- later global model change does not silently rewrite its context budget.
--
-- No foreign key to a model table: model ids live in code (`src/models`), and a
-- database row should not become the source of truth for what a model can do.

ALTER TABLE conversations ADD COLUMN model_id text;
