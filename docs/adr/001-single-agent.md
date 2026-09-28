# ADR 001 — Single agent, not multi-agent

## Context

The product models its interaction policy on Fi / Ne / Si / Te heuristics
(spec §2). The obvious-looking implementation is four collaborating agents, one
per function. The spec explicitly forbids this for the MVP (anti-pattern 4).

## Decision

Ship exactly one agent: `INFPCompanionAgent`. Fi / Ne / Si / Te are implemented
as **behavioral heuristics inside that agent's instructions and decision policy**,
not as separate agents, and not as separate LLM calls.

## Alternatives

1. **Four agents with a handoff/orchestration layer.** Rejected. Handoffs
   multiply latency and cost per turn, make behavior non-deterministic in ways
   that are hard to evaluate, and give no capability the single agent lacks.
   The four functions are not independent task domains — they are lenses on one
   conversation.
2. **One agent, four sequential LLM calls (one per function).** Rejected. Same
   cost/latency problem, and it fragments a single conversational turn into four
   incoherent pieces.
3. **One agent, functions as prompt sections.** Chosen.

## Why

The four functions describe *how to attend to a message* (what it means to the
user, what else could be true, what happened before, what small action is
available) — they are not separable jobs with separable inputs and outputs. A
single agent holding all four as heuristics can weigh them against each other in
one pass, which is precisely the behavior the eval cases in §12 test.

## Consequences

- One `instructions.ts` with clearly separated heuristic sections (§11), not one
  prompt per function.
- Evaluation measures *behavioral* outcomes (does it avoid unsolicited advice?),
  not routing accuracy between agents.
- If a future phase needs genuine specialization, the `ModelClient` and agent
  boundary are already abstracted, so a handoff can be added without rewriting
  memory or tools.
- Trade-off accepted: a single agent must fit all heuristics in one context. This
  is a real constraint and is the reason §6's retrieval budget matters.
