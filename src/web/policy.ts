/**
 * URL and address policy for outbound HTTP.
 *
 * The check is deliberately at two levels: the hostname before connecting, and
 * every resolved address at connect time. Checking only the string would let a
 * public name resolve to 127.0.0.1 (DNS rebinding), and checking only the final
 * URL would miss an intermediate redirect.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { WebError } from './types.ts';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) return true;
  const [a, b] = octets as [number, number, number, number];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    return true;
  }
  if (lower.startsWith('::ffff:')) return isPrivateIpv4(lower.slice('::ffff:'.length));
  return false;
}

export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version === 6) return isPrivateIpv6(address);
  return true;
}

export interface UrlPolicyOptions {
  readonly allowPrivateNetwork?: boolean;
}

export function assertPublicUrl(raw: string, options: UrlPolicyOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebError('WEB_INVALID_URL', `不是合法的 URL：${raw}`, 400);
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new WebError('WEB_INVALID_URL', '只支持 http/https。', 400);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new WebError('WEB_INVALID_URL', 'URL 不能包含用户名或密码。', 400);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    if (options.allowPrivateNetwork !== true) {
      throw new WebError('WEB_BLOCKED_HOST', `拒绝访问本机/内部主机：${host}`, 403);
    }
  }
  if (isIP(host) && isPrivateAddress(host) && options.allowPrivateNetwork !== true) {
    throw new WebError('WEB_BLOCKED_HOST', `拒绝访问私有地址：${host}`, 403);
  }
  return url;
}

export async function resolvePublicHost(
  hostname: string,
  options: UrlPolicyOptions = {},
): Promise<{ address: string; family: number }> {
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (isIP(bare)) {
    if (isPrivateAddress(bare) && options.allowPrivateNetwork !== true) {
      throw new WebError('WEB_BLOCKED_HOST', `拒绝访问私有地址：${bare}`, 403);
    }
    return { address: bare, family: isIP(bare) };
  }
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(bare, { all: true, verbatim: true });
  } catch (error) {
    throw new WebError('WEB_NETWORK', `无法解析 ${bare}：${error instanceof Error ? error.message : String(error)}`, 502, {
      retryable: true,
    });
  }
  if (addresses.length === 0) {
    throw new WebError('WEB_NETWORK', `无法解析 ${bare}`, 502, { retryable: true });
  }
  for (const entry of addresses) {
    if (isPrivateAddress(entry.address) && options.allowPrivateNetwork !== true) {
      throw new WebError(
        'WEB_BLOCKED_HOST',
        `${bare} 解析到私有地址 ${entry.address}，已拒绝。`,
        403,
        { detail: { address: entry.address } },
      );
    }
  }
  return addresses[0] as { address: string; family: number };
}
