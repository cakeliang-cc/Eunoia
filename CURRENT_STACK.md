# CURRENT_STACK.md

Phase 0 reconnaissance output. All statements below were verified by probing the
local machine and the configured model endpoint on 2026-09-28. Nothing here is
assumed.

---

## 1. Current stack

**There is no existing stack.** `/Users/Zhuanz/Projects/designFree` was empty at
reconnaissance time (no files, no `package.json`, no `.git`, no config). This is a
greenfield build, so there is no existing infrastructure to reuse or protect.

Consequently, sections "Existing architecture" and "Reusable components" are
empty by fact, not by omission.

### Verified local toolchain

| Tool | Version | Status |
|---|---|---|
| Node.js | v24.7.0 | available |
| npm | 11.5.1 | available |
| TypeScript | — | not installed (comes via `devDependencies`) |
| Python | 3.13.5 (miniconda) | available |
| PostgreSQL **client** (`libpq`) | 17.6 | available |
| PostgreSQL **server** | — | **NOT INSTALLED** |
| pgvector | — | **NOT INSTALLED** |
| Docker CLI | 28.3.3 | installed |
| Docker daemon | — | **NOT RUNNING** |
| git | — | available, but **no global `user.name` / `user.email` configured** |

`psql` resolves to `/opt/homebrew/opt/libpq/bin/psql`. `libpq` is the client
library only; the `postgres` server binary does not exist on this machine
(`which postgres` → not found) and no data directory exists
(`/opt/homebrew/var/postgres*` → no match). `pg_isready` reports no response on
`/tmp:5432`.

### Verified model endpoint

The only model credentials available in the environment are:

```
ANTHROPIC_BASE_URL = https://api.deepseek.com     (SET)
ANTHROPIC_AUTH_TOKEN = SET (35 chars)
ANTHROPIC_API_KEY   = unset
OPENAI_API_KEY      = unset
OPENAI_BASE_URL     = unset
DEEPSEEK_API_KEY    = unset
DATABASE_URL        = unset
```

The endpoint is DeepSeek, which exposes **both** an OpenAI-compatible and an
Anthropic-compatible API. Per DeepSeek's documentation:

```
base_url (OpenAI)    = https://api.deepseek.com
base_url (Anthropic) = https://api.deepseek.com/anthropic
models               = deepseek-flash, deepseek-v4-pro
```

> **Correction notice.** An earlier revision of this document concluded that
> "the endpoint exposes only the Anthropic Messages API surface" and that the
> OpenAI-format route returned 404. **That conclusion was wrong.** It was drawn
> from a single probe during a window when the endpoint was returning transient
> 404s — `/v1/models` also 404'd in that window and works now. The OpenAI route
> is present and functional. See `CHANGELOG.md` and ADR 005 for the correction
> and its consequences. The lesson is recorded because it shaped a decision:
> **a single observation is not a finding; re-probe before concluding.**

### Verified — OpenAI-compatible surface (`https://api.deepseek.com`)

| Capability | Result |
|---|---|
| `POST /v1/chat/completions` (OpenAI format) | **works** |
| Tool calling (`tools` + `tool_choice`) | **works** — `finish_reason: "tool_calls"`, well-formed `tool_calls[]` with JSON-string `arguments` |
| SSE streaming (`stream: true`) | **works** — standard `chat.completion.chunk` deltas, plus `delta.reasoning_content` for the reasoning stream |
| `GET /v1/models` | **works** — authoritative model list |
| Stability (8 consecutive calls) | **8/8 HTTP 200** |
| Usage reporting | `prompt_tokens_details.cached_tokens`, `completion_tokens_details.reasoning_tokens`, `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` |

### Verified — Anthropic-compatible surface

| Capability | Result |
|---|---|
| `POST $ANTHROPIC_BASE_URL/v1/messages` | **works** |
| Extended thinking blocks | **works** (`type: "thinking"`) |
| Tool use | **works** (`tool_use` with parsed `input`) |
| SSE streaming | **works** |
| `POST /anthropic/v1/messages` | empty response (the bare host path is what works) |

