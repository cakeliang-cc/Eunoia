# Implementation Plan

Derived from spec §18 (Implementation Phases), adjusted to the verified
environment. Each phase ends with a **verification gate**: it is not complete
until the code compiles, lint passes, tests pass, and CHANGELOG is updated
(spec §19).

**Phases 0–4 are complete. Phase 5 is in progress.** See `CHANGELOG.md` for what
each phase actually shipped, including the bugs its gate caught.

---

## Decisions locked

| # | Decision | Choice | ADR |
|---|---|---|---|
| D1 | Database | PostgreSQL + pgvector, Docker (`pgvector/pgvector:pg17`), port 5433 | [002](adr/002-postgres-pgvector.md) |
| D2 | Embeddings | Scoring first (`w_s = 0`); `embedding` column + extension created in migration 1; backfill later | [004](adr/004-context-retrieval.md) |
| D3 | Agent runtime | OpenAI Agents SDK over DeepSeek's OpenAI-compatible surface (Responses API). No OpenAI account needed | [005](adr/005-agent-runtime.md) |
| D4 | Client/server boundary | Core emits `AsyncIterable<AgentEvent>`; `src/api/` owns HTTP/SSE; boundary enforced by test. Ships web first, mini-program later | [006](adr/006-client-server-separation.md) |
| D5 | Retrieval gating | `minSimilarity` is the relevance gate; `minScore` is a sanity floor. The two retrieval paths differ in width on purpose | [007](adr/007-retrieval-gates.md) |
| D6 | Crisis handling | Crisis turns are buffered and mechanically checked before anything renders; failure substitutes fixed text | [008](adr/008-safety-buffered-turns.md) |
| D7 | Identity | Server-minted unguessable UUID handle. Explicitly not authentication | [009](adr/009-identity-handle-not-auth.md) |

## Blockers requiring user action

None. All three blockers named at Phase 0 are resolved: the Docker daemon is
running, Postgres 17.11 + pgvector 0.8.6 are provisioned, and a git identity is
configured (`cakeliang-cc <xxwwliang@gmail.com>`).

**One blocker remains unsolvable from inside the project:** there is no embedding
provider (ADR 004, re-probed and unchanged). Retrieval runs on lexical similarity
until one exists; the similarity function is injected so the swap touches one
function.

---

## Phase 0 — Reconnaissance ✅ complete

- `CURRENT_STACK.md` written; environment and endpoint probed empirically.
- `CHANGELOG.md` created.
- ADRs 001–005 written.
- **Gate passed:** three architecture conflicts found and escalated rather than
  silently resolved; no code written (spec §23).

## Phase 1 — Minimal agent ✅ complete (2026-09-28)

**Goal:** a user message produces an INFP-companion response, end to end.

**Gate result:** typecheck, lint, and 35 offline tests all pass; a live smoke
test against DeepSeek streams a real reply; tracing emits a span hierarchy with
fingerprinted content; SSE verified over real HTTP.

Two bugs were found and fixed by the live test rather than by reasoning — the
SDK renames the provider's text-delta event, and the final output was read before
the run completed. Both are now pinned by tests. Notable: the first produced a
reply that *looked* correct while streaming was entirely broken, which is exactly
the class of failure that only an end-to-end run catches.

## Phase 2 — Memory ✅ complete (2026-09-28)

**Goal:** §4 four-layer memory, §6 retrieval, §7 write policy.

**Gate result:** all five §18 memory requirements pass by test — an explicit
preference is remembered; an irrelevant memory is *not* injected; a relevant one
is; speculation is not stored; a memory is updatable. The budget cap is asserted
rather than trusted, including a test that retrieval never returns everything.
The Postgres store passes 19 integration tests against a real database.

Delivered: `docker-compose.yml`, `migrations/001_init.sql` (whole schema),
`src/db/{pool,migrate,postgres-store,in-memory-store}.ts`,
`src/memory/{types,store,retrieval,writer,render,working-memory}.ts`,
`src/tools/memory-tools.ts` + `src/agent/tools.ts`,
`src/service/{chat,context}.ts`.

