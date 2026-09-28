# ADR 008 — Buffered crisis turns, and a mechanical check on the way out

## Context

Spec §10 requires two things that do not obviously fit together: the persona is
the product, and safety outranks it. Phase 4 had to make that ordering real
rather than aspirational.

Two facts shaped the design:

**A system prompt is a request, not a guarantee.** The crisis directive tells the
model to name a real helpline, avoid minimising language, and not diagnose. It
will almost always comply. "Almost always" is not a standard to hold a safety
path to, and the one turn where it fails is the one turn where failure is not
recoverable.

**A rendered delta cannot be un-rendered.** The default path streams: the model's
tokens go to the person's screen as they are generated. If the reply is then
found unsafe, replacing it does not un-show it. Anything the person has already
read has been read.

## Decision

**1. Crisis turns are buffered; every other turn streams.**

`runTurn` withholds `text_delta` events when the assessed risk level is `crisis`,
holds the reply, runs the output check, and only then emits it — as a single
delta followed by `completed`, a shape a non-streaming client already handles.
`elevated` turns stream normally.

The cost is a delay of roughly one reply's generation time on a three-to-five
sentence answer. That cost was accepted knowingly: it is the only way the check
can be a check rather than a notification.

**2. The check is mechanical and shallow, and that is the point.**

`checkCrisisReply` inspects the text for four things:

| Violation | Trigger |
|---|---|
| `empty` | No reply at all |
| `no_resource` | Nothing matching a helpline, emergency number, or "go to a hospital" |
| `minimising` | "想开点", "加油", "会好起来的", "别人比你更惨", … |
| `diagnosing` | Naming a condition as fact about the person, hedged or not |
| `too_long` | Over `CRISIS_MAX_CHARS` (600) — the one sentence that matters is buried |

It cannot judge whether a reply is *good*. It can judge whether a reply is **safe
to send**, which is the only question it is asked.

**3. Failure substitutes fixed text, it does not regenerate.**

`CRISIS_FALLBACK` is a constant: it asks whether the person is safe, names
`120` / `110` / `12356` / `010-82951332`, does not diagnose, and does not ask
them to explain themselves. Regenerating would risk a second unsafe reply and
spend time the situation does not have.

**4. The fallback must pass its own check**, and there is a test asserting that it
does. A safety net with a hole in it is worse than a documented absence.

**5. The persona cannot override any of this.** The crisis directive opens with
"安全优先于人格设定" and states explicitly that the ordinary behavioural rules —
one question, don't rush to solve, don't judge — **让位** this turn. Which rule is
suspended, and by what, is asserted against the directive's own text.

**6. Elevated is reported, not replaced.** A merely-elevated message gets a
gentler directive and a check that reports violations into the log without
substituting the reply. Over-firing here would replace warm, appropriate replies
with a hotline script, which is a worse experience for the person and teaches
them not to say true things.

## Alternatives

1. **Stream everything and correct afterwards.** Rejected: it is not a check. The
   person has already read the unsafe reply.
2. **Buffer every turn.** Rejected: it gives up streaming — a real product
   property — everywhere to protect one path.
3. **Let a model judge the output.** Rejected for this path. It adds latency and
   a second failure mode to the one check that must be deterministic; a judge is
   the right tool for reply *quality* (§13) and the wrong one for whether a
   helpline number is present.
4. **Provider-level guardrails.** Not available on this endpoint, and a check
   that runs in another process is harder to test than one that runs here.

## Consequences

- Risk detection is pattern-based and therefore has both false negatives and
  false positives. The idiomatic guard is explicit: "累死了", "笑死", "想死你了",
  "烦死了" are not crisis signals, but a real signal inside an idiomatic sentence
  ("今天累死了，而且我真的不想活了") **is**, and a test pins that case.
- `assessment.reason` never contains the matched text — only a category label —
  because the assessment is logged. The text itself stays in the conversation
  and out of the logs (spec §14).
- A replaced crisis turn is persisted as the reply the person actually received,
  with the run recorded as `safety_replaced`. Storing what the model *would have*
  said would make the audit trail a record of something that never happened.
- A crisis turn emits one `text_delta` rather than many. Clients must not assume
  streaming granularity; the event contract already permits this.
