# ADR 003 — Four-layer memory model

## Context

Spec §4 defines four layers: working, episodic, semantic-personal, narrative.
They differ in lifetime, mutability, and how much a wrong value costs.

The naive implementation — one `memories` table holding everything — loses the
distinctions that matter. A durable value ("authenticity matters to me") and a
dated event ("interviewed at a design company on 2026-09-20") have different
update semantics, different retrieval triggers, and different failure modes.

## Decision

Four layers, each with an explicit lifetime and write rule:

| Layer | Scope | Storage | Lifetime |
|---|---|---|---|
| Working | one session | in-process session state | discarded at session end |
| Episodic | user | `memories` rows, `type='episodic'` | long, dated, immutable-ish |
| Semantic-personal | user | `memories` rows, `type IN ('value','preference','pattern')` | long, updatable, confidence-tracked |
| Narrative | user | `memories` rows, `type='narrative'` | long, **updatable and correctable** |

Episodic, semantic, and narrative share one table with a `type` discriminator and
a common set of governance columns, because they share retrieval mechanics and
all need `confidence` / `source` / timestamps. Working memory is *not* persisted
to that table — it is session state.

Every persisted memory row carries: `confidence`, `source`, `created_at`,
`updated_at`, `last_accessed_at`, `expires_at`, `importance`.

## Alternatives

1. **One undifferentiated `memories` table.** Rejected — no place to express the
   different write and correction rules, and it makes §13's memory-accuracy
   scoring meaningless (there is no "correct" without a type-specific rule).
2. **Separate table per layer.** Rejected for the MVP — three tables with
   identical governance columns multiplies migration and query cost for no
   benefit; retrieval wants to rank across layers together. A `type`
   discriminator plus a partial index per type covers it.
3. **Store narrative memory as a free-text profile blob.** Rejected. Spec §4.4
   requires narrative memory to be updatable, correctable, and confidence-bearing
   — a blob cannot be partially revised or scored, and it silently becomes the
   "permanent personality label" the spec warns against.

## Why

`confidence` and `source` on every row are what make spec §7 enforceable: the
system can refuse to persist low-confidence inferences, and later distinguish
what the user actually said (`source='user_explicit'`) from what the model
inferred (`source='agent_inference'`). This distinction is required by eval case
07 and by the §7 rule against storing speculation as fact.

## Consequences

- `memory_types.ts` owns the type union and the per-type validity rules; nothing
  else hardcodes type strings.
- Narrative memory updates must be **revisable**: a correction supersedes rather
  than overwrites where history matters, so `memory_events` records the change.
- Working memory lives in session state and must never be written to the
  `memories` table.
- Eval can assert per-layer: explicit preference stored (case 07), speculation
  *not* stored (§7), narrative corrected rather than duplicated.
- Trade-off accepted: a discriminated single table means type-specific columns are
  nullable for rows that don't use them. This is cheaper than three tables at
  MVP scale and can be split later behind the `MemoryStore` interface.
