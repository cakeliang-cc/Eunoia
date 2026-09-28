# Changelog

All notable changes to this project are documented in this file.

Entries are grouped under `Added` / `Changed` / `Fixed` / `Architecture` /
`Evaluation` / `Known Issues` so that a new engineer can reconstruct how the
project evolved without reading the full diff history.

## [Unreleased]

### Added

- Nothing yet.

### Changed

- Nothing yet.

### Fixed

- Nothing yet.

### Architecture

- Nothing yet.

### Evaluation

- Nothing yet.

### Known Issues

- Nothing yet.

---

## [0.1.0] — 2026-09-28

Phase 0 (reconnaissance) and Phase 1 (minimal agent) of
`docs/implementation-plan.md`. The repository was empty at the start of this
release: no existing stack was replaced, and everything here is new.

### Added

**Documentation and decision records**

- `CURRENT_STACK.md` — reconnaissance of the environment and the model endpoint.
- `docs/implementation-plan.md` — phased plan with verification gates.
- `docs/adr/` — Architecture Decision Records 001–006:
  - `001-single-agent.md` — one agent; Fi/Ne/Si/Te are heuristics, not agents.
  - `002-postgres-pgvector.md` — Postgres + pgvector via a pinned Docker image.
  - `003-memory-model.md` — four-layer memory; three persisted layers share one
    discriminated table carrying `confidence` / `source` governance columns.
  - `004-context-retrieval.md` — scored, budgeted retrieval; embeddings deferred
    behind an injected similarity term, with the vector column created up front.
  - `005-agent-runtime.md` — OpenAI Agents SDK over DeepSeek's OpenAI-compatible
    surface; includes the correction of an earlier wrong conclusion.
  - `006-client-server-separation.md` — core emits `AsyncIterable<AgentEvent>`;
    `src/api/` is the only HTTP-aware layer, so a future mini-program client is
    an adapter rather than a rewrite.

**Phase 1 — minimal agent**

- `src/config.ts` — canonical model IDs, endpoint, and API-key resolution.
- `src/agent/events.ts` — the `AgentEvent` contract between core and clients.
- `src/agent/behavioral-policy.ts` — the interaction principles and function
  heuristics as **data**, so they are testable rather than prompt-only prose.
- `src/agent/instructions.ts` — the spec §11 system prompt, composed from modular
  sections and rendering the policy above.
- `src/agent/model-client.ts` — the only module that constructs a provider.
- `src/agent/infp-agent.ts` — the single agent and its event-stream translation.
- `src/observability/logging.ts` — structured logs that never carry user content.
- `src/observability/tracing.ts` — a custom trace processor replacing the SDK's
  OpenAI-hosted exporter, which cannot authenticate here.
- `src/api/sse.ts`, `src/api/server.ts` — the SSE transport and HTTP server.
- `web/index.html` — a minimal web client that streams replies.
- Test suite: 35 offline tests plus one live smoke test behind `RUN_SMOKE=1`.

### Fixed

