/**
 * Reverse TCP over the container control pipe. The worker has network:none;
 * its loopback proxy can reach exactly one host-side policy proxy, never a
 * caller-selected address. No published port, bridge, Docker socket or secret
 * is mounted into the worker. Losing the pipe closes every connection.
 */
import { connect, type Socket } from 'node:net';
import type { ContainerCli } from '../runtime/container-cli.ts';

const MAX_FRAME = 96 * 1024;
const MAX_QUEUE = 2 * 1024 * 1024;
const MAX_CONNECTIONS = 64;

// Runs as the worker's unprivileged user. JSON lines are a bounded transport,
// not executable commands; the trusted side ignores any proposed destination.
export const PIPE_PROXY_WORKER = String.raw`
const net=require('node:net');
const sockets=new Map();let next=0,buffer='';
function send(m){if(process.stdout.writableLength>2097152)return process.exit(2);return process.stdout.write(JSON.stringify(m)+'\n');}
const server=net.createServer(s=>{
 if(sockets.size>=64){s.destroy();return;}
 const id=String(++next);sockets.set(id,s);send({op:'open',id});
 s.setTimeout(30000,()=>s.destroy());
 s.on('data',b=>{for(let i=0;i<b.length;i+=16384)if(!send({op:'data',id,data:b.subarray(i,i+16384).toString('base64')}))s.pause();});
 s.on('error',()=>{});s.on('close',()=>{sockets.delete(id);send({op:'close',id});});
});
process.stdout.on('drain',()=>{for(const s of sockets.values())s.resume();});
process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{
 buffer+=chunk;if(buffer.length>196608)process.exit(2);
 let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(line.length>98304)process.exit(2);
  try{const m=JSON.parse(line),s=sockets.get(m.id);if(m.op==='close')s?.destroy();else if(m.op==='data'&&s){const b=Buffer.from(m.data,'base64');if(s.writableLength+b.length>2097152)s.destroy();else s.write(b);}}catch{process.exit(2);}
 }
});
process.stdin.on('end',()=>process.exit(0));process.stdin.on('error',()=>process.exit(2));
server.on('error',()=>process.exit(2));server.listen(3128,'127.0.0.1',()=>send({op:'ready'}));
`;

export interface PipeProxy {
  readonly closed: boolean;
  close(): void;
}

export async function attachPipeProxy(cli: ContainerCli, container: string, proxyPort: number): Promise<PipeProxy> {
  const child = cli.spawnStream(['exec', '-i', container, 'node', '-e', PIPE_PROXY_WORKER]);
  return connectPipeProxy(child, proxyPort);
}

/** Exported to exercise malformed/untrusted worker frames without Docker. */
export async function connectPipeProxy(child: ReturnType<ContainerCli['spawnStream']>, proxyPort: number): Promise<PipeProxy> {
  const sockets = new Map<string, Socket>();
  let closed = false;
  let buffer = '';
  let ready = false;
  let resolveReady: () => void;
  let rejectReady: (error: Error) => void;
  const started = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const socket of sockets.values()) socket.destroy();
    sockets.clear();
    child.stdin.destroy();
    child.kill('SIGTERM');
    if (!ready) rejectReady(new Error('container proxy pipe closed before ready'));
  };
  const send = (message: unknown): void => {
    if (closed) return;
    if (child.stdin.writableLength > MAX_QUEUE) { close(); return; }
    if (!child.stdin.write(`${JSON.stringify(message)}\n`)) {
      for (const socket of sockets.values()) socket.pause();
    }
  };
  child.stdin.on('drain', () => { for (const socket of sockets.values()) socket.resume(); });
  child.stdin.on('error', close);
  child.stderr.on('data', () => { /* Drain without exposing worker-controlled text. */ });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_FRAME * 2) { close(); return; }
    let index: number;
    while (!closed && (index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.length > MAX_FRAME) { close(); return; }
      try {
        const message = JSON.parse(line) as { op?: unknown; id?: unknown; data?: unknown };
        if (message.op === 'ready' && !ready) { ready = true; resolveReady(); continue; }
        const id = message.id;
        if (!ready || typeof id !== 'string' || !/^\d{1,12}$/.test(id)) throw new Error('invalid frame');
        if (message.op === 'open') {
          if (sockets.has(id) || sockets.size >= MAX_CONNECTIONS) throw new Error('connection limit');
          const socket = connect({ host: '127.0.0.1', port: proxyPort });
          sockets.set(id, socket);
          socket.setTimeout(30_000, () => socket.destroy());
          socket.on('data', (bytes) => {
            for (let i = 0; i < bytes.length; i += 16_384) send({ op: 'data', id, data: bytes.subarray(i, i + 16_384).toString('base64') });
          });
          socket.on('error', () => undefined);
          socket.on('close', () => { sockets.delete(id); send({ op: 'close', id }); });
        } else if (message.op === 'close') {
          sockets.get(id)?.destroy();
        } else if (message.op === 'data' && typeof message.data === 'string' && message.data.length <= MAX_FRAME) {
          const socket = sockets.get(id);
          if (!socket) continue;
          const bytes = Buffer.from(message.data, 'base64');
          if (socket.writableLength + bytes.length > MAX_QUEUE) socket.destroy();
          else socket.write(bytes);
        } else throw new Error('invalid frame');
      } catch { close(); }
    }
  });
  child.on('error', close);
  child.on('close', close);
  const timer = setTimeout(close, 10_000);
  try { await started; } finally { clearTimeout(timer); }
  return { get closed() { return closed; }, close };
}
