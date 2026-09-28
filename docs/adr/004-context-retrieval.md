# ADR 004 — Context retrieval: scored budget, embeddings deferred

## Context

Spec §6 forbids retrieving all memories per turn and forbids "vector -> text" as
the only mechanism. Spec §7 forbids writing memory every turn.

Reconnaissance found the only available model endpoint exposes **no embeddings
route** (HTTP 404 on `/v1/embeddings`, `/embeddings`, `/v1/embed`). The spec's
retrieval scoring includes a "semantic relevance" term, and §13 scores
`memory_relevance` — so this is a real gap, not a detail.

## Decision

**Two-part decision.**

**1. Retrieval is a scored, budgeted selection, not a fetch-all.**

```
candidate set (SQL-filtered by user_id, type, expiry)
        ↓
score = w_i·importance + w_r·recency + w_t·typePrior + w_s·similarity
        ↓
take top-K under an explicit context token budget
        ↓
render compactly (one line per memory, with date + type + confidence)
```

Weights and K live in one config module, not scattered through the code.

**2. Embeddings and the `similarity` term are deferred, not dropped.**

Phase 2 ships scoring with `w_s = 0`, using importance + recency + type prior +
lexical overlap. The `embedding` column and the `vector` extension are created in
the **first migration** so that enabling similarity later is a backfill, not a
migration. The scoring function takes similarity as an injected input, so turning
it on is a config change plus a backfill job.

## Alternatives

1. **Local ONNX embeddings now** (`all-MiniLM-L6-v2`, 384-dim, offline).
   Deferred, not rejected — the user chose scoring-first. It remains the intended
   follow-up: it needs no API key and no network at inference time.
2. **External embedding API.** Rejected for now: no such credential exists in the
   environment, and it adds a network dependency on the hot path of every turn.
3. **Lexical-only retrieval permanently.** Rejected — it will not satisfy §13's
   `memory_relevance` dimension for paraphrased memories ("I hate being rushed"
   vs. "don't pressure me"), which is exactly what similarity is for.
4. **Fetch all memories and let the model filter.** Rejected — explicitly
   forbidden by §6 and anti-pattern 2.

## Why

Deferring the similarity term is the lowest-risk, most rollback-friendly path: it
unblocks Phase 2 entirely, costs nothing to reverse, and keeps the schema
forward-compatible. Doing nothing about the column would have made it a real
migration later; doing local ONNX immediately would have added a dependency
before the retrieval logic it serves is even proven.

## Consequences

- **Known limitation, recorded in CHANGELOG:** retrieval quality for paraphrased
  memories is degraded until embeddings land. Eval cases must not over-claim
  `memory_relevance` in Phase 2.
- The context budget is a hard cap, asserted in tests — a test must fail if
  retrieval ever returns all memories for a user.
- `MemoryRetrieval` is unit-testable without a database, because scoring is pure.
- The vector dimension (384) must be fixed in the first migration even though
  unused, since changing a `vector(N)` column later is a migration. 384 is
  chosen to match `all-MiniLM-L6-v2`, the intended model.
