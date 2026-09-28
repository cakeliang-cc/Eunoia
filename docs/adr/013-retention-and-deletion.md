# ADR 013 — What is kept, for how long, and what is never stored

## Context

Spec §44 is a list of seven words a long-lived companion's memory design has to
answer for:

```text
purpose    scope    retention    deletion    privacy    sensitivity
```

and two prohibitions — no unconditionally storing everything about a person, and
no sending their private data to an external tool without a reason.

Six of the seven had an answer somewhere. `purpose` and `scope` are ADR 003 and
the schema comments (episodic / semantic / narrative, and why each exists).
`privacy` is ADR 009 plus the standing rule that logs carry category labels and
fingerprints rather than content — `len=42`, never the forty-two characters.
`sensitivity` is ADR 008: risk is detected before anything renders, and a crisis
turn is checked mechanically rather than trusted to the model.

**`retention` and `deletion` had nothing.** The concrete form of that gap was
already written down in `CHANGELOG.md` as a known issue:

> Evaluation runs accumulate throwaway users in a shared database. Each of the 24
> cases gets its own user, conversation, messages and run rows, and nothing
> deletes them.

That was not a hypothetical. When this ADR was written the development database
held **589 users, 355 conversations and 512 messages**, essentially all of it
left by evaluation runs, and the sweep found nothing to remove because nothing
had ever marked which users were the throwaway ones. A person could delete one
memory at a time from the panel and had no way at all to remove themselves.

## Decision

**Four things, and the boundaries between them are the decision.**

### 1. `external_id` is the mark, and it is the only thing a sweep trusts

An evaluation run writes `eval:<runId>:<caseId>` into `users.external_id`. That
column has been in the schema since the first migration, declared for exactly
this — "stable identity from an external system" — and had never been written by
any code.

An earlier attempt had made evaluation users greppable by putting the case id
inside `users.id`, which failed against Postgres on the very first insert because
that column is a `uuid`. The intent was right and it was aimed at the wrong
column; `external_id` is `text`, and it was already there.

**A real person has no `external_id` at all.** That is what makes the sweep safe
to run without a confirmation prompt: the set it can reach is exactly the set
that was never a person. It is also the property that makes the 587 unmarked
rows unreachable — see Consequences.

### 2. A run cleans up after itself; a sweep is the backstop

Two mechanisms, deliberately different:

- **The evaluation run deletes the users it created**, by id, the moment it has
  saved its results. It holds the exact ids, so it needs no prefix, no window and
  nothing it has to believe about the rest of the table.
- **`npm run cleanup` sweeps by prefix**, for the runs that crashed before they
  got there. It leaves users younger than `RETENTION_WINDOW_HOURS` (24) alone.

The window is a **race guard, not a data policy**. Evaluation data has no reason
to outlive the run that made it; the margin exists only so a sweep cannot pull
users out from under a run that is still using them. It is not hypothetical —
two evaluations were in flight simultaneously while this was being written.

Deleting by id rather than by prefix in the run is the same reasoning in the
other direction: the run knows exactly what it made, so matching loosely would
buy nothing and risk a concurrent run's users.

### 3. Deleting a person deletes the person, not the measurement

`DELETE /api/me` removes the caller outright. Every table holding their content
references `users(id) ON DELETE CASCADE`, so it is one statement and the database
does the work.

**`agent_runs` is the deliberate exception: `ON DELETE SET NULL`.** A run is
observability — `len=N sha256=…`, never content (spec §14) — and it is the only
record of what a prompt version did. Erasing a person should not erase the
evidence about the prompt. `evaluation_results` never referenced a user at all.

This is the opposite choice from `deleteMemory`, which is soft on purpose: a
deleted memory keeps a `memory_events` trail pointing at it, because "why did it
think it knew that?" is a question worth answering about a *belief*. There is no
equivalent question about a person who has asked to be left alone.

### 4. The cookie is cleared, not just the row

`DELETE /api/me` answers with `Max-Age=0` on the same attributes. The route also
deliberately does **not** call `identify()`, which mints an identity on first
contact: minting here would create a person in order to delete them, and hand
back a cookie for a row that no longer exists.

This matters because `resolveIdentity` checks the *shape* of a handle, not that
the row exists. A live cookie pointing at a deleted user would be accepted, and
the next message would be written under an id nothing owns.

## Alternatives

1. **A periodic scheduler** (cron, a background timer). Rejected: there is no
   scheduler in this project, and adding one for a development database is the
   unnecessary framework spec §0 warns against. The reference implementation
   (`reference/hello-agents`, ch8) has the same shape — a manual `forget()` with
   importance / time / capacity strategies and **no automatic trigger anywhere**,
   which is worth knowing: the practice is to expose the operation, not to run
   it on a timer nobody watches.
2. **A `deleted_at` column and soft deletes.** Rejected for people, and it is
   what §34 makes expensive — it is a schema change, and it would mean the row
   and everything derived from it stays in the database, which is the opposite of
   what was asked for. Soft delete is right for memories (§3 above) and wrong
   for this.
3. **Marking evaluation users by inserting the case id into `users.id`.** Tried,
   failed, and the failure is instructive: `users.id` is `uuid` in Postgres and
   the in-memory store accepts any string, so no offline test could have caught
   it. The same blind spot as the missing `installProvider()` call.
4. **A sweep with no age window.** Rejected — it would race a concurrent run.
   The window is the minimum that makes the operation safe to run at any moment.
5. **Deleting `agent_runs` with the person.** Rejected. It would make the
   project's own history of prompt versions unreadable, and a fingerprint is not
   the person.
6. **Erasure by policy (a TTL on all data).** Rejected. A companion that forgets
   a person because a timer expired is not a companion; §44 asks what is kept and
   why, and the answer for a real user's memories is "until they say otherwise",
   not "thirty days".

## Consequences

- **The backlog is not reachable, and was left alone.** 587 users predate the
  marking and are now indistinguishable from real accounts — a user with no
  preferences and one conversation is exactly what an evaluation user looks like,
  and also exactly what a person who never opened the panel looks like. An
  unmarked user is not swept **by design**, so the sweep cannot help. The honest
  options for a development database in that state are to drop it or to write SQL
  by hand, and both are the right amount of friction for deleting hundreds of
  rows at once.
- **`external_id` now has two planned occupants**, `eval:` and the mini-program
  openid. The namespace is by convention rather than by a constraint. An openid
  will not begin with `eval:`, and the prefix match is literal (`starts_with`,
  not `LIKE`) so a stray `%` cannot widen a delete.
- **Retention covers evaluation data only.** A real user's memories are kept
  until they delete them, one at a time or all at once. If the product ever needs
  an inactivity policy, that is a new decision with a real cost, not an extension
  of this one.
- **Still not authentication** (ADR 009, unchanged). Anyone with the cookie is
  the user, which now also means anyone with the cookie can delete the account.
  `HttpOnly` and `SameSite=Lax` are set; `Secure` still waits for TLS. This ADR
  makes the *data* deletable, not the *identity* trustworthy.
- **The Postgres suite cleans up after itself now.** Its `beforeEach` used to
  clear the shared `createdUsers` list, so only the last test's users were ever
  removed and every earlier test leaked a user, a conversation and a memory —
  the same accumulation this ADR exists to stop, in the file next door.
