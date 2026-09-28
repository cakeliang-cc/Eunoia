-- 001_init.sql — the whole Phase 2 schema.
--
-- Applied migrations are immutable (ADR 002): once this has run against a real
-- database, corrections go in a new numbered file, never as an edit here.
--
-- Three schema notes worth reading before changing anything:
--
--   1. `memories.embedding` is created now, nullable and unused. Embeddings are
--      deferred (ADR 004) but the column and its index exist from migration 1 so
--      that turning similarity on later is a backfill, not a migration.
--   2. The three persisted memory layers share one table with a `type`
--      discriminator (ADR 003). They have identical governance needs —
--      confidence, provenance, supersession, access accounting — and duplicating
--      that across three tables would mean three places to get it wrong.
--   3. Governance columns (`source`, `confidence`, `status`, `superseded_by`)
--      exist to make a memory's *provenance* answerable. A companion that cannot
--      say why it believes something cannot be corrected about it.

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------- users -----

CREATE TABLE users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stable identity from an external system. Becomes the mini-program openid;
  -- until there is real auth this is the only handle we have, and it is
  -- unguessable by construction (see src/api/identity.ts).
  external_id  text UNIQUE,
  display_name text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- -------------------------------------------------------- conversations -----

CREATE TABLE conversations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        text,
  started_at   timestamptz NOT NULL DEFAULT now(),
  last_turn_at timestamptz,
  -- Denormalised turn count so the history list does not need an aggregate over
  -- `messages` on every page load.
  turn_count   integer NOT NULL DEFAULT 0
);

CREATE INDEX conversations_user_recent_idx
  ON conversations (user_id, last_turn_at DESC NULLS LAST);

CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content         text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Rough char/4 estimate. Stored rather than computed so that a future change
  -- to the estimator does not silently rewrite history.
  token_estimate  integer
);

CREATE INDEX messages_conversation_time_idx
  ON messages (conversation_id, created_at);

-- ------------------------------------------------------------- memories -----

CREATE TABLE memories (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- episodic   — something that happened, anchored to a time
  -- semantic   — a durable fact or preference about the person
  -- narrative  — an ongoing story or theme they are living through
  type              text NOT NULL CHECK (type IN ('episodic', 'semantic', 'narrative')),

  content           text NOT NULL,

  -- How much this matters to the person, independent of when it was said.
  importance        real NOT NULL DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1),
  -- How sure we are that it is true. Distinct from importance: "their mother is
  -- ill" may be crucial and only 60% certain.
  confidence        real NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),

  -- Provenance. `user_explicit` means they asked us to remember it; `user_stated`
  -- means they said it; `inferred` means we concluded it. The writer treats these
  -- three very differently (src/memory/writer.ts).
  source            text NOT NULL CHECK (source IN ('user_explicit', 'user_stated', 'inferred')),

  tags              text[] NOT NULL DEFAULT '{}',

  -- `unconfirmed` marks an inference the person has not agreed with yet. It is
  -- retrievable but labelled, and Phase 5 lets them confirm or delete it.
  status            text NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'unconfirmed', 'superseded', 'deleted')),
  superseded_by     uuid REFERENCES memories(id) ON DELETE SET NULL,

  -- Which message this came from, so a memory can always be traced back to the
  -- thing that produced it.
  source_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  -- Access accounting drives the recency term in retrieval.
  last_accessed_at  timestamptz,
  access_count      integer NOT NULL DEFAULT 0,

  -- Populated by a backfill when an embedding provider exists (ADR 004).
  -- 384 dimensions because that is what the small local models emit; the column
  -- is unused until then and nothing reads it.
  embedding         vector(384)
);

CREATE INDEX memories_user_status_idx ON memories (user_id, status);
CREATE INDEX memories_user_type_idx   ON memories (user_id, type);
CREATE INDEX memories_user_importance_idx
  ON memories (user_id, importance DESC, created_at DESC);

