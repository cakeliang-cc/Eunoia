# ADR 011 — The prompt is a document; only the composition is code

Extends [ADR 001](001-single-agent.md) (one agent, one policy) and touches
[ADR 008](008-safety-buffered-turns.md) (the directive that stayed in code).

## Context

The user asked, in passing and without elaborating:

> 另外你的提示词应该从代码中抽离，放到一个单独的md文件中。

They are the person who will tune this. The observable consequence of the old
structure, for them, was that changing a sentence the companion says required
opening TypeScript.

The old structure was not accidental. It had a real argument behind it: the
behavioural policy lived as **data** in `behavioral-policy.ts` (`INTERACTION_PRINCIPLES`,
`FUNCTION_HEURISTICS`), `instructions.ts` rendered that data into prose, and a
test asserted that every principle's `rule` appeared in the rendered prompt. The
stated purpose was to stop the prompt and the assertions drifting apart.

That guarantee was real, and it cost something that was not noticed until the
measurement was taken. Two representations of one sentence means the sentence is
written twice, and the test exists to check the two copies match. It buys
*detection of a duplicate*, not the absence of one.

It also produced a specific defect. When the prompt was translated to Chinese,
the data and the renderer were edited separately, and the renderer kept emitting
`不急于解决（dont_rush_to_solve）` — the id, parenthesised, into the prompt. A
prompt asking the model to hold two names for one rule. That is what a rendering
layer between the prose and the model buys: a place for the two to disagree.

## Decision

**The standing system prompt is `src/agent/prompts/companion.md`.** It is read
once at startup, its leading HTML comment (a note to whoever edits it) is
stripped, and the result *is* `STABLE_INSTRUCTIONS`. `PROMPT_VERSION` hashes the
loaded bytes rather than a constant.

`src/agent/instructions.ts` keeps only the composition: what goes around the
prompt (retrieved memory, a per-turn safety directive) and in what order.

`src/agent/behavioral-policy.ts` is gone. What remains of it is
`prompt-contract.ts`: the spec's own labels and ids — §3's five principles, §2's
four lenses, §12 case 05's rumination signals — as **a checklist the document is
checked against**, holding no prose of its own.

Three things deliberately **stay in code**, and the boundary is worth stating
because "the prompt" could be read to include them:

| Stays | Why |
|---|---|
| Tool descriptions (`agents/tools.ts`, `tools/memory-tools.ts`) | They sit next to the schema they describe and are read from it by the SDK. A lookup table would put a tool's description somewhere other than the tool. |
| Per-turn safety directives (`safety/response.ts`) | Selected by a branch, and read together with the checks that verify compliance with them. Editing the wording without the check is the hazard; one file makes that harder. Safety text that fails to load is also the one load failure worth designing out. |
| Enum-keyed labels and reasons | Data matched by code, not voice. |

The line is **the standing prompt**, not "anything the model reads" — the latter
would be a rule about a boundary nobody is trying to cross.

## Consequences

- A prompt change is a document change. It is reviewable as a diff of prose, by
  someone who does not read TypeScript, and it cannot break the module that
  hashes it.
- **The extraction is verifiable, and was verified.** The migration was done by
  dumping the existing `STABLE_INSTRUCTIONS` to the file and loading it back:
  `PROMPT_VERSION` before and after is `e9eb3bc57a41` in both cases, and the
  string is 4121 characters in both cases. The model receives byte-identical
  instructions, so this change needs no evaluation run — which is a claim the
  version makes checkable rather than a claim to be taken on trust.
- The drift test is replaced by a narrower one. It can no longer assert that two
  copies agree, because there is one copy. What it asserts instead is what the
  *spec* requires of the document — the five principles in order, a boundary
  phrase inside each lens's own section, safety stated as outranking personality.
  These are section-scoped, so `焦虑` appearing in an example is not evidence
  that Ne is bounded.
- The prompt is read with `readFileSync` at import time. A missing or empty
  document throws rather than silently sending an empty system message. The
  build story (`tsconfig.build.json`, which does not currently exist) will need
  the document copied alongside the emitted module; this is noted in the
  CHANGELOG rather than papered over.
- `RUMINATION_SIGNALS` survives the move with no consumer in `src/`. It was dead
  before this decision too; it is now recorded as dead rather than filed under a
  module name that implied it was live.
