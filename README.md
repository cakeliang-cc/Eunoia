# designFree — INFP 陪伴 Agent

A long-term companion agent, built from 0 to 1.

It is not a gentle-sounding chatbot. The product claim is narrower and harder:
**one agent with stable personality behaviour, long-term personal memory,
emotion and value clarification, narrative continuity, controlled tool use,
observability, evaluability, and a continuous changelog.**

Everything runs against **DeepSeek** through the OpenAI Agents SDK. No OpenAI
account is required.

---

## Quick start

```bash
npm install
docker compose up -d        # Postgres 17 + pgvector, on port 5433
npm run migrate             # apply migrations/001_init.sql
npm run dev                 # http://localhost:8787
```

The server logs which store it selected. **Without `DATABASE_URL` it falls back
to an in-memory store** — everything works, and nothing survives a restart. The
fallback exists so `npm test` runs with no container; it is not meant for
actually using the thing.

Set the key before starting:

```bash
export DEEPSEEK_API_KEY=...        # preferred
# or reuse the one this environment already has:
export ANTHROPIC_AUTH_TOKEN=...
```

See `.env.example`.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the server (web client at `/`) |
| `npm test` | Offline suite — no network, no container, ~1.5s |
| `npm run smoke` | Live turns against DeepSeek (`RUN_SMOKE=1` required) |
| `npm run eval` | The personality evaluation, live; records a replayable file |
| `npm run eval:replay` | Re-score the last recording, free and instant |
| `npm run cleanup` | Retention sweep — sees what it would delete with `--dry-run` |
| `npm run typecheck` / `npm run lint` | The other two gates |
| `npm run migrate` | Apply migrations |
| `npm run build` / `npm start` | Compile to `dist/`, then run it. Development does not need this |

`npm run build` is not part of the day-to-day loop: `npm run dev` runs the
sources directly through Node's type stripping, so the file on disk is what the
model gets. The build exists for the deployment that does not have that, and it
copies the prompt document alongside the emitted modules — `tsc` has no opinion
about `.md` files, and `src/agent/instructions.ts` resolves the prompt relative
to itself.

The Postgres integration tests self-skip unless `DATABASE_URL` is set, because a
suite that needs a container is a suite that gets skipped by whoever is in a
hurry:

```bash
DATABASE_URL=postgres://designfree:designfree@localhost:5433/designfree npm test
```

## Architecture

```
client (web/, later miniprogram/)
        │  HTTP + SSE
        ▼
src/api/          ← the only HTTP-aware layer
        │  AsyncIterable<AgentEvent>
        ▼
src/service/      ← turn orchestration: retrieve → assess → run → check → persist
        │
        ├── src/agent/          one agent, its prompt, its tools (ADR 001)
        ├── src/memory/         four-layer memory, scoring, write policy, relationship (ADR 003, 004, 007, 012)
        ├── src/safety/         risk detection, directives, output check (ADR 008)
        ├── src/db/             Store interface + Postgres and in-memory implementations
        └── src/evaluation/     cases, scorers, runner, report (ADR 004)
```

The boundary is **enforced by tests**, not by convention — nothing in the core
imports HTTP, and no product-logic layer imports the vendor SDK. A comment in a
README would not survive the first hurried commit.

The core emits events, never responses. That is what makes the planned
mini-program migration an adapter rather than a rewrite (ADR 006).

## Design decisions worth knowing before reading the code

| ADR | Decision |
|---|---|
| [001](docs/adr/001-single-agent.md) | One agent. Fi/Ne/Si/Te are heuristics inside it, not four collaborating agents. |
| [002](docs/adr/002-postgres-pgvector.md) | Postgres + pgvector, pinned Docker image, port 5433. |
| [003](docs/adr/003-memory-model.md) | Four memory layers; working memory is **never** persisted. |
| [004](docs/adr/004-context-retrieval.md) | Scored, budgeted retrieval; embeddings deferred behind an injected similarity term. |
| [005](docs/adr/005-agent-runtime.md) | OpenAI Agents SDK over DeepSeek's OpenAI-compatible surface. |
| [006](docs/adr/006-client-server-separation.md) | Core emits events; `src/api/` owns HTTP. |
| [007](docs/adr/007-retrieval-gates.md) | Relevance is gated by `minSimilarity`, not `minScore`; the two retrieval paths are deliberately different widths. |
| [008](docs/adr/008-safety-buffered-turns.md) | Crisis turns are buffered and checked before anything is rendered. |
| [009](docs/adr/009-identity-handle-not-auth.md) | Identity is an unguessable handle, explicitly **not** authentication. |
| [010](docs/adr/010-reasoning-is-forwarded.md) | The model's reasoning is forwarded as its own event, not discarded. |
| [011](docs/adr/011-prompt-is-a-document.md) | The system prompt is a markdown document (`src/agent/prompts/companion.md`); only its composition is code. |
| [012](docs/adr/012-relationship-and-narrative.md) | Relationship state is derived from counts and rendered every turn; narrative themes are carried without a similarity gate, because a theme never shares words with the message about it. Records a decision **and its reversal**. |