### Authoritative model list

Only **two** real model IDs exist. Everything else is an alias:

| Model ID | Context | Max output | Input | Notes |
|---|---|---|---|---|
| `deepseek-flash` | 1,048,576 | 393,216 | text, image | fast tier; aliases `deepseek-v4-flash`, `deepseek-chat`, `deepseek-reasoner` all resolve here |
| `deepseek-v4-pro` | 1,048,576 | 393,216 | text | stronger tier, text-only |

An **unknown** model name returns HTTP **400** on the OpenAI route (with the
supported names in the message) but HTTP **404** on the Anthropic route. This
404-on-bad-model behaviour is what made the original misdiagnosis plausible.

### Not available — embeddings

| Capability | Result |
|---|---|
| `POST /v1/embeddings` | HTTP 404 |
| `POST /embeddings` | HTTP 404 |
| `POST /v1/embed` | HTTP 404 |
| Any embedding model in `/v1/models` | none |

This one was re-probed after the correction above and **stands**: DeepSeek
exposes no embeddings endpoint, and the model list contains no embedding model.
ADR 004's deferred-embeddings decision is therefore unaffected.

---

## 2. Existing architecture

None. Greenfield.

## 3. Reusable components

None from the repository.

Two things are reusable from the *environment*:

1. **The DeepSeek endpoint, via its OpenAI-compatible surface** — verified
   working across every capability the agent design needs: chat completions,
   tool calling, streaming, and thinking. Because it speaks the OpenAI wire
   format, the OpenAI Agents SDK can drive it with a custom `baseURL`, which
   satisfies spec §8 without an OpenAI account.
2. **Node 24 / npm 11** — sufficient for the TypeScript stack the spec targets.
3. **An existing credential** — `ANTHROPIC_AUTH_TOKEN` is a working DeepSeek API
   key. No new key needs to be issued to begin.

## 4. Missing components

Everything the target architecture in the spec calls for, specifically:

| Spec requirement | Status | Blocker |
|---|---|---|
| TypeScript / Node project | missing | none — can scaffold immediately |
| OpenAI Agents SDK runtime | **viable** | none — SDK points at DeepSeek's OpenAI-compatible `baseURL` |
| PostgreSQL server | missing | not installed; Docker daemon down |
| pgvector extension | missing | follows from the above |
| Embedding provider | **missing** | no embeddings route on the endpoint (re-probed, stands) |
| Tracing / observability | missing | SDK tracing available; app-level logs to be built |

## 5. Potential conflicts

These are conflicts between the spec's recommended architecture (§0, §8, §5)
and verified reality. Per spec §22 these are recorded rather than silently
resolved.

### Conflict A — RESOLVED: no conflict. The OpenAI Agents SDK is available.

This conflict was **raised in error** and is retracted.

- **Spec (§8):** "优先使用 OpenAI Agents SDK."
- **What was believed:** the endpoint had no OpenAI-format route, so the SDK was
  unusable without an OpenAI account. This was drawn from a single transient 404
  and was wrong.
- **Verified reality:** DeepSeek exposes an OpenAI-compatible API at
  `https://api.deepseek.com`. `/v1/chat/completions` works, tool calling returns
  well-formed `tool_calls`, streaming works, and 8/8 consecutive calls succeeded.
- **Consequence:** the OpenAI Agents SDK **can** be used, pointed at DeepSeek via
  a custom `baseURL`. Spec §8 is satisfied, the models are DeepSeek, and **no
  OpenAI credential is required.** This removes what was previously recorded as
  Blocker 1.
- **Residual impact on model choice:** only two model IDs exist
  (`deepseek-flash`, `deepseek-v4-pro`), so model selection is a two-way choice,
  not a family. Model IDs must be written as the canonical names — the aliases
  (`deepseek-chat`, `deepseek-reasoner`, `deepseek-v4-flash`) silently resolve to
  `deepseek-flash`, which would make a `deepseek-reasoner` configuration quietly
  run the wrong model.

