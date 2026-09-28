# ADR 005 — Agent runtime: OpenAI Agents SDK over DeepSeek

## Context

Spec §8 recommends the OpenAI Agents SDK. The model provider is DeepSeek, the
only provider for which this environment holds credentials
(`ANTHROPIC_BASE_URL=https://api.deepseek.com`, `ANTHROPIC_AUTH_TOKEN`; a working
DeepSeek API key).

DeepSeek documents itself as compatible with both the OpenAI and Anthropic SDKs:

```
base_url (OpenAI)    = https://api.deepseek.com
base_url (Anthropic) = https://api.deepseek.com/anthropic
models               = deepseek-flash, deepseek-v4-pro
```

### Correction to an earlier revision of this ADR

An earlier revision of this ADR concluded that the OpenAI Agents SDK was
**unusable** here, because the endpoint's OpenAI-format route was believed to
return 404. **That was wrong, and the decision built on it is retracted.**

The false negative had two compounding causes:

1. **A transient 404 was treated as a structural fact.** During the first probe
   window the endpoint was returning 404s for several routes, including
   `GET /v1/models`. All of them work. A control probe (8 consecutive calls,
   8/8 HTTP 200) confirms the endpoint is stable; the 404s were transient.
2. **An unknown model name was mistaken for a missing route.** Bad model names
   return HTTP 404 on the Anthropic route but HTTP 400 on the OpenAI route. The
   first probe used `deepseek-v4-flash` against a model namespace that was not
   yet resolving, and the resulting 404 was read as "this route does not exist"
   rather than "that call failed".

The lesson is recorded here because it shaped a real decision: **one observation
is not a finding.** Re-probe before concluding, and when a probe fails, check
whether a *control* probe fails too before attributing the failure to the thing
being tested.

## Decision

Use the **OpenAI Agents SDK** (spec §8) with `AsyncOpenAI` configured against
DeepSeek:

```ts
new AsyncOpenAI({
  baseURL: "https://api.deepseek.com",   // OpenAI-compatible surface
  apiKey: process.env.ANTHROPIC_AUTH_TOKEN,
})
```

The SDK drives DeepSeek through the **Responses API** (`/v1/responses`), which
DeepSeek implements natively — so the SDK's default model path works, and the
`OpenAIChatCompletionsModel` workaround is *not* needed.

Verified against the live endpoint before adoption:

| Capability | Route | Result |
|---|---|---|
| Responses API | `POST /v1/responses` | works, `status: completed` |
| Tool calling | Responses API | `function_call` output item with `call_id` + JSON-string `arguments` |
| Reasoning | Responses API | `reasoning` item with `reasoning_text` |
| Tool calling | `POST /v1/chat/completions` | `finish_reason: tool_calls` |
| Streaming | both | SSE deltas |
| Prompt caching | both | reported via `*_tokens_details.cached_tokens` |
| Stability | — | 8/8 HTTP 200 |

Provider construction is confined to **one module**. The agent core, memory
services, tools, guardrails, and evaluation never import a vendor SDK directly.

Model IDs must be the canonical `deepseek-flash` / `deepseek-v4-pro`. The aliases
`deepseek-chat`, `deepseek-reasoner`, and `deepseek-v4-flash` all silently resolve
to `deepseek-flash`; configuring `deepseek-reasoner` would therefore quietly run
the wrong model with no error.

## Alternatives

1. **Hand-rolled loop over the Anthropic Messages API.** Viable — verified
   working. Rejected as the default: the SDK supplies the loop, tool dispatch,
   guardrails, and tracing that §10 and §14 ask for, and rebuilding them is the
   unnecessary work §0 warns against. Retained as the fallback if the SDK proves
   incompatible in practice.
2. **Format-translation shim (OpenAI SDK ↔ Anthropic route).** Rejected. An
   extra fragile layer that would silently mistranslate tool-call and streaming
   semantics — the two capabilities most relied upon.
3. **Obtain an OpenAI account and run on OpenAI models.** Rejected as
   unnecessary: it adds a second vendor, a second credential, and a second bill
   to satisfy an SDK preference that DeepSeek's compatibility already satisfies.

## Why

The SDK's preference in §8 is about the *harness* — loop, tools, tracing,
guardrails — not about whose weights are behind it. DeepSeek's OpenAI-compatible
surface lets the project take the harness without taking the vendor, which is
strictly better than either alternative: spec §8 is honored, no new credential is
needed, and the provider stays swappable behind one module.

## Consequences

- **The former "OpenAI API key" blocker is withdrawn.** The existing
  `ANTHROPIC_AUTH_TOKEN` is a working DeepSeek key on all routes.
- **Tracing must be configured deliberately.** The Agents SDK's tracing backend
  is OpenAI-hosted by default; with no OpenAI credentials, the default exporter
  will fail. Tracing must be either disabled or pointed at a custom processor.
  Spec §14 wants traceable runs, so a custom processor plus application-level
  structured logs is the path — not disabling tracing.
- Model choice is a two-way decision (`deepseek-flash` vs `deepseek-v4-pro`), not
  a family. Both have a 1,048,576-token context window, which does **not** relax
  the §6 retrieval budget: the budget exists to control cost, latency, and
  attention dilution, not merely to fit the window.
- Prompt caching is available and reports hit/miss token counts. Long, stable
  instruction prefixes (the §11 prompt) should be ordered to benefit from it.
- Because the endpoint's Anthropic surface is unused by the runtime, the earlier
  Anthropic-route findings are retained in `CURRENT_STACK.md` only as the
  fallback path for alternative 1.
