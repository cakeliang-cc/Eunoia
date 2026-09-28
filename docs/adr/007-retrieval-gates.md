# ADR 007 — Two retrieval gates, and two widths

Extends [ADR 004](004-context-retrieval.md). ADR 004 fixed the score; this
records what was learned when it was implemented against real memories.

## Context

ADR 004 defined `score = w_s·similarity + w_i·importance + w_r·recency +
w_t·typePrior` and a single floor, `minScore`. Implementation exposed two
problems that the formula alone does not solve.

**1. A score floor cannot express relevance.** Importance and recency are
independent of topical connection. A memory reading "用户讨厌香菜" from
yesterday, marked important, scores well against the message "我明天要面试" —
nothing in it overlaps, and it wins anyway. The floor was doing one job
("is this good enough?") while two questions were being asked: *is this
prominent?* and *is this about the same thing?*

**2. The two callers of retrieval need opposite things.**

- **Automatic injection** runs before every turn with no human in the loop. A
  bad match is not rejected downstream — it is silently pasted into the system
  prompt, where it shapes the reply and is invisible afterwards. Precision
  matters more than recall: the failure mode is "the companion brought up
  something irrelevant and slightly unsettling", which is worse than silence.
- **The `search_memory` tool** is called *because the model decided it needed to
  know something*. It receives candidates it can read and discard. Recall
  matters more than precision, and a gate here removes exactly the items that
  would have helped.

## Decision

**Relevance is gated by `minSimilarity`, not `minScore`.** Both exist, with
distinct jobs:

| Term | Question | Behaviour |
|---|---|---|
| `minScore` | "Is this prominent enough to be worth a slot?" | Sanity floor, both paths |
| `minSimilarity` | "Is this about the same thing?" | Relevance gate, automatic path only |

`minSimilarity` is `null` on `DEFAULT_BUDGET` (the tool path) and `0.06` on
`AUTO_INJECT_BUDGET`.

**The two paths are deliberately different widths**, not one budget with a flag:

| | Automatic injection | `search_memory` (default) |
|---|---|---|
| `maxItems` | 4 | 6 (or the caller's `limit`) |
| `maxChars` | 900 | 1600 |
| `maxPerType` | 2 | 4 |
| `minScore` | 0.3 | 0.25 |
| `minSimilarity` | 0.06 | `null` |

**A status multiplier sits outside the sum**: `score × STATUS_FACTOR[status]`
(1.0 active, 0.85 unconfirmed). This is an addition to ADR 004's formula and is
recorded as such in `src/memory/retrieval.ts`. The four weighted terms decide
*relevance*; the multiplier is a judgement about how much to trust the ranking
at all, so it multiplies the result rather than competing with the terms.

**Similarity is lexical for now**: CJK character bigrams scored with the
**overlap coefficient**, not Jaccard. A short query matching one clause of a long
memory is a real match, and Jaccard divides by the union, punishing exactly that
case.

## Alternatives

1. **One budget, one gate.** Rejected: it makes the automatic path either too
   loose (irrelevant memories in every prompt) or the tool path too strict
   (useless results). The two callers genuinely want different things.
2. **Raise `minScore` instead of adding a gate.** Rejected: it would suppress
   genuinely important memories that merely lack a topical hook, which is the
   opposite of what the four-term score was built to value.
3. **Embeddings now.** Still unavailable — no embeddings route on the endpoint
   (ADR 004, re-probed and unchanged). The similarity function is injected, so
   turning it on later replaces one function and changes nothing else.
4. **Overlap gate on the tool path too, so both behave the same.** Rejected on
   the evidence: lexical similarity is crude, and "睡不好" vs "失眠" share no
   bigram at all. A gate there would hide the memory the person had just
   described in different words — from the one caller that can tell.

## Consequences

- `search_memory` results carry a `note` saying these are candidates, because the
  tool trusts the model to judge. The model is told it may ignore them.
- A memory that is relevant, unimportant, and stale is still injected
  automatically — correct, and pinned by test.
- `tests/service/context.test.ts` and `tests/tools/memory-tools.test.ts` assert
  the two paths behave *differently*, including a test that the tool has **no**
  overlap gate. The asymmetry is the design, so it is the thing under test.
- When embeddings arrive, `minSimilarity` values need re-tuning: cosine and
  bigram overlap do not share a scale.
