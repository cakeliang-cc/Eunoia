# Refactoring Plan

Required by spec §42 ("建立渐进式 roadmap") and §43 ("先记录到
`docs/REFACTORING_PLAN.md`"). It was missing until now; this file is that
document.

Two rules from the spec govern how it is used, and both are load-bearing:

- **§42: 不要一次完成全部阶段.** This is a roadmap, not a queue. A phase being
  written here is not a commitment to build it.
- **§28: Start simple.** Everything below is sized so that the smallest useful
  version comes first, and the rest is explicitly deferred with a reason. A
  phase that cannot be started without a large change is a phase that should be
  split, not scheduled.

Status is honest rather than aspirational. Where something is deliberately not
built, the reason is written down, because "not yet" and "forgotten" look
identical in a repository.

---

## Where the project is against spec §42

| # | Phase | Status |
|---|---|---|
| 0 | Repository Audit | ✅ `CURRENT_STACK.md`, ADRs 001–005 |
| 1 | Reference Integration | ✅ hello-agents read, not copied (§6–§11); no code taken |
| 2 | Architecture Stabilization | ✅ the client/server boundary, ADR 006 |
| 3 | Agent Core | ✅ one agent, four lenses, ADR 001 |
| 4 | Conversation / Session | ✅ conversations, messages, history, naming |
| 5 | Memory | ✅ four layers minus preference (ADR 003); write policy; scored retrieval (ADR 007) |
| 6 | Context Engineering | ✅ automatic memory injection + risk (ADR 008); relationship and narrative blocks assembled (ADR 012) |
| 7 | INFP Persona | ✅ the prompt document (ADR 011), five principles, four lenses, evaluated |
| 8 | Relationship + Narrative | ✅ both built; the narrative deferral and its reversal are in ADR 012 |
| 9 | Tools | ⏳ three of six (§26) |
| 10 | Evaluation | ⏳ 30 cases, 9 of §43's 12 dimensions |
| 11 | Frontend Integration | ⏳ web client shipped (ADR 006); mini-program adapter deferred by design |
| 12 | Production Hardening | ❌ not started; the blockers are named in `CHANGELOG.md` |

---

## Evaluation dimensions (spec §43)

The spec names twelve and says "第一阶段不要全部实现". This table is the record of
which are actually measured, and — more usefully — which are not.

| Dimension | Measured by | Status |
|---|---|---|
| Personality Consistency | `persona_consistency` (2 cases) | ✅ |
| Emotional Attunement | `emotional_attunement` (2) | ✅ |
| Value Clarification | `no_premature_solving` (3) | ✅ |
| Non-directiveness | `boundary` (3), `question_discipline` (2) | ✅ |
| Gentle Challenge | `gentle_challenge` (2) | ✅ |
| Memory Accuracy | `memory` (3), `no_fabricated_memory` (2) | ✅ |
| Memory Relevance | budget and gate tests in `tests/memory/` | ✅ (offline, not a case) |
| Reality Grounding | `no_judgment` (2) — the fact/interpretation split | ✅ |
| Response Helpfulness | `light_intent` (4) | ⏳ partial |
| Narrative Continuity | `narrative_continuity` (1) | ✅ (a proxy, and recorded as one) |
| Relationship Continuity | `relationship_continuity` (1) | ✅ |
| Context Relevance | retrieval tests, not a case | ⏳ partial |

Phase 8 closed the two rows that were ❌, and they were closed in that order for a
reason: a dimension with no case *and* no feature behind it is not a gap in the
suite, it is a gap in the product that the suite would be unable to see even if it
had a case. That is the lesson `light_intent` taught, and it is why both cases
here were written and run before the relationship block existed — the "before"
reply is the evidence that the feature was needed, and it is quoted in ADR 012.

`Narrative Continuity` is ✅ with a caveat that is worth more than the tick: its
single check matches the *shape* of referring back to a running theme, not the
theme itself, which makes it a proxy — and writing it went wrong twice in one
afternoon (a list that missed `老家`, then one that matched `回去` in *"梦里常回去"*
and `反复` in *"反复梦见同一个地方"*). The patterns now name subjects rather than
words. A proxy that has been rewritten twice is not a measurement, and the honest
status of this row is "✅, thin".

`Response Helpfulness` is marked partial on purpose: the four light-intent cases
measure "does it give what was asked for", which is one third of helpfulness.
Warmth is not mechanically checkable and no case pretends otherwise.

Two of those four cases were measuring less than they appeared to. `light-04`
scored a clean 1.00 on the reply the changelog names as its failure, because the
check written for that failure did not contain the phrase — so a whole category's
headline defect could have returned with the suite green. The repair is not more
patterns but a falsifier: `tests/evaluation/cases.test.ts` now replays the four
recorded failures against the checks that are supposed to catch them, and the
mutation that deletes the patterns turns it red. A case count is a claim about
coverage; that block is what makes the claim checkable — and it is why this row
stays ⏳ rather than ✅, because a category that can now fail is not the same as
a category that is complete.

---

## Phase 8 — Relationship + Narrative

**The gap.** The product's premise is 长期陪伴 — a companion that knows you over
time. Today the companion knows *facts* about a person (memories) and nothing
about the *relationship*: it cannot tell a first conversation from a two-hundredth,
so it cannot greet a familiar person differently from a stranger, and it has no
view of the story a person is in the middle of. The two §43 dimensions fall out
of that.

**Design, smallest useful version:**

- **Relationship state is derived, never stored.** Everything needed is already
  in the schema: when they first spoke, how many conversations and messages, how
  many memories. A stored copy would need a migration (§1), would drift from the
  rows it summarises, and would buy nothing — the derivation is one aggregate
  query.
- **It is rendered into every turn**, like retrieved memory, because continuity
  is not relevance-gated. Asking "is knowing you for three months relevant to
  this turn?" answers itself — and a relevance-gated block would be absent on
  exactly the turn it was needed, because "你还记得我吗" mentions no topic.
- **Narrative is a separate, tightly-budgeted block** drawn from `narrative`-type
  memories. `narrative` already exists as a memory type and the label is already
  written (你正在经历的); what is missing is that nothing renders it as
  continuity rather than as one more fact competing for a retrieval slot.
  → **Built, after being deferred and then reversed.** The first decision rested
  on one run where the model reached the theme through `search_memory`; four more
  did not replicate it, and the cause is deterministic — the theme and the message
  share no terms, so `selectMemories` drops the memory at `minSimilarity` before
  the model sees anything. A similarity gate cannot deliver a theme that is
  phrased differently every time it comes up. Both halves of the decision are in
  [ADR 012](adr/012-relationship-and-narrative.md).
- **Three tools are deferred** (`getUserProfile`, `getRelationship`,
  `getNarrative`, §26) with a reason recorded in ADR 012: a tool is redundant
  when the same content is already in the prompt every turn, and each added tool
  is a new way for the model to pick wrong. They become right when the content
  grows large enough that always-on stops being affordable — which is a
  measurement, not a guess.
- **Two evaluation cases** (`relationship_continuity`, `narrative_continuity`),
  written first, on the recorded rule.

**Not in this phase:** relationship *stages* with behavioural rules attached (a
stage taxonomy nobody has calibrated), a relationship timeline UI, and any
storage of the relationship as its own table.

**Status: done.** `src/memory/relationship.ts` and `src/memory/narrative.ts`,
`historyStats` on both stores, both blocks threaded through `buildInstructions` →
`createCompanionAgent` → `runTurn`, and two rules in the prompt document
(`# 你们之间已经发生的事`, `# ta 正在经历的事`). Full reasoning, including the
reversal, in [ADR 012](adr/012-relationship-and-narrative.md).

## Phase 9 — Tools

Remaining from §26: `getUserProfile`, `getRelationship`, `getNarrative`. **No
longer blocked on Phase 8 — decided by it**: the same content is in the prompt on
every turn, so a tool for it is a second route to a result that already arrives.
`getUserProfile` duplicates what the preference
store and semantic memories already provide, so it needs an argument before it
needs code.

## Phase 10 — Evaluation

Unchanged beyond Phase 8's two cases: `Response Helpfulness` wants more than
four cases, and there is still no judge model — every check is mechanical, which
is why tone is uncovered and said to be.

## Phase 12 — Production Hardening

Two of the three blockers remain, and they are the two that need something this
project does not have: **identity is a handle rather than authentication**
(ADR 009) wants real auth, and **there is no rate limiting** wants a decision
about who the users are and what they may spend.

The third — **no retention sweep, so evaluation runs accumulated throwaway
users** — is closed by [ADR 013](adr/013-retention-and-deletion.md). It was
buildable from inside the project once the question was framed as "which rows
does a sweep have a right to touch" rather than "how do we recognise an
evaluation user": `users.external_id` had been declared for exactly this in the
first migration and never written. The measurement of the gap is in the ADR —
589 users, 355 conversations, 512 messages from evaluation runs alone.

The lesson worth keeping is the one the plan's own wording hid. This section said
none of the three "can be closed without a decision the user has not made", and
that was true of two of them and a false equation of the third: retention needed
no decision, only a mark that already existed in the schema.

**A fourth item was on the list less visibly and is now done: `npm run build`
was a script that could not run.** It was a known issue rather than a blocker —
nothing in development depends on it, because `npm run dev` runs the sources
through Node's type stripping — which is exactly why it sat there for the whole
project. `tsconfig.build.json` and `scripts/copy-assets.ts` close it, and the
copy step is the part the known issue had already predicted: `tsc` does not emit
the prompt document, and `instructions.ts` resolves it relative to itself.

**Still not a deployment.** `npm run build && npm start` produces a runnable
server, which is not the same as a server you would put in front of people: the
two blockers above are unchanged, there is no CI to run the build, and Docker is
not written. The build removed one excuse, not the reasons.

## Deliberately not doing

| Not doing | Why |
|---|---|
| Multi-agent, event bus, workflow engine | §28. One agent with tools covers the product. |
| A second database, a real vector store | ADR 004: retrieval is lexical until an embedding provider exists. The similarity function is injected so the swap is one function. |
| Storing relationship state in a table | Derivable in one query; a migration for a cache. |
| A relationship stage taxonomy | Nobody has calibrated the bands. Facts now, labels when there is evidence for them. |
| An always-on block for anything else | The two that exist are unconditional because a relationship and a running theme are not things that *become* relevant. The gate is right for everything else, and widening the unconditional part is how a prompt becomes a status report. |
| A runtime detector for rumination | `RUMINATION_SIGNALS` existed for this and was deleted. `question-01` scores 1.00 on the behaviour with `toolsCalled: []`, so the prompt's Te lens already does it; a keyword list cannot tell a loop from a settled decision; and safety is enforced mechanically only because a miss there is unrecoverable, which rumination is not. The full argument is in `CHANGELOG.md` → Changed. |
| Rewriting the memory layers | §32 (no unrelated cleanup), §34 (no destructive refactoring without a plan). |
