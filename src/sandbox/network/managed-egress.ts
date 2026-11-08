import type { Socket } from 'node:net';
import type { ContainerCli } from '../runtime/container-cli.ts';
import { EgressPolicy, type EgressPolicyOptions } from './egress-policy.ts';
import { createEgressProxy, type EgressProxyOptions } from './egress-proxy.ts';
import { attachPipeProxy } from './pipe-proxy.ts';

export interface ManagedEgress {
  readonly closed: boolean;
  close(): Promise<void>;
}

/** Each container gets its own policy server and control pipe. */
export async function startManagedEgress(input: {
  readonly cli: ContainerCli;
  readonly container: string;
  readonly policy: EgressPolicyOptions;
  readonly previewRoute?: EgressProxyOptions['previewRoute'];
  readonly audit?: EgressProxyOptions['audit'];
}): Promise<ManagedEgress> {
  const sockets = new Set<Socket>();
  const server = createEgressProxy({ policy: new EgressPolicy(input.policy), ...(input.previewRoute ? { previewRoute: input.previewRoute } : {}), ...(input.audit ? { audit: input.audit } : {}) });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('proxy did not bind');
  let closed = false;
  const stop = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  try {
    const pipe = await attachPipeProxy(input.cli, input.container, address.port);
    return { get closed() { return closed || pipe.closed; }, async close() { pipe.close(); await stop(); } };
  } catch (error) { await stop(); throw error; }
}
