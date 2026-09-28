/**
 * Who is talking.
 *
 * ## This is not authentication
 *
 * It is an unguessable handle, and the difference matters enough to state
 * plainly. The server mints a random UUID, hands it back as a cookie, and treats
 * every request carrying it as that person. There is no password, no session
 * expiry, no signature — anyone who obtains the cookie is that user, and a
 * cookie can be copied.
 *
 * That is acceptable *only* because this runs on a developer's machine with no
 * real users and no real data. Before this is deployed anywhere, it must be
 * replaced with real authentication, and the cookie should become
 * `HttpOnly; Secure; SameSite=Lax` at minimum.
 *
 * `HttpOnly` and `SameSite=Lax` are now set; `Secure` is not, because it makes
 * the browser drop the cookie over plain `http://` and this is served over plain
 * HTTP in development. It is the one attribute that has to wait for TLS, and it
 * is called out in `CHANGELOG.md` rather than left to whoever writes the deploy
 * config. `HttpOnly` was free to add because no client code reads the cookie —
 * checked, not assumed: nothing in `web/` or `src/` mentions `df_uid`, and every
 * call the client makes is a same-origin `fetch` under the default credentials
 * mode, so the browser attaches the cookie on its own. The point of the flag is
 * that an XSS can no longer read the handle out of `document.cookie`, which is
 * the one thing standing between this design and a trivially stolen identity.
 *
 * It is done this way rather than with a client-supplied id because a
 * client-supplied id is worse in a specific way: if the client picks the
 * identifier, `X-User-Id: 1` reads someone else's memories, and that class of
 * bug survives into production far more often than a missing login does. A
 * server-minted UUID is at least not enumerable.
 *
 * The `X-User-Id` header is accepted so the mini-program client can supply the
 * identity its own auth layer produces; that is the intended direction and the
 * reason the header exists before it is needed.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const IDENTITY_COOKIE = 'df_uid';
export const IDENTITY_HEADER = 'x-user-id';

/**
 * The attributes every identity cookie carries, set or cleared.
 *
 * One constant, because a browser only replaces a cookie whose name, domain and
 * path all match: a clearing header that spelled the path differently would
 * leave the old cookie in place and read as "delete did nothing".
 */
const PATH_AND_FLAGS = 'Path=/; HttpOnly; SameSite=Lax';

/** A year, which is indefinitely for a handle with no expiry semantics. */
const ONE_YEAR_SECONDS = 31536000;

/** A UUID, which is also what `users.id` is. */
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export interface Identity {
  readonly userId: string;
  /** True when this request minted a new identity and a cookie was set. */
  readonly created: boolean;
}

/**
 * Resolve the caller's identity, minting one if needed.
 *
 * An unrecognised identifier is replaced rather than trusted: accepting any
 * string would let a caller choose an id, which is the enumeration problem
 * described above.
 */
export function resolveIdentity(req: IncomingMessage, res: ServerResponse): Identity {
  const existing = readIdentity(req);
  if (existing) return { userId: existing, created: false };

  const userId = randomUUID();
  res.setHeader(
    'Set-Cookie',
    `${IDENTITY_COOKIE}=${userId}; ${PATH_AND_FLAGS}; Max-Age=${ONE_YEAR_SECONDS}`,
  );
  return { userId, created: true };
}

/**
 * Who this is, or nobody — without minting anyone.
 *
 * `resolveIdentity` creates an identity when it does not find one, which is what
 * every ordinary route wants and the one thing a route that *deletes* the caller
 * must not do: minting first would create a person in order to remove them, and
 * answer with a cookie for a row that no longer exists.
 */
export function readIdentity(req: IncomingMessage): string | null {
  const fromHeader = firstHeader(req.headers[IDENTITY_HEADER]);
  if (fromHeader && ID_PATTERN.test(fromHeader)) return fromHeader;

  const fromCookie = parseCookies(firstHeader(req.headers.cookie) ?? undefined)[IDENTITY_COOKIE];
  if (fromCookie && ID_PATTERN.test(fromCookie)) return fromCookie;

  return null;
}

/**
 * Forget the caller's handle.
 *
 * A deleted person's cookie is a pointer to nothing, and leaving it in the
 * browser would mean the next request carried an id the server would *accept* —
 * `resolveIdentity` checks the shape, not the row — and then write new memories
 * under a user that no longer exists. Clearing it makes the next request a new
 * person, which is what "I want everything gone" should mean.
 */
export function clearIdentity(res: ServerResponse): void {
  res.setHeader('Set-Cookie', `${IDENTITY_COOKIE}=; ${PATH_AND_FLAGS}; Max-Age=0`);
}
