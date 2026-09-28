# Implementation Plan

Derived from spec §18 (Implementation Phases), adjusted to the verified
environment. Each phase ends with a **verification gate**: it is not complete
until the code compiles, lint passes, tests pass, and CHANGELOG is updated
(spec §19).

Phase 0 is complete. Phases 1–5 are below.

---

## Decisions locked

| # | Decision | Choice | ADR |
|---|---|---|---|
| D1 | Database | PostgreSQL + pgvector, Docker (`pgvector/pgvector:pg17`) | [002](adr/002-postgres-pgvector.md) |
| D2 | Embeddings | Scoring first (`w_s = 0`); `embedding` column + extension created in migration 1; backfill later | [004](adr/004-context-retrieval.md) |
| D3 | Agent runtime | OpenAI Agents SDK over DeepSeek's OpenAI-compatible surface (Responses API). No OpenAI account needed | [005](adr/005-agent-runtime.md) |
| D4 | Client/server boundary | Core emits `AsyncIterable<AgentEvent>`; `src/api/` owns HTTP/SSE; boundary enforced by test. Ships web first, mini-program later | [006](adr/006-client-server-separation.md) |

## Blockers requiring user action

| Blocker | Needed for | Status |
|---|---|---|
| **Docker daemon running** | Phase 2 (memory) | `docker ps` fails to connect |
| **git identity** (`user.name`, `user.email`) | all commits | unset |

**Phase 1 has no blocker** and can start immediately. The former OpenAI-key
blocker is withdrawn — see ADR 005's correction. Phase 2 alone waits on Docker,
and the schema/migration/scoring work within it can be written before the daemon
is up.

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

Scope:
1. Scaffold: `package.json`, `tsconfig.json`, lint + format, `vitest`.
2. `src/agent/instructions.ts` — the §11 prompt, built from modular sections
   (Identity, mission, behavioral principles, Fi/Ne/Si/Te heuristics, memory
   rules, conversation rules, safety, tool rules, canonical examples). Not one
   monolithic blob, no if/else logic in prose.
3. `src/agent/behavioral-policy.ts` — the decision rules that are *not* prompt
   text: when not to advise, one-question discipline, when to gently challenge.
4. `INFPCompanionAgent` — single agent (ADR 001), streaming, on the Agents SDK's
   default Responses-API path against DeepSeek.
5. `src/agent/model-client.ts` — the one module that constructs `AsyncOpenAI`
   with `baseURL: https://api.deepseek.com`. Nothing else imports a vendor SDK
   (ADR 005). A single exported constant holds the canonical model IDs; a test
   asserts no non-canonical alias (`deepseek-chat`, `deepseek-reasoner`,
   `deepseek-v4-flash`) appears anywhere in `src/`, since those resolve silently
   to the wrong model rather than failing.
6. Tracing wired to a custom processor, not the SDK's OpenAI-hosted default
   exporter, which cannot authenticate here (ADR 005, spec §14).
7. `src/api/chat.ts` — minimal streaming endpoint.
8. Tests: instructions compose correctly; agent constructs; a smoke turn runs;
   model-ID guard passes.

Files: `src/config.ts`, `src/agent/{events,behavioral-policy,instructions,model-client,infp-agent}.ts`,
`src/observability/{logging,tracing}.ts`, `src/api/{sse,server}.ts`, `web/index.html`.

## Phase 2 — Memory

**Goal:** §4 four-layer memory, §6 retrieval, §7 write policy.

Scope:
1. `docker-compose.yml` with the pinned pgvector image; `DATABASE_URL` wiring.
2. Migration 001 — `users`, `conversations`, `messages`, `memories`,
   `memory_events`, `user_preferences`, `agent_runs`, `evaluation_cases`,
   `evaluation_results`; `memories` carries every §5 column including nullable
   `embedding vector(384)` (ADR 004).
3. `memory-types.ts`, `MemoryStore` interface + Postgres implementation.
4. `memory-writer.ts` — §7 policy: refuse speculation, require confidence
   threshold, honour explicit user requests (`source='user_explicit'`).
5. `memory-retrieval.ts` — pure scoring (importance + recency + type prior +
   lexical), hard context budget, `w_s = 0` for now.
6. Working memory as session state, never persisted (ADR 003).
7. Tools: `search_memory`, `save_memory`, `update_memory` — narrow, single-purpose
   (§9). No `do_everything`.
8. Tests — the five §18 requirements, explicitly: explicit preference remembered;
   irrelevant memory *not* injected; relevant memory retrieved; speculation *not*
   stored; memory updatable. Plus a test asserting retrieval never returns all
   memories.

**Gate:** all five §18 memory tests pass; budget cap enforced by test.

**Blocked on:** Docker daemon.

## Phase 3 — Personality evaluation

**Goal:** §13 framework, ≥20 cases (§18), covering the §12 canonical scenarios.

Scope:
1. `EvaluationCase` per the §13 interface (`id`, `category`, `userMessage`,
   `expectedBehaviors`, `forbiddenBehaviors`).
2. The seven §12 cases translated into concrete expected/forbidden behaviours —
   case 01 must forbid immediate productivity advice; case 03 must forbid
   guessing the third party's motive; case 05 must require a *small* action, etc.
3. Coverage across all §18 categories, to ≥20 cases.
4. Scorers for the §13 dimensions that are mechanically checkable; the rest
   judged, with the judge model pinned and recorded.
5. `evaluation_results` persistence; a recorded/synthetic mode so prompt
   iteration does not require a live call per case (ADR 005).
6. Baseline run recorded in CHANGELOG.

**Gate:** ≥20 cases run; baseline recorded; forbidden-behaviour violations
reported as failures, not warnings.

## Phase 4 — Safety

**Goal:** §10 — companion, not therapist; safety outranks personality.

Scope: input guardrail for high-risk self-harm/crisis content; output checks
where needed; explicit refusal of diagnosis/therapy claims; risk-signal path for
case 06; approval boundary on any real side effect. Tests must assert that the
INFP persona **cannot** override a safety response.

**Gate:** safety tests pass; a risk-signal case routes to safety behaviour, not
to reflective questioning.

## Phase 5 — Product polish

Only after 1–4. UI, memory visibility, user-controlled memory (view/edit/delete),
conversation history, feedback capture, analytics, latency work. Deferred by
design — spec §18.

---

## Cross-cutting rules

- **CHANGELOG updated in the same change as the code** — never backfilled (spec
  §20, anti-pattern 8).
- **No prompt change without an evaluation run** (anti-pattern 7).
- One migration per schema change; applied migrations are immutable (ADR 002).
- Retrieval changes must keep the budget cap test green.