-- Built now, on an empty column, so enabling similarity later does not need a
-- migration on a table that by then has real data in it.
CREATE INDEX memories_embedding_idx
  ON memories USING hnsw (embedding vector_cosine_ops);

-- Every write, correction, rejection and retrieval, so that the question "why
-- does it think it knows this?" has an answer that is not a guess.
CREATE TABLE memory_events (
  id         bigserial PRIMARY KEY,
  memory_id  uuid REFERENCES memories(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action     text NOT NULL CHECK (action IN
               ('created', 'updated', 'superseded', 'deleted', 'retrieved', 'rejected')),
  actor      text NOT NULL DEFAULT 'agent' CHECK (actor IN ('agent', 'user', 'system')),
  reason     text,
  detail     jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX memory_events_user_time_idx ON memory_events (user_id, created_at DESC);
CREATE INDEX memory_events_memory_idx    ON memory_events (memory_id, created_at DESC);

-- ------------------------------------------------------ user_preferences -----

-- Explicit product settings ("don't bring up my ex"), kept separate from
-- memories because they are instructions to the system rather than beliefs about
-- the person, and they are obeyed unconditionally rather than scored.
CREATE TABLE user_preferences (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        text NOT NULL,
  value      jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, key)
);

-- -------------------------------------------------------------- feedback -----

-- Explicit signal from the person about a specific reply. The only ground truth
-- about whether this product works that does not come from a model judging a
-- model — which is why it is a table from the first migration rather than
-- something added once there is a UI worth collecting it in.
CREATE TABLE message_feedback (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating     text NOT NULL CHECK (rating IN ('good', 'bad')),
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- One opinion per reply; changing your mind updates it.
  UNIQUE (message_id, user_id)
);

CREATE INDEX message_feedback_user_time_idx ON message_feedback (user_id, created_at DESC);

-- ------------------------------------------------------------ agent_runs -----

-- One row per turn. Observability, not analytics: the fingerprints are sizes and
-- hashes, never content (spec §14).
CREATE TABLE agent_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid REFERENCES users(id) ON DELETE SET NULL,
  conversation_id   uuid REFERENCES conversations(id) ON DELETE SET NULL,
  model             text NOT NULL,
  prompt_version    text NOT NULL,
  started_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz,
  duration_ms       integer,
  status            text NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running', 'completed', 'failed', 'safety_replaced')),
  used_tools        boolean NOT NULL DEFAULT false,
  tool_calls        jsonb NOT NULL DEFAULT '[]',
  -- `len=N sha256=...` — enough to correlate two runs, not enough to read them.
  input_fingerprint  text,
  output_fingerprint text,
  risk_level        text CHECK (risk_level IN ('none', 'elevated', 'crisis')),
  error             text
);

CREATE INDEX agent_runs_time_idx ON agent_runs (started_at DESC);

-- ------------------------------------------------------- evaluation ---------

CREATE TABLE evaluation_cases (
  id                  text PRIMARY KEY,
  category            text NOT NULL,
  title               text NOT NULL,
  user_message        text NOT NULL,
  expected_behaviors  text[] NOT NULL DEFAULT '{}',
  forbidden_behaviors text[] NOT NULL DEFAULT '{}',
  -- Machine-checkable assertions. Prose expectations above are for a human or a
  -- judge model; these are what the runner can decide on its own.
  checks              jsonb NOT NULL DEFAULT '[]',
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE evaluation_results (
  id             bigserial PRIMARY KEY,
  run_id         uuid NOT NULL,
  case_id        text NOT NULL REFERENCES evaluation_cases(id) ON DELETE CASCADE,
  reply          text,
  passed         boolean NOT NULL,
  score          real NOT NULL,
  prompt_version text NOT NULL,
  model          text NOT NULL,
  mode           text NOT NULL CHECK (mode IN ('live', 'recorded')),
  violations     jsonb NOT NULL DEFAULT '[]',
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX evaluation_results_run_idx ON evaluation_results (run_id);