### Conflict B — PostgreSQL + pgvector cannot be assumed

- **Spec (§5):** default to PostgreSQL + pgvector.
- **Reality:** No server binary, no data dir, Docker daemon not running.
- **Impact:** High *if unaddressed*, because the entire §4 memory architecture and
  §6 retrieval policy sit on this. Requires a one-time install decision.

### Conflict C — No embedding provider for semantic retrieval

- **Spec (§6, §13):** retrieval scoring uses "semantic relevance"; memory table
  has an `embedding` column; `memory_accuracy` / `memory_relevance` are scored
  eval dimensions.
- **Reality:** No embeddings route on the endpoint (404 on all probed paths).
- **Impact:** Moderate. Retrieval can still rank by importance + recency + type
  + lexical overlap, but the spec's vector-similarity component needs either a
  local embedding model or a deferred design.

### Non-conflicts (verified fine)

- **Language/stack** — TypeScript + Node as specified; Node 24 present.
- **Single agent, no multi-agent** (§8, anti-pattern 4) — no constraint violated.
- **Tool set** `search_memory` / `save_memory` / `update_memory` (§9) — tool use
  is verified working; the narrow tool set is directly implementable.
- **Guardrails** (§10) — implementable in-process; no vendor dependency needed.

## 6. Recommended integration points

1. **Model access** — the OpenAI Agents SDK with an explicitly configured
   `AsyncOpenAI({ baseURL: "https://api.deepseek.com", apiKey: ... })`, wrapped
   behind a single `ModelClient` module. Keep provider construction in one file
   so the agent core never imports a vendor SDK directly, and so the endpoint can
   change without touching agent, memory, or evaluation code.
2. **Agent runtime** — one `INFPCompanionAgent` using the SDK's agent loop, tool
   dispatch, and tracing. Single agent, per §8 and ADR 001.
3. **Persistence** — Postgres. Introduce a `MemoryStore` interface with a
   Postgres implementation first, so a temporary embedded store can be swapped in
   without touching retrieval or write-policy code.
4. **Retrieval** — `MemoryRetrieval` consuming a scoring function whose
   components (importance, recency, type prior, similarity) are individually
   testable. The similarity term is the only piece affected by Conflict C.
5. **Observability** — SDK tracing (spec §14) plus application-level structured
   logs. The SDK's tracing backend is OpenAI-hosted by default; since the runtime
   now points at DeepSeek, tracing must be configured deliberately rather than
   assumed — see ADR 005.

---

## Decisions taken (were open at reconnaissance, now resolved with the user)

| # | Question | Resolution | ADR |
|---|---|---|---|
| D1 | Postgres provisioning | Docker, `pgvector/pgvector:pg17`, pinned | [002](docs/adr/002-postgres-pgvector.md) |
| D2 | Embeddings | Scoring-first; `w_s = 0`; `embedding vector(384)` column created in migration 1; backfill later | [004](docs/adr/004-context-retrieval.md) |
| D3 | Agent runtime | OpenAI Agents SDK, pointed at DeepSeek's OpenAI-compatible `baseURL`. **No OpenAI account needed.** | [005](docs/adr/005-agent-runtime.md) |

### Revision of D3

D3 was first answered as "OpenAI Agents SDK on a user-supplied OpenAI key",
because of the incorrect conclusion that DeepSeek had no OpenAI-format route.
After the correction above, D3 is revised: the same SDK, the same models the
endpoint already provides, and no new credential. This is strictly better than
both the original D3 and the hand-rolled-loop fallback, so it supersedes them.

### Blockers now

1. **Docker daemon** — required for Phase 2 (Postgres + pgvector). Still open.
2. **git identity** (`user.name` / `user.email`) — unset; commits cannot be
   authored until configured.

The former "OpenAI API key" blocker is **withdrawn**.

See `docs/implementation-plan.md` for the phase plan.
