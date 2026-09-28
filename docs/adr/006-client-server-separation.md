# ADR 006 — Client/server separation for a future mini-program

## Context

The product will be demonstrated through a **web** client first. The user
intends to **switch to a WeChat mini-program (小程序) later**, and asked for the
separation to be built in from the start rather than retrofitted.

This is not a hypothetical. The transport and auth choices that suit a browser
are not the ones a mini-program offers, and any of them that leak into the agent
core turn the migration into a rewrite.

### What mini-programs actually support (researched, not assumed)

The common claim that "mini-programs don't support SSE" is misleading. There is
no native `EventSource` and no `fetch` `ReadableStream`, but **chunked streaming
works**: `wx.request({ enableChunked: true })` plus
`requestTask.onChunkReceived`, decoding `ArrayBuffer` chunks and parsing the SSE
framing by hand. Ready-made clients exist (`cross-sse`, `uni-sse`, `native-sse`).

Requirements and pitfalls that constrain the server side:

- Base library **≥ 2.20.0** for `enableChunked`; **≥ 2.21.0** for native
  `TextDecoder` (below that, a polyfill is needed).
- Chunk boundaries are arbitrary and **differ between simulator and real
  device**, so multibyte UTF-8 characters can split across chunks — the parser
  must buffer partial bytes and handle `\r\n`, `\n`, and `\r`.
- **The server must not buffer the response.** Behind a proxy this means
  `proxy_buffering off`, `X-Accel-Buffering: no`, HTTP/1.1, no compression,
  and a long read timeout — otherwise the stream arrives all at once and the
  typewriter effect silently disappears.
- Enterprise WeChat on iOS has reported `onChunkReceived` never firing, with no
  error. Client-side fallback handling is therefore a real requirement, not
  defensive padding.

**Conclusion: the SSE wire format is portable to the mini-program.** Only the
client-side transport differs. WebSocket is not required.

## Decision

Enforce a one-way dependency boundary, using the spec §17 structure:

```
src/agent/  src/memory/  src/tools/  src/safety/  src/evaluation/   ← CORE
        │  transport-agnostic. No HTTP, no framework, no cookies.
        ▼
src/api/    ← TRANSPORT BOUNDARY. Owns HTTP, SSE framing, auth headers.
        │
        ▼
web/        ← WEB CLIENT (and later: miniprogram/)
```

1. **The core emits an `AsyncIterable<AgentEvent>`, not a response.** The core
   never knows whether the bytes become an SSE frame, a WebSocket message, or a
   test assertion.
2. **`src/api/` is the only place that knows about HTTP.** It adapts the event
   stream to SSE framing.
3. **Auth is an explicit bearer token**, never cookie-only sessions, so the
   mini-program flow (`wx.login` → code → server session) can reuse the same
   server-side contract.
4. **The boundary is enforced by a test**, not by discipline: a test asserts that
   nothing under `src/agent/`, `src/memory/`, `src/tools/`, `src/safety/`, or
   `src/evaluation/` imports from `src/api/`, `express`/`fastify`/`hono`, or any
   client directory. Same mechanism as the model-ID guard (ADR 005).
5. **The API contract is documented as a versioned artifact** so a mini-program
   client can be built against it without reading the server source.

## Alternatives

1. **Next.js (or another full-stack framework) with server actions.** Rejected.
   It couples agent logic to a web framework's request lifecycle and RSC
   transport; the mini-program would need an entirely separate backend, which is
   exactly the outcome this ADR exists to prevent.
2. **WebSocket from the start.** Rejected as premature. Chunked SSE is verified
   viable on mini-programs, and WebSocket adds connection lifecycle, reconnect,
   and auth-over-handshake complexity to Phase 1 for no present benefit. The
   adapter seam means adding a WS transport later is additive, not a rewrite.
3. **A monorepo with npm workspaces immediately.** Deferred. The separation that
   matters is the *dependency direction*, which a test enforces; workspace
   tooling adds build complexity the spec §0 warns against. It can be introduced
   when a second client actually exists.

## Why

The user's request is satisfied by a boundary, not by a framework. Making the
core emit events rather than responses costs nothing today and makes the
mini-program a new adapter plus a new client — the migration they asked for.

## Consequences

- `AgentEvent` becomes a first-class core type with tests, since it is the
  contract every future client depends on.
- The server must be served over HTTP/1.1 without response buffering for
  streaming to work; this is a **deployment** requirement, recorded here because
  it will not surface in local development and is the most likely cause of
  "streaming works on my machine".
- Phase 1 ships the SSE adapter and a minimal web client. The mini-program
  adapter is out of scope until a later phase.
- A future client that cannot stream (iOS WeCom, per the research) must degrade
  to a non-streaming response; the core already supports this because a
  non-streaming reply is just an event stream with one terminal event.
