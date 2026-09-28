# ADR 012 — Relationship state is derived, and narrative is a block rather than a retrieval result

Extends [ADR 003](003-memory-model.md) (the four layers) and
[ADR 007](007-retrieval-gates.md) (why retrieval is gated). Closes the §43
dimensions Phase 8 was written for.

**This ADR records a decision and its reversal.** The narrative block was
deferred on one observation, then built when four more contradicted it. Both
halves are kept, because the interesting part is not the answer but how thin the
evidence for the first one was.

## Context

The spec lists *Relationship State* as a component of context (§25) and
*Relationship Continuity* and *Narrative Continuity* as evaluation dimensions
(§43), and does not say what either is. `docs/REFACTORING_PLAN.md` proposed the
smallest useful version of each.

Two measurements were taken before anything was built, on the recorded rule that
evaluation cases come first — a change no case can see is a change nothing
verifies (§20).

**`relationship-01` — "我们之前聊过吧？你还记得我说过什么吗？" — scored 0.80
before the change, and the reply is the reason this ADR exists:**

> 说实话，我这边没有留下之前的记录——不是说你没说过，而是我这次打开时没检索到
> 存下来的东西。

That is a status report on a database query. The honest answer is "this is our
first conversation". The companion could not give it, because it had no way to
tell a first conversation from a two-hundredth — it had retrieval and nothing
else, so a question about the relationship had to be interpreted as a retrieval
problem, because retrieval was the only thing it had that could be wrong.

**`narrative-01` — "最近老是梦见小时候住的那个院子" against a seeded `narrative`
memory about 要不要回老家 — scored 0.50, and this is the measurement that went
the other way at first:**

> 这个院子，和你想回的那个老家，是同一个地方吗？

The reply *did* connect a lexically distant message to the running theme, through
`search_memory`. The 0.50 was a defect in the check's pattern list, not in the
reply — the list looked for `回老家` and the reply said `想回的那个老家`, which is
what happens when the patterns are written from imagination instead of from
observed output.

That single reply is what the first version of this ADR deferred the narrative
block on. **It did not replicate**, and the section below is the record of that.

## Decision

### Relationship state: derived, rendered every turn

**`src/memory/relationship.ts` derives it; nothing stores it.** Everything needed
is already in the schema — when the first conversation started, how many
conversations and messages — and the derivation is one aggregate query
(`historyStats`), which is faster to compute than to keep in sync.

A `relationship` table was the obvious alternative and was rejected on three
counts: it would need a migration (§1); it would disagree with the conversations
it summarises the moment one was deleted; and it would be a **cache of an
aggregate**, which is the definition of a thing that goes stale in exchange for
nothing.

**It is rendered on every turn, not gated by relevance.** This is the one place
where the design is deliberately asymmetric with retrieved memory, and the
asymmetry is the point: *"is knowing you for three months relevant to this
turn?"* answers itself. Worse, a relevance-gated relationship block would be
absent on exactly the turn it was needed — the turn where someone asks whether
you remember them mentions no topic at all, so there is nothing to match on.

**No stage taxonomy.** There is no "new / familiar / close". The bands would be
invented numbers, and a companion that behaves differently on day 13 than on day
14 is worse than one that reads the facts. The only derived judgement is the
boolean the failure turned on — whether there has *been* a relationship, which is
a question with an answer, unlike "are we close". The one threshold
(`FIRST_MEETING_MESSAGES = 6`) exists because a first conversation is not over
when the first message is: at message two the companion must not claim to know
someone, and by message six it must stop disclaiming a relationship it has begun
to have.

**Two rules about what the model may do with it**, both encoded in the rendered
block and in the prompt document:

| Rule | Why |
|---|---|
| It is never announced | "我们已经认识 34 天了" is a strange thing to say to a person. It is a fact about the companion's situation, not a contribution to the conversation — the same rule the memory block carries. |
| A first meeting is stated, not performed | The block says what is true and lets the model find its own words. A script here would make every first conversation identical, which is its own failure. |

### The narrative block: deferred, then built — and why it was reversed

**Deferred in the first version of this ADR.** The reasoning was that
`narrative-01` had just shown the model reaching the running theme on its own
through `search_memory`. One observation of the tool route working, against a
permanent per-turn cost, is not a trade worth making — and a block no case could
see would violate the rule this phase is otherwise built on.

**Reversed by four observations.** `narrative-01` was run four more times at the
next prompt. `search_memory` was not called once, and every reply treated the
dream as a thing to explore in the present tense. Three of the four were scored
1.00 or 0.75 by a check defect rather than by the reply — see below — but the
replies are the evidence, not the scores:

| # | prompt | connected the theme? | tools |
|---|---|---|---|
| 1 | `1e0d7fcd97a2` | yes — *"和你想回的那个老家，是同一个地方吗？"* | `search_memory` |
| 2 | `372297600bf1` | no | none |
| 3 | `372297600bf1` | no | none |
| 4 | `372297600bf1` | no | none |
| 5 | `372297600bf1` | no | none |

**Then the mechanism, measured offline and deterministically.** The reason is not
that the model is unreliable; it is that the memory never arrives:

```
candidates 1 · selected 0 · dropped {below_min_similarity: 1}
```

