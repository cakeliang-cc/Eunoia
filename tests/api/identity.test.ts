/**
 * Single-user identity.
 *
 * The app has no login yet, so the default for a local companion is one person:
 * every browser, cookie jar and private window must read and write the same
 * history. These tests pin that switch, and the fallback to cookie identities
 * when it is off.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  IDENTITY_COOKIE,
  SINGLE_USER_ENV,
  readIdentity,
  resolveIdentity,
  singleUserId,
} from '../../src/api/identity.ts';

const USER = '00000000-0000-4000-8000-000000000001';
const OTHER = '0192f0aa-0000-7000-8000-0000000000ff';

const previous = process.env[SINGLE_USER_ENV];

afterEach(() => {
  if (previous === undefined) delete process.env[SINGLE_USER_ENV];
  else process.env[SINGLE_USER_ENV] = previous;
});

function request(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

/** A response that fails the test if anything tries to set a cookie. */
function response(): ServerResponse {
  return {
    setHeader: () => {
      throw new Error('single-user mode must not mint a cookie');
    },
  } as unknown as ServerResponse;
}

describe('singleUserId', () => {
  it('is off when unset, so cookie identities still work in tests', () => {
    expect(singleUserId({})).toBeNull();
  });

  it('accepts a UUID', () => {
    expect(singleUserId({ [SINGLE_USER_ENV]: USER })).toBe(USER);
  });

  it('rejects a malformed value instead of falling back to cookies', () => {
    // A silent fallback would write as a different person than the page shows.
    expect(() => singleUserId({ [SINGLE_USER_ENV]: 'me' })).toThrow(/must be a UUID/);
  });
});

describe('resolveIdentity in single-user mode', () => {
  it('always returns the fixed user', () => {
    process.env[SINGLE_USER_ENV] = USER;
    expect(resolveIdentity(request(), response())).toEqual({ userId: USER, created: false });
    expect(readIdentity(request())).toBe(USER);
  });

  it('ignores a cookie for somebody else', () => {
    process.env[SINGLE_USER_ENV] = USER;
    const req = request({ cookie: `${IDENTITY_COOKIE}=${OTHER}` });
    expect(resolveIdentity(req, response()).userId).toBe(USER);
    expect(readIdentity(req)).toBe(USER);
  });

  it('does not need a request at all when the env is invalid, it fails first', () => {
    process.env[SINGLE_USER_ENV] = 'not-a-uuid';
    expect(() => resolveIdentity(request(), response())).toThrow(/must be a UUID/);
  });
});
