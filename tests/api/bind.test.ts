/**
 * Where the HTTP server listens.
 *
 * The default has to be loopback: with no authentication, binding every
 * interface makes the whole memory store reachable to anyone on the network.
 * Remote access is an explicit `HOST=...` decision, not the default.
 */

import { describe, expect, it } from 'vitest';
import { bindHost } from '../../src/api/server.ts';

describe('bindHost', () => {
  it('defaults to loopback', () => {
    expect(bindHost({})).toBe('127.0.0.1');
    expect(bindHost({ HOST: '   ' })).toBe('127.0.0.1');
  });

  it('allows an explicit override, including for deliberate remote access', () => {
    expect(bindHost({ HOST: '0.0.0.0' })).toBe('0.0.0.0');
    expect(bindHost({ HOST: 'localhost' })).toBe('localhost');
  });
});
