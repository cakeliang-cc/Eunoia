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
| D8 | Reasoning phase | Forwarded as `thinking_delta`/`thinking_done`; model reasoning effort left at its default | [010](adr/010-reasoning-is-forwarded.md) |
| D9 | Prompt source | The system prompt is a document read at startup; the policy it used to be rendered from is now a checklist the document is tested against | [011](adr/011-prompt-is-a-document.md) |

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

Latency work is done for now: the wait was not the model's, it was a discarded
event stream (ADR 010), and forwarding the reasoning took time-to-first-frame
from 17.83s to 1.22s without touching the model's settings.

The prompt was made fully Chinese (spec §11) and the §20-mandated evaluation run
that followed **found a defect in the evaluation rather than in the prompt** — the
mechanical checks could not distinguish a reply that *mentions* a forbidden
phrase from one that *uses* it, and were failing two correct replies. The new
baseline is 24/24, mean **0.958**, 0 violations at `prompt e9eb3bc57a41`. The
detail is worth reading before trusting a green run: `CHANGELOG.md` → Evaluation.

**The persona handles light intents** (2026-09-29). Raised by the user on
2026-09-28 and deferred to a later change; done in the recorded order — the four
`light_intent` cases first, then the prompt — because a prompt change no case can
see is a change nothing verifies. It was not a small fix: measured against the
new cases at the old prompt, all four light turns were answered with a question
about the person's inner state and none of them gave what was asked for. The
causes were in the document (six examples, all hard moments; an unscoped
"不替用户做决定"), so the fix was there too. New baseline at `prompt 1e0d7fcd97a2`;
`CHANGELOG.md` → Evaluation has the before-and-after and the residual gap.

**The companion knows how long it has known you** (2026-09-29). The relationship
half of Phase 8 in `docs/REFACTORING_PLAN.md`, closing two §43 dimensions that had
no case and no feature behind them. The trigger was measured rather than assumed:
asked *"我们之前聊过吧？"* with no history, the companion answered with a report on
a database query, because with retrieval as its only instrument a question about
the relationship had to be read as a retrieval problem.
`src/memory/relationship.ts` derives the state from counts that already exist and
renders it into every turn — deliberately not relevance-gated, because a gated
block would be missing on exactly the turn it is needed.

**The narrative half went the other way, twice.** The first version of
[ADR 012](adr/012-relationship-and-narrative.md) deferred it on a single
observation — the model had reached a running theme on its own through
`search_memory`. Four more runs did not replicate that, and the mechanism turned
out to be deterministic: the theme and the message share no terms, so the
similarity gate drops the memory before the model ever sees it (`selected 0,
dropped {below_min_similarity: 1}`). `src/memory/narrative.ts` is the block the
plan proposed, built once the evidence supported it rather than in the same pass
as the relationship one. **The reversal is recorded in the ADR**, not just the
outcome — the interesting part is how thin the first decision's evidence was.

Remaining:

- Anything else the first real usage suggests.
- The mini-program adapter is not started — it is a later phase by design
  (ADR 006).

**A check that cannot fail is decoration** (2026-09-29). `no-therapy-probe` was
documented as having been rewritten from the four real failing replies, and it
matched neither phrase the record quotes as that evidence — so `light-04` scored
a clean 1.00 on the exact reply it exists to catch. Found by replaying the quoted
replies through the real scorer instead of reading the pattern lists. The list is
now one shared constant with the observed phrasings in it, both failures score as
violations, and `tests/evaluation/cases.test.ts` gained a `the checks do what they
claim` block that replays every documented failure against the check that should
see it. Deleting the patterns turns its tests red — verified, not assumed.

**The other direction turned out to be the worse one.** A second live run at the
*same* prompt, made to tell a wobble from a regression, found `relationship-01`
being **failed by its own check on a correct reply**: `no-diagnosis` listed the
bare noun `你的记忆` and matched *"我这边还没有关于你的记忆"*, which is the honest
first-meeting answer the case exists to reward. A check that never fires is a gap;
a check that fires on a correct reply is a lie about the product, and the natural
response to reading it is to change behaviour that was already right. The noun was
removed and no replacement was invented — the block now pins that reply too, so
re-adding the pattern fails the suite.

---

## Cross-cutting rules

- **CHANGELOG updated in the same change as the code** — never backfilled (spec
  §20, anti-pattern 8).
- **No prompt change without an evaluation run** (anti-pattern 7). `PROMPT_VERSION`
  is a hash of the stable instructions, so a prompt change is visible in the run
  history — visible, not prevented. The rule is still a rule. The hash is taken
  from the loaded document rather than from a constant, so the version describes
  the bytes the model was sent and not a copy of them (ADR 011).
- **The prompt is a document** (`src/agent/prompts/companion.md`), read at
  startup. Editing the companion's voice is editing markdown; adding prose back
  into the loader is a test failure (`tests/architecture/prompt-source.test.ts`).
- One migration per schema change; applied migrations are immutable (ADR 002).
- Retrieval changes must keep the budget cap test green.
- **Only a composition root installs the model provider**, enforced by
  `tests/architecture/boundaries.test.ts` in both directions: nothing else may,
  and every composition root must.

## Test suite as of [Unreleased]

| Suite | Count | Requires |
|---|---|---|
| Offline (`npm test`) | 459 passed, 29 skipped | nothing |
| Postgres (`tests/db/`) | 25 | `DATABASE_URL` |
| Live smoke (`npm run smoke`) | 4 | `RUN_SMOKE=1` + credential |
| Evaluation (`npm run eval`) | 30 cases, mean 0.966–0.969 (two samples at one prompt) | credential |

The offline suite is the one that runs on every change: no network, no container,
about 1.5 seconds. Everything that needs the outside world self-skips, which is a
deliberate trade — a suite that requires a container is a suite that gets skipped
by whoever is in a hurry, so the *only* reliably-run tests are the ones that need
nothing.
