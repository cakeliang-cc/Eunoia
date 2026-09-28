# ADR 002 — PostgreSQL + pgvector in Docker

## Context

Spec §5 defaults to PostgreSQL + pgvector and forbids introducing a standalone
vector database in the first version.

Reconnaissance found the machine has only the `libpq` **client** (17.6): the
`postgres` server binary does not exist and no data directory is present. The
Docker CLI is installed but the daemon was not running at reconnaissance time.

Memory is application data — it needs relational integrity, `user_id` scoping,
type/source/confidence columns, update timestamps, and expiry — not just
vector similarity. Spec §5 is explicit that `vector -> text` alone is the wrong
model.

## Decision

Run PostgreSQL with the `pgvector` extension, in Docker, using the official
`pgvector/pgvector:pg17` image. Pin the image tag. Schema is defined by
versioned SQL migrations committed to the repository.

The toolchain talks to it through a `MemoryStore` interface, so retrieval and
write-policy code never depend on the driver directly.

## Alternatives

1. **Homebrew install (`postgresql@17` + `pgvector`).** Rejected. It installs a
   persistent background service and mutates the host system; harder to reset to
   a known state and harder to reproduce. Docker is disposable, which matches a
   project that will iterate on schema frequently.
2. **Embedded/in-process store (SQLite, in-memory).** Rejected by the user's
   decision, and it diverges from spec §5. It would also defer the real
   integration risk rather than removing it.
3. **Standalone vector DB (Pinecone/Qdrant/Chroma).** Rejected — explicitly
   forbidden by spec §0 and §5 for the MVP, and it would split application data
   across two stores for no benefit at this scale.

## Why

Docker gives an exact, pinned, reproducible Postgres+pgvector with a one-command
teardown, so schema work in Phase 2 can iterate without leaving residue on the
host. pgvector is an extension in the same database as the relational memory
rows, which is what §5 asks for: the `embedding` column lives next to
`confidence`, `source`, and `importance` on the same row.

## Consequences

- **Blocker, requires user action:** the Docker daemon must be running to
  provision the database. `docker ps` currently fails to connect.
- Connection string comes from `DATABASE_URL`; nothing hardcodes credentials.
- Migrations must run on a fresh container and be idempotent, so a reset is
  `docker compose down -v && docker compose up -d` plus `npm run migrate`.
- The `embedding` column is created nullable and `vector`-typed **from the first
  migration**, even though embeddings are deferred (see ADR 004). Adding
  embeddings later is then a backfill, not a schema migration.
- Schema changes require a new migration file; editing an applied migration is
  not permitted.