Two things were learned during implementation and became ADR 007: a score floor
cannot express relevance, and the two retrieval paths want opposite trade-offs.

## Phase 3 — Personality evaluation ✅ complete (2026-09-28)

**Goal:** §13 framework, ≥20 cases (§18), covering the §12 canonical scenarios.

**Gate result:** 24 cases across all 10 categories, all seven §12 canonical
scenarios present, baseline recorded —

```
evaluation live · prompt 54af13d10076 · deepseek-v4-pro
24/24 passed · mean score 0.945 · 0 violation(s)
```

Forbidden-behaviour violations are reported as **failures**, not warnings.
Case integrity is itself tested (unique ids, categories covered, every regex
compiles, every named tool exists), so a malformed case fails the suite rather
than silently never firing.

**The gate caught a real bug before it could be mistaken for a passing grade:**
`npm run eval` could not run at all — the CLI never installed the model provider,
and all 24 cases failed with a message that read like a bad API key.

## Phase 4 — Safety ✅ complete (2026-09-28)

**Goal:** §10 — companion, not therapist; safety outranks personality.

**Gate result:** the three safety cases route to safety behaviour rather than to
reflective questioning (`crisis`, `crisis`, `elevated`), and none needed the
fallback — the model's own replies passed the check. Tests assert that the INFP
persona **cannot** override a safety response: the directive says so in its own
words ("安全优先于人格设定", "让位"), and that text is asserted.

**The gate found four real detection gaps and one output-check gap**, each by
testing how people actually write rather than how the pattern was imagined:
`活着没什么意思了`, `割了自己一下`, `killing myself`, `他在家里打我`, and the
hedged `你可能得了抑郁症`. All five are fixed and pinned.

## Phase 5 — Product polish ⏳ in progress (2026-09-28)

**Goal:** UI, memory visibility, user-controlled memory, conversation history,
feedback capture, latency work. Deferred by design — spec §18.

Delivered: `src/api/identity.ts` (ADR 009); a memory panel backed by
`GET /api/memory` with per-memory `PATCH`/`DELETE` and the actor recorded as
`user`; a memory on/off switch honoured as *not consulted* rather than
consulted-and-hidden; feedback capture (upsert); conversation list and message
history endpoints; a streaming web client with a memory drawer; `README.md`.
The API layer passes 30 tests over real HTTP, including SSE framing and abort.

Remaining: latency work, and anything the first real usage suggests. The
mini-program adapter is not started — it is a later phase by design (ADR 006).

---

## Cross-cutting rules

- **CHANGELOG updated in the same change as the code** — never backfilled (spec
  §20, anti-pattern 8).
- **No prompt change without an evaluation run** (anti-pattern 7). `PROMPT_VERSION`
  is a hash of the stable instructions, so a prompt change is visible in the run
  history — visible, not prevented. The rule is still a rule.
- One migration per schema change; applied migrations are immutable (ADR 002).
- Retrieval changes must keep the budget cap test green.
- **Only a composition root installs the model provider**, enforced by
  `tests/architecture/boundaries.test.ts` in both directions: nothing else may,
  and every composition root must.

## Test suite as of 0.2.0

| Suite | Count | Requires |
|---|---|---|
| Offline (`npm test`) | 349 passed, 22 skipped | nothing |
| Postgres (`tests/db/`) | 21 | `DATABASE_URL` |
| Live smoke (`npm run smoke`) | 3 | `RUN_SMOKE=1` + credential |

The offline suite is the one that runs on every change: no network, no container,
about 1.5 seconds. Everything that needs the outside world self-skips, which is a
deliberate trade — a suite that requires a container is a suite that gets skipped
by whoever is in a hurry, so the *only* reliably-run tests are the ones that need
nothing.
