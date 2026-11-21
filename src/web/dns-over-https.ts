import { get } from 'node:https';
import { isIP } from 'node:net';

async function queryCloudflare(hostname: string, type: 1 | 28, signal: AbortSignal): Promise<string[]> {
  const query = new URLSearchParams({ name: hostname, type: String(type) });
  const body = await new Promise<string>((resolve, reject) => {
    // Bootstrap via Cloudflare's fixed resolver address. TLS still verifies its
    // hostname, including when the system DNS is returning synthetic addresses.
    const request = get({
      hostname: '1.1.1.1',
      servername: 'cloudflare-dns.com',
      path: `/dns-query?${query}`,
      headers: { host: 'cloudflare-dns.com', accept: 'application/dns-json' },
      signal,
    }, async (response) => {
      if (response.statusCode !== 200) {
        response.destroy();
        reject(new Error(`加密 DNS 返回 HTTP ${response.statusCode}`));
        return;
      }
      try {
        let bytes = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of response) {
          bytes += chunk.length;
          if (bytes > 16_384) throw new Error('加密 DNS 响应超出大小限制');
          chunks.push(chunk);
        }
        resolve(Buffer.concat(chunks).toString('utf8'));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
  const answer = JSON.parse(body) as {
    Status: number;
    TC?: boolean;
    Answer?: Array<{ type: number; data: string }>;
  };
  if (answer.Status !== 0 || answer.TC) {
    throw new Error(`加密 DNS 未返回完整结果（状态 ${answer.Status}）`);
  }
  const addresses = (answer.Answer ?? []).filter((record) => record.type === type).map((record) => record.data);
  if (addresses.some((address) => typeof address !== 'string' || isIP(address) !== (type === 1 ? 4 : 6))) {
    throw new Error('加密 DNS 返回了无效地址');
  }
  return addresses;
}

export async function resolveFakeIpWithCloudflare(hostname: string, signal?: AbortSignal) {
  const deadline = AbortSignal.timeout(4_000);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const [ipv4, ipv6] = await Promise.all([
    queryCloudflare(hostname, 1, requestSignal),
    queryCloudflare(hostname, 28, requestSignal),
  ]);
  return [...ipv4.map((address) => ({ address, family: 4 })), ...ipv6.map((address) => ({ address, family: 6 }))];
}
