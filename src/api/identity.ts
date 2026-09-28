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
  const fromHeader = firstHeader(req.headers[IDENTITY_HEADER]);
  if (fromHeader && ID_PATTERN.test(fromHeader)) {
    return { userId: fromHeader, created: false };
  }

  const fromCookie = parseCookies(firstHeader(req.headers.cookie) ?? undefined)[IDENTITY_COOKIE];
  if (fromCookie && ID_PATTERN.test(fromCookie)) {
    return { userId: fromCookie, created: false };
  }

  const userId = randomUUID();
  res.setHeader(
    'Set-Cookie',
    `${IDENTITY_COOKIE}=${userId}; Path=/; Max-Age=31536000; SameSite=Lax`,
  );
  return { userId, created: true };
}