- **Corrected a wrong conclusion about the model endpoint.** An earlier revision
  of `CURRENT_STACK.md` and ADR 005 recorded that `POST /v1/chat/completions`
  returned 404 and that the OpenAI Agents SDK was therefore unusable. **That was
  wrong.** The 404s came from a transient window (in which `GET /v1/models` also
  404'd), compounded by reading a bad-model-name error as a missing route.
  Re-probed and verified: chat completions, the Responses API, tool calling on
  both, streaming, and 8/8 stability. The decision built on the wrong conclusion
  was retracted and rewritten.
- **Fixed streaming emitting zero deltas.** The SDK *normalises* the provider's
  `response.output_text.delta` to `output_text_delta` and nests the original
  under `providerData`. Matching only the wire name produced a reply that
  completed correctly but streamed nothing — invisible to every test that did not
  call live. Both names are now accepted, and
  `tests/agent/stream-events.test.ts` pins it.
- **Fixed a race reading the final output.** The stream iterator can finish
  before the run is marked complete, so `finalOutput` was read too early,
  emitting an SDK warning and risking a partial value. `await result.completed`
  now precedes the read.

### Architecture

- **Reconnaissance established the project is greenfield.** No `package.json`,
  no git repository, no existing agent/backend/database code. Nothing was
  replaced; the stack was chosen from scratch against the spec's recommendations.
- **Spec §8's SDK recommendation is satisfiable as written.** The OpenAI Agents
  SDK drives DeepSeek directly via `AsyncOpenAI({ baseURL })`, using the
  Responses API, which DeepSeek implements natively — so the SDK's default model
  path works and no chat-completions adapter is needed. Model provider and agent
  harness are decoupled behind a single provider module.
- **Model namespace is only two IDs, and aliases resolve silently.**
  `deepseek-flash` and `deepseek-v4-pro` are the only real models;
  `deepseek-chat`, `deepseek-reasoner`, and `deepseek-v4-flash` all resolve to
  `deepseek-flash` without error. A misconfigured name would run the wrong model
  silently rather than fail, so only canonical IDs may appear in code, enforced
  by `tests/architecture/model-ids.test.ts`.
- **Tracing required deliberate configuration.** The SDK exports traces to an
  OpenAI-hosted backend by default; that exporter cannot authenticate here. A
  custom processor writes structured spans instead, and fingerprint tool
  arguments rather than logging them.
- **Client/server separation adopted ahead of a planned mini-program migration.**
  The product ships on web first and will move to a WeChat mini-program later.
  Research confirmed the SSE wire format **is** portable there via
  `wx.request({ enableChunked })` + `onChunkReceived` with a hand-written frame
  parser — there is no native `EventSource`, but chunked streaming works, so
  WebSocket is not required. The boundary is enforced by
  `tests/architecture/boundaries.test.ts`.
- **The "only one module imports the vendor SDK" claim was narrowed after the
  boundary test disproved it.** The agent module and the tracing processor
  necessarily use SDK primitives; abstracting those away would mean
  reimplementing the SDK. The invariant that is both true and worth protecting
  is that the **product-logic layers** (`memory`, `tools`, `safety`,
  `evaluation`) and the **transport layer** (`api`) never import it.
- **Clients parse SSE frames by hand rather than using `EventSource`.**
  `EventSource` only issues GET, and the chat endpoint is POST — correctly so,
  because putting a user's message in a URL would leak it into access logs and
  browser history. Reading the response body as a stream is also what the
  mini-program client must do, so the logic transfers.
- **Deployment requirement recorded:** SSE must not be buffered. Without
  `proxy_buffering off` / `X-Accel-Buffering: no`, no compression, HTTP/1.1, and
  a long read timeout, streaming silently degrades to a single response. This
  will not surface in local development.

### Evaluation

- No evaluation framework yet. To be introduced in Phase 3, per the plan. The
  live smoke test asserts only mechanical properties (the stream produces text
  and terminates) and deliberately does **not** score reply quality — an
  assertion about tone at this stage would be a guess dressed as a test.

### Known Issues

- **Phase 1 is single-turn.** No conversation history is kept, so the agent
  cannot refer to the previous message in the same session. This is deliberate:
  history belongs with the `conversations` / `messages` tables in Phase 2, and
  building it earlier would mean building it twice.
- **No memory tools exist yet.** `search_memory` / `save_memory` /
  `update_memory` (spec §9) are Phase 2. The system prompt already describes the
  memory rules, but there is nothing for the agent to call.
- **No guardrails yet.** The safety *rules* are in the prompt, but spec §10's
  input/output guardrails are Phase 4. Nothing currently enforces the safety
  rules mechanically; they rely on the model following instructions.
- **No PostgreSQL server, and the Docker daemon is not running.** Only the
  `libpq` client (17.6) is installed. This blocks Phase 2 provisioning. See
  ADR 002.
- **No embedding provider available.** Established with a control probe: 12/12
  requests across `/v1/embeddings`, `/embeddings`, `/v1/embed`, and
  `/beta/embeddings` returned 404 while a control request of identical shape to a
  known-good route returned 200 — the failure is route-specific, not flakiness.
  The model list contains exactly two models, neither an embedding model. See
  ADR 004.
- **No git identity configured.** `user.name` and `user.email` are unset both
  globally and in the repository, so commits cannot be authored yet.
- **`eslint` pinned to v9.** `@eslint/js@10` requires eslint 10; `@eslint/js` is
  pinned to `^9` to match. Revisit together when upgrading.
