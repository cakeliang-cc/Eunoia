/**
 * Egress policy: the SSRF and DNS-rebinding cases the ADR names explicitly.
 *
 * Pure and deterministic: the resolver is injected, so "the name resolved to a
 * private address the second time" is a value in a test, not a network race.
 */

import { describe, expect, it } from 'vitest';
import { EgressPolicy, blockedAddress } from '../../src/sandbox/network/egress-policy.ts';
import type { Resolver } from '../../src/sandbox/network/egress-policy.ts';

const policy = new EgressPolicy({
  allowedDomains: ['example.com', '*.npmjs.org'],
  allowedPorts: [443],
});

const resolverOf = (addresses: Record<string, string[]>): Resolver => async (host) => addresses[host] ?? [];

describe('blocked addresses', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'loopback'],
    ['10.0.0.1', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['169.254.1.1', 'link-local / metadata'],
    ['169.254.169.254', 'cloud metadata'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['100.100.100.200', 'cloud metadata'],
    ['0.0.0.0', 'unspecified'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'reserved'],
    ['::1', 'loopback / unspecified'],
    ['::', 'loopback / unspecified'],
    ['fd00::1', 'unique local'],
    ['fe80::1', 'link-local'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'documentation'],
    ['64:ff9b::808:808', 'NAT64'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:10.0.0.1', 'private'],
    ['::ffff:169.254.169.254', 'cloud metadata'],
  ])('blocks %s (%s)', (address, label) => {
    expect(blockedAddress(address)).toBe(label);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'])(
    'allows public %s',
    (address) => {
      expect(blockedAddress(address)).toBeNull();
    },
  );
});

describe('policy decisions', () => {
  it('allows an allowlisted domain that resolves to a public address', async () => {
    const decision = await policy.evaluate(
      'api.example.com',
      443,
      resolverOf({ 'api.example.com': ['93.184.216.34'] }),
    );
    expect(decision.allowed).toBe(true);
    expect(decision.address).toBe('93.184.216.34');
  });

  it('refuses an IP literal before DNS', async () => {
    for (const host of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1']) {
      const decision = await policy.evaluate(host, 443, resolverOf({}));
      expect(decision.allowed, host).toBe(false);
      expect(decision.reason).toMatch(/IP literal|blocked|allowlist/);
    }
  });

  it('refuses cloud metadata hostnames', async () => {
    const metadata = new EgressPolicy({
      allowedDomains: ['metadata.google.internal', 'metadata.azure.com'],
      allowedPorts: [80],
    });
    for (const host of ['metadata.google.internal', 'metadata.azure.com', 'instance-data']) {
      const decision = await metadata.evaluate(host, 80, resolverOf({ [host]: ['93.184.216.34'] }));
      expect(decision.allowed, host).toBe(false);
    }
  });

  it('refuses a domain outside the allowlist', async () => {
    const decision = await policy.evaluate('evil.test', 443, resolverOf({ 'evil.test': ['93.184.216.34'] }));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/allowlist/);
  });

  it('refuses a port outside the allowlist', async () => {
    const decision = await policy.evaluate('example.com', 8443, resolverOf({ 'example.com': ['93.184.216.34'] }));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/port/);
  });

  it('refuses a name that resolves to a private address', async () => {
    const decision = await policy.evaluate('example.com', 443, resolverOf({ 'example.com': ['10.0.0.5'] }));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/private/);
  });

  it('refuses a DNS-rebinding answer that mixes public and private addresses', async () => {
    // The first answer is public; accepting it and connecting would let the
    // second answer reach the private network. Every answer must be public.
    const decision = await policy.evaluate(
      'example.com',
      443,
      resolverOf({ 'example.com': ['93.184.216.34', '127.0.0.1'] }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/loopback/);
  });

  it('refuses an IPv6-mapped loopback answer', async () => {
    const decision = await policy.evaluate('example.com', 443, resolverOf({ 'example.com': ['::ffff:127.0.0.1'] }));
    expect(decision.allowed).toBe(false);
  });

  it('denies everything when no domains are configured', async () => {
    const empty = new EgressPolicy({ allowedDomains: [], allowedPorts: [] });
    const decision = await empty.evaluate('example.com', 443, resolverOf({ 'example.com': ['93.184.216.34'] }));
    expect(decision.allowed).toBe(false);
  });

  it('fails closed when resolution fails', async () => {
    const failing: Resolver = async () => {
      throw new Error('dns down');
    };
    const decision = await policy.evaluate('example.com', 443, failing);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/resolve/);
  });
});