A few of these are worth stating in the README because they surprise people:

- **A crisis turn does not stream.** Its reply is held until it passes a
  mechanical safety check. A rendered delta cannot be un-rendered, so the check
  has to happen first. Its reasoning is held back with it.
- **The two retrieval paths behave differently on purpose.** Automatic injection
  is narrow and gated; the `search_memory` tool is wider and ungated, because
  the model can judge a candidate and the automatic path cannot.
- **The reasoning phase reaches the client.** A reasoning model thinks for
  several seconds before its first character, so the alternatives were a live
  view of that thinking or a long static `…`. See ADR 010 — and note that a
  client may ignore `thinking_delta` entirely and still be correct.
- **The system prompt is a markdown file, not code.** It is
  `src/agent/prompts/companion.md`, read once at startup; `instructions.ts` only
  decides what goes around it. Editing the companion's voice is editing a
  document — and `PROMPT_VERSION` hashes the bytes the model is actually sent, so
  a recorded evaluation can be attributed to the prompt that produced it. See
  ADR 011.
- **The prompt is Chinese; the identifiers inside it are not.** Every word the
  model *reads* is Chinese, because the product is Chinese-facing. Tool names
  (`search_memory`), the enum values it must emit (`user_explicit`) and schema
  field names (`source`, `confidence`) stay in English, because the code matches
  on them and translating one would break a call. `Fi`/`Ne`/`Si`/`Te` stay too —
  they are the spec's own names for the four lenses, the way INFP is.

The reasoning shows as a muted block above the reply that closes itself with how
long it took; open it to read what the model was working out. It is a margin
note, not part of the answer, which is why it is a separate event rather than
more `text_delta`.

## Evaluation

30 cases across 13 categories, translated from the spec's canonical scenarios —
twenty-four of them hard moments, four (`light_intent`) ordinary turns, and two
about continuity over time. The split is deliberate in both directions: a suite
made only of hard moments certifies a companion that answers "周末去哪儿" with a
question about your feelings, and a suite with no continuity case cannot see a
companion that greets a stranger as an old friend. Scoring is mechanical where it
can be (`CheckKind`s in `src/evaluation/scorers.ts`) and reported, not silently
warned, when a forbidden behaviour appears.

Both continuity cases earned their place the same way: they were written and run
*before* the features they judge, so the "before" reply is the evidence that the
feature was needed rather than a description of it. `relationship-01` answered
*"我这次打开时没检索到存下来的东西"* — a report on a database query — and
`narrative-01` is the measurement that reversed a deferral. See
[ADR 012](docs/adr/012-relationship-and-narrative.md).

A case count is a claim about coverage, and the claim is only worth something if
the checks can fail. They did not all: `light-04` scored a perfect 1.00 on the
exact reply the changelog names as its failure, because the check written for
that failure never contained the phrase. `tests/evaluation/cases.test.ts` now
replays every recorded failure against the check that is supposed to catch it —
delete the patterns and it goes red, which is the property the suite was missing.
See `CHANGELOG.md` → `Fixed`.

```
npm run eval              # live; writes evaluation/recorded/<prompt>-<time>.json
npm run eval:replay       # re-score that file against the current checks
```

`--replay` is free for the cases the recording covers, and the ones it does not
are named in the report rather than quietly re-run against the model. A filtered
run (`--case`, `--category`) is not recorded at all: `--replay` picks the newest
file, so a partial one would become the baseline.

Recordings are committed: a live run is the expensive part, and its output is the
only way to iterate on the checks for free afterwards. Each file records the
`promptVersion` it was made with, and a mismatch is reported loudly — replaying
old replies after a prompt change measures nothing.

The baseline is in `CHANGELOG.md` under `Evaluation`.

## Privacy

- **No raw user content in logs.** Everything that reaches a log line is either a
  category label or a fingerprint (`len=42`). This is a hard rule (spec §14), and
  there is a test that asserts an assessment never contains the matched text.
- **Memory is visible and deletable.** `GET /api/memory` backs a panel showing
  what the system believes; `PATCH` and `DELETE` let the person correct or remove
  it. Soft-deleted rows stay as rows because `memory_events` and `superseded_by`
  point at them — so "deleted" is filtered on read, not prevented on write.
- **The local identity is not authentication.** See ADR 009. Do not put real data
  behind it yet.

## Status

Phases 0–4 complete; Phase 5 (product polish) in progress. See
`docs/implementation-plan.md` for the phase gates and `CURRENT_STACK.md` for the
verified environment.