The theme ("纠结要不要离开现在的城市、回老家") and the message ("最近老是梦见
小时候住的那个院子") share no terms, so `selectMemories` drops the memory at
`minSimilarity = 0.06` before the model sees anything. This is the gate working
as designed (ADR 007) — which is the point. **Narrative content is the one kind
that cannot be delivered behind a similarity gate**, because a theme is by
definition phrased differently every time it comes up. The four replies are what
a companion looks like when its only route to someone's ongoing story is a tool
call that may not happen.

That is a case the plan predicted and the measurement confirmed, so the block was
built: `src/memory/narrative.ts`.

**Design, and what is deliberately not in it:**

| Decision | Why |
|---|---|
| Selected by importance and recency, with **no query term** | There is no similarity to gate on — that is the whole reason the block exists. Ranking on the two terms that remain is the only honest option, and it means a theme surfaces because it matters, not because this turn happened to mention it. |
| Budget of **3 themes / 400 characters** | Tighter than `AUTO_INJECT_BUDGET`'s four items and 900 characters, because this block is unconditional: retrieved memory costs nothing on a turn with no match, while these lines are sent on every one. |
| `active` only, never `unconfirmed` | The block is headed 这是 ta 正在经历的事. An unconfirmed narrative is the model's own guess about someone's life, and a guess cannot be stated in that voice — the same reason the source labels exist. |
| Removed from the retrieval candidates | A narrative that *does* pass the gate would otherwise be rendered twice, once as a theme and once as a retrieved fragment. Two voices saying one thing read as two things. |
| Switched off by `retrieve: false`, unlike the relationship block | That flag is the person's memory switch. A companion that stopped citing facts but kept narrating someone's life back to them would have ignored the request in the way that matters most. |

**A check defect was found and fixed in the course of this**, and it is worth
recording because it is the second time the same mistake was made in one
afternoon. Fixing `holds-the-thread` to stop missing `老家` introduced `回去`，
which then matched *"梦里常回去"* — returning to a courtyard in a dream, not to
the running theme — and scored a reply that never mentioned the theme at all as
1.00. `反复` did the same thing a second time (*"反复梦见同一个地方"* is a generic
statement about recurring dreams). The pattern list now names **subjects** — the
place, the decision — and no word that a subject happens to share with something
else in the sentence. The lesson is in the CHANGELOG as well: a pattern list
written from imagination scores the reply that is in front of it, and a pattern
list widened until the number looks right stops measuring anything.

### The three profile tools: deferred (spec §26)

`getUserProfile`, `getRelationship`, `getNarrative` are **not implemented**. A
tool is redundant when the same content is already in the prompt on every turn,
and each added tool is a new way for the model to pick wrong — a non-zero cost
even when it picks right. They become right when the content grows large enough
that always-on stops being affordable, which is a measurement.

`getUserProfile` has a second problem: it duplicates what the preference store
and semantic memories already provide. It needs an argument before it needs code.

## Consequences

- **The failure is fixed and pinned.** `relationship-01`'s reply goes from a
  database report to a statement about the two of them, and the prompt document
  now carries the rule (`# 你们之间已经发生的事`) that makes the honest answer
  the available one.
- **The narrative block is pinned to the gate it exists because of.** The test
  asserts both halves at once: that `selectMemories` drops the theme at
  `minSimilarity`, and that `selectNarratives` carries it. If the first half ever
  stops being true — an embedding provider would change the arithmetic — the test
  fails and says the block has become redundant, which is a thing worth being told
  rather than discovering by accident.
- **The evaluation harness got three repairs along the way**, all of which had
  been making measurements lie: a replay absorbed a live model call while still
  reporting `mode: 'recorded'` (now named on the run as `liveDuringReplay`); a
  filtered run wrote a partial recording that `--replay` would pick up as the
  baseline (now refused); and `--replay` picked its file by **filename**, which
  sorts by prompt hash rather than by time, so it replayed a two-generation-old
  recording while reading as a normal replay (now sorted by the timestamp). The
  third was found only because the first had already been fixed — the gap-filling
  count came back as six instead of zero.
- **Relationship state is not authentication and holds nothing.** It is two
  counts and two dates, computed from rows the person can already see in their
  own history. Deleting a conversation changes it, which is correct — the
  alternative is a stored number that disagrees.
- **A store that cannot answer loses the block, not the turn.** `relationshipFor`
  swallows any error and returns `''`. Same reasoning as the fire-and-forget
  access accounting beside it: a count query is not worth failing a message over.
- **`narrative-01` stays in the suite as a proxy, and a proxy is not a
  measurement.** Its `holds-the-thread` check matches the *shape* of naming the
  running theme, and it is marked `expectation` rather than `violation` so a miss
  lowers the score without failing the case. It has now been rewritten twice — a
  list that missed `老家`, then one that matched `回去` in *"梦里常回去"* and `反复`
  in *"反复梦见同一个地方"* — and both times the corrected version scored a reply
  *lower* than the broken one, which is the direction a check should move when it
  is fixed. A single case for a whole §43 dimension remains thin, and this one is
  the thinnest in the suite.
- **The block was built on five observations, not on a proof.** Four failures and
  one success is enough to reverse a deferral — deferring costs nothing, and the
  cost of being wrong about a *missing* feature is paid by the person — but it is
  not enough to claim the block works. The next full run is the evidence for that,
  and the honest statement until then is that the mechanism is now present and the
  reply quality is unmeasured.
- **The deferred tools leave a visible gap**, recorded in
  `docs/REFACTORING_PLAN.md` Phase 9 rather than silently dropped.
