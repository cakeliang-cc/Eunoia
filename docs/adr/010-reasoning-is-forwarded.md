# ADR 010 — The reasoning phase is forwarded, not discarded

Extends [ADR 006](006-client-server-separation.md) (the event contract) and
[ADR 008](008-safety-buffered-turns.md) (buffered crisis turns).

## Context

A complaint that the product "was not streaming" turned out to be false in the
literal sense and correct in every sense that mattered. Measured against the
live endpoint, a single turn produced:

```
    536  thinking_delta   first +1.65s   last +9.07s
      1  thinking_done    +9.12s
     56  text_delta       first +9.12s   last +9.89s
      1  completed        +10.06s
```

The transport was streaming perfectly. The reply was arriving at roughly
160 characters per second, each delta in its own HTTP write. But **nothing was
sent to the client between +0s and the first visible character** — a window
measured at 3.67 seconds once and 17.83 seconds another time, entirely occupied
by the model reasoning, and entirely invisible.

The cause was one matcher. The SDK normalises text deltas — DeepSeek's wire type
`response.output_text.delta` arrives as `output_text_delta` — so the code
matched that name. It does **not** normalise reasoning: the provider event is
passed through raw, wrapped under a generic `model` type, with the useful fields
one level deeper:

```jsonc
{"type":"model","event":{"type":"response.reasoning_text.delta","delta":"我们需要", ...}}
```

A matcher written by analogy with the text one therefore found nothing, and 536
events per turn were dropped on the floor. The reply still completed, which is
why every offline test stayed green: the only symptom was a person watching a
static `…`.

## Decision

**Add `thinking_delta` / `thinking_done` to the event contract, and forward the
reasoning to the client.** Do not change the model's reasoning effort.

The reasoning is model-authored text that reaches a client, so it is a first
class member of `AgentEvent` and appears in `CONTENT_EVENT_TYPES` — a caller
counting what the model produced (a fingerprint, a length cap, a redaction pass)
has to know about it.

Three properties are part of the contract, not incidental:

- **`thinking_done` is sent at most once per turn, and only after at least one
  `thinking_delta`.** It is emitted on whichever comes first: the provider's own
  end-of-reasoning signal, the first character of the reply, or the end of the
  stream. A model that reasons and then calls a tool produces no reply text
  before the call, so the stream-end case is load-bearing. A client never has to
  guess whether a thinking block is still live.
- **A client may ignore it.** Dropping every `thinking_delta` yields exactly the
  previous behaviour; the reply is complete without it. This is what keeps a
  future mini-program adapter free to not render it.
- **It is never persisted.** Reasoning is not written to the conversation, is
  not replayed as history, and is not fed back to the model as something it
  said. Only a character count reaches the log — never the text (spec §14).

Crisis turns buffer it exactly as they buffer the reply, for the same reason: a
rendered thought cannot be un-rendered either. Reasoning that argued toward a
reply the safety check then discards is the last thing anyone should be shown.

## Alternatives considered

**Reduce `reasoning.effort`.** Measured on the live endpoint, this works
mechanically — `effort: 'none'` cut time-to-first-character from 15.56s to
1.91s. Rejected as the fix, because it changes the product rather than its
presentation: at `none` the reply was 332 characters against 615 at the default,
and a companion whose defining behaviour is *thinking carefully about what you
said before answering* is the wrong place to buy speed by thinking less. Per
spec §20 any such change needs an evaluation run to justify it, and none has
been run. The setting is real and available; if latency ever needs to come down
further, that is the lever, and it needs a measured quality comparison first.

**Show a content-free progress signal** (a pulse, "正在想…") instead of the
reasoning text. This was the lower-risk option and was rejected on the user's
explicit instruction that the thinking may be shown. It remains the fallback if
the raw reasoning proves distracting in use — and because a client may ignore
`thinking_delta`, reverting to it is a client-side change only.

**Merge the reasoning into `text_delta`.** Rejected: they are different things
to a client. The reply is the product; the reasoning is a working-out that a
client may collapse, hide, or drop. Merging them would make the reply
inseparable from a part of it that is not the reply, and would put the model's
notes into the transcript.

## Consequences

- **The perceived-latency bug is fixed without touching the model.** Time to
  first frame went from 17.83s to 1.65s on the same prompt and the same settings.
- **The reasoning text is now visible to the person.** This is a real change in
  what the product shows, and it may read as stranger than the reply does. The
  mitigation is presentational (collapsed, subdued, closed automatically) rather
  than substantive.
- **A wire-shape dependency is now pinned by a live test.** The offline test
  asserts the parser against a captured fixture; only `npm run smoke` can notice
  that the provider or the SDK changed the shape underneath it. That asymmetry
  is the same one that produced this bug.
