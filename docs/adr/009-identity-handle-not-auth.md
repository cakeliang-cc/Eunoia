# ADR 009 — Identity is an unguessable handle, not authentication

## Context

The product needs to know who is talking: memories, conversations, preferences
and feedback are all per-person, and a companion that mixes two people's
histories is not a companion. Phase 5 needed something now, with no auth
provider, no login screen, and no real users.

There are two ways to get a per-person identifier before real auth exists, and
they fail differently.

## Decision

**The server mints a random UUID, sets it as a cookie, and treats every request
carrying it as that person.** A client-supplied identifier is accepted only via
an explicit `X-User-Id` header, and only if it is already a well-formed UUID;
anything else — `X-User-Id: 1`, a stray string, a malformed cookie — is
**replaced with a fresh identity** rather than trusted.

**This is stated plainly in the code as not being authentication.** No password,
no expiry, no signature: anyone holding the cookie is that user, and cookies can
be copied. It is acceptable only because this runs on a developer's machine with
no real users and no real data. The module's own header names the minimum before
any deployment: real authentication, and `HttpOnly; Secure; SameSite=Lax` at
minimum.

## Alternatives

1. **Let the client choose its identifier.** Rejected — this is the failure mode
   worth naming. If the client picks, `X-User-Id: 1` reads someone else's
   memories, and that bug survives into production far more often than a missing
   login does, because it looks like it works. A server-minted UUID is at least
   not enumerable.
2. **Auth now (a provider, sessions, password reset).** Rejected as premature by
   spec §0: no users exist yet, and the mini-program migration will bring its own
   flow (`wx.login` → code → server session). Building a login screen for nobody
   is the unnecessary framework the spec warns against.
3. **Cookie-only, no header.** Rejected: the mini-program has no browser cookie
   jar, so the header is the seam the migration needs. It exists before it is
   needed, which is why ADR 006's boundary was drawn where it was.
4. **Trust any `X-User-Id` string.** Rejected: it removes the only property the
   handle has (unguessability) while looking like a feature.

## Consequences

- The mini-program's auth layer produces the UUID and passes it in the header;
  no server-side change is needed when it arrives. This is the seam ADR 006
  promised.
- Deleting the cookie loses the identity and with it every memory. That is a real
  consequence of having no login, and it is why the memory panel exists: what
  the system believes is visible and deletable by the person it is about.
- **Before any deployment**: replace with real authentication, set
  `HttpOnly; Secure; SameSite=Lax`, and expire sessions. Until then this must not
  hold anyone's real data — a constraint, not a preference.
- Two identities are isolated by test, and an unrecognised id is proven to be
  replaced rather than honoured (`tests/api/server.test.ts`).
