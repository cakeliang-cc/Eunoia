import type { LookupAddress, LookupAllOptions } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertPublicUrl, resolvePublicHost } from '../../src/web/policy.ts';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));

const lookupAll = vi.mocked<(hostname: string, options: LookupAllOptions) => Promise<LookupAddress[]>>(lookup);
const fake = { address: '198.18.0.64', family: 4 };
const local = { address: '127.0.0.1', family: 4 };
const publicAddress = { address: '151.101.3.42', family: 4 };

describe('web_fetch fake-IP resolution', () => {
  beforeEach(() => vi.resetAllMocks());

  it('falls back to a public address only when enabled and all answers are fake', async () => {
    lookupAll.mockResolvedValue([fake, { address: '198.19.0.1', family: 4 }]);
    const resolveFakeIp = vi.fn().mockResolvedValue([publicAddress]);
    const signal = new AbortController().signal;
    await expect(resolvePublicHost('arxiv.org', {}, signal)).rejects.toMatchObject({ code: 'WEB_BLOCKED_HOST' });
    await expect(resolvePublicHost('arxiv.org', { resolveFakeIp }, signal)).resolves.toEqual(publicAddress);
    expect(resolveFakeIp).toHaveBeenCalledExactlyOnceWith('arxiv.org', signal);
  });

  it('keeps system DNS for public hosts and rejects mixed or private answers', async () => {
    const resolveFakeIp = vi.fn();
    lookupAll.mockResolvedValue([publicAddress]);
    await expect(resolvePublicHost('example.com', { resolveFakeIp })).resolves.toEqual(publicAddress);
    for (const addresses of [[fake, local], [fake, publicAddress], [local]]) {
      lookupAll.mockResolvedValue(addresses);
      await expect(resolvePublicHost('example.com', { resolveFakeIp })).rejects.toMatchObject({ code: 'WEB_BLOCKED_HOST' });
    }
    expect(resolveFakeIp).not.toHaveBeenCalled();
  });

  it('blocks private fallback answers and refuses private literals and local names', async () => {
    lookupAll.mockResolvedValue([fake]);
    const resolveFakeIp = vi.fn().mockResolvedValue([publicAddress, { address: 'fd00::42', family: 6 }]);
    await expect(resolvePublicHost('example.com', { resolveFakeIp })).rejects.toMatchObject({ code: 'WEB_BLOCKED_HOST' });
    await expect(resolvePublicHost(fake.address, { resolveFakeIp })).rejects.toMatchObject({ code: 'WEB_BLOCKED_HOST' });
    await expect(resolvePublicHost('intranet', { resolveFakeIp })).rejects.toMatchObject({ code: 'WEB_BLOCKED_HOST' });
    expect(() => assertPublicUrl('https://intranet.local.')).toThrow('拒绝访问本机/内部主机');
    expect(resolveFakeIp).toHaveBeenCalledTimes(1);
  });

  it('reports encrypted DNS failures without using the fake address', async () => {
    lookupAll.mockResolvedValue([fake]);
    const resolveFakeIp = vi.fn().mockRejectedValue(new Error('resolver unavailable'));
    await expect(resolvePublicHost('example.com', { resolveFakeIp })).rejects.toMatchObject({
      code: 'WEB_NETWORK',
      retryable: true,
    });
  });
});
