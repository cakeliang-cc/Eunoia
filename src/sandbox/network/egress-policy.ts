/**
 * Egress policy: what a sandbox is allowed to talk to, decided without trusting
 * a domain name.
 *
 * ADR §5.2 is emphatic that a domain allowlist is not enough. The checks here
 * therefore run after resolution, not before:
 *
 *   - the target may not be an IP literal at all;
 *   - every address a name resolves to must be public;
 *   - loopback, RFC1918, link-local, CGNAT, multicast, documentation ranges and
 *     the cloud metadata addresses are refused;
 *   - the proxy connects to the address it checked, so a second DNS answer
 *     cannot rebind the connection to something else;
 *   - IPv6 and IPv4-mapped IPv6 are checked, not only IPv4.
 *
 * The policy object is pure; the resolver is injected so the rebinding tests do
 * not need a network.
 */

import { isIP } from 'node:net';

export interface EgressDecision {
  readonly allowed: boolean;
  readonly reason: string;
  /** The address the proxy is allowed to connect to, after checks. */
  readonly address: string | null;
}

export interface EgressPolicyOptions {
  readonly allowedDomains: readonly string[];
  readonly allowedPorts: readonly number[];
  readonly maxBytesPerRequest?: number;
  readonly maxRequestsPerMinute?: number;
}

export type Resolver = (hostname: string) => Promise<readonly string[]>;

/** Cloud metadata addresses, by name and by address. */
const METADATA_HOSTNAMES = [
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'metadata.azure.com',
];

const BLOCKED_IPV4: readonly { readonly network: number; readonly prefix: number; readonly label: string }[] = [
  { network: ipv4('0.0.0.0')!, prefix: 8, label: 'unspecified' },
  { network: ipv4('10.0.0.0')!, prefix: 8, label: 'private' },
  { network: ipv4('100.64.0.0')!, prefix: 10, label: 'carrier-grade NAT' },
  { network: ipv4('127.0.0.0')!, prefix: 8, label: 'loopback' },
  { network: ipv4('169.254.0.0')!, prefix: 16, label: 'link-local / metadata' },
  { network: ipv4('172.16.0.0')!, prefix: 12, label: 'private' },
  { network: ipv4('192.0.0.0')!, prefix: 24, label: 'IETF protocol' },
  { network: ipv4('192.0.2.0')!, prefix: 24, label: 'documentation' },
  { network: ipv4('192.168.0.0')!, prefix: 16, label: 'private' },
  { network: ipv4('198.18.0.0')!, prefix: 15, label: 'benchmark' },
  { network: ipv4('198.51.100.0')!, prefix: 24, label: 'documentation' },
  { network: ipv4('203.0.113.0')!, prefix: 24, label: 'documentation' },
  { network: ipv4('224.0.0.0')!, prefix: 4, label: 'multicast' },
  { network: ipv4('240.0.0.0')!, prefix: 4, label: 'reserved' },
];

export class EgressPolicy {
  readonly allowedDomains: readonly string[];
  readonly allowedPorts: readonly number[];
  readonly maxBytesPerRequest: number;
  readonly maxRequestsPerMinute: number;

  constructor(options: EgressPolicyOptions) {
    this.allowedDomains = options.allowedDomains.map((entry) => entry.trim().toLowerCase()).filter(Boolean);
    this.allowedPorts = [...options.allowedPorts];
    this.maxBytesPerRequest = options.maxBytesPerRequest ?? 10 * 1024 * 1024;
    this.maxRequestsPerMinute = options.maxRequestsPerMinute ?? 120;
  }

  /** Resolve, check every address, and pin one for the connection. */
  async evaluate(hostname: string, port: number, resolver: Resolver): Promise<EgressDecision> {
    const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (host.length === 0) return deny('empty host');

    // IP literals are refused before DNS: `http://127.0.0.1` and
    // `http://[::ffff:7f00:1]` are the same SSRF with different spelling.
    if (isIP(host) !== 0) return deny(`IP literal ${host} is not allowed`);

    if (METADATA_HOSTNAMES.includes(host)) return deny(`metadata hostname ${host} is blocked`);
    if (!this.domainAllowed(host)) return deny(`${host} is not on the domain allowlist`);

    if (!Number.isInteger(port) || port < 1 || port > 65_535) return deny(`invalid port ${port}`);
    if (this.allowedPorts.length > 0 && !this.allowedPorts.includes(port)) {
      return deny(`port ${port} is not on the port allowlist`);
    }

    let addresses: readonly string[];
    try {
      addresses = await resolver(host);
    } catch (error) {
      return deny(`could not resolve ${host}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (addresses.length === 0) return deny(`${host} resolved to no addresses`);

    // Every answer must be public. Accepting "one public address" would let an
    // attacker return a public IP to the check and a private one to the connect.
    for (const address of addresses) {
      const blocked = blockedAddress(address);
      if (blocked !== null) return deny(`${host} resolves to ${address} (${blocked})`);
    }
    return { allowed: true, reason: `allowlisted ${host}:${port}`, address: addresses[0] ?? null };
  }

  domainAllowed(host: string): boolean {
    if (this.allowedDomains.length === 0) return false;
    return this.allowedDomains.some((entry) => {
      const domain = entry.replace(/^\*\./, '');
      if (domain.length === 0) return false;
      return host === domain || host.endsWith(`.${domain}`);
    });
  }
}

export function deny(reason: string): EgressDecision {
  return { allowed: false, reason, address: null };
}

/** The label of the range an address falls in, or null when it is public. */
export function blockedAddress(address: string): string | null {
  const family = isIP(address);
  if (family === 4) return blockedIpv4(address);
  if (family === 6) return blockedIpv6(address);
  return 'unparseable address';
}

function blockedIpv4(address: string): string | null {
  const value = ipv4(address);
  if (value === null) return 'unparseable address';
  // Metadata is a special case of link-local that deserves its own reason: it is
  // the one an operator will search for.
  if (address === '169.254.169.254' || address === '100.100.100.200') return 'cloud metadata';
  for (const range of BLOCKED_IPV4) {
    const mask = range.prefix === 0 ? 0 : (0xffffffff << (32 - range.prefix)) >>> 0;
    if ((value & mask) === (range.network & mask)) return range.label;
  }
  return null;
}

function blockedIpv6(address: string): string | null {
  const normalized = address.toLowerCase().split('%')[0] as string;
  if (normalized === '::' || normalized === '::1') return 'loopback / unspecified';

  // IPv4-mapped (`::ffff:127.0.0.1`) must be checked as IPv4, or every IPv4
  // range above can be bypassed with a colon.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped) return blockedIpv4(mapped[1] as string);

  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return 'unique local';
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return 'link-local';
  if (/^ff[0-9a-f]{2}:/.test(normalized)) return 'multicast';
  if (/^2001:db8:/.test(normalized)) return 'documentation';
  if (/^64:ff9b:/.test(normalized)) return 'NAT64';
  if (/^2002:/.test(normalized)) return '6to4';
  return null;
}

function ipv4(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

/** Is a URL allowed? Convenience for policy tests and the tool layer. */
export function schemeAllowed(url: URL): boolean {
  return url.protocol === 'https:' || url.protocol === 'http:';
}
