import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { connectPipeProxy } from '../../src/sandbox/network/pipe-proxy.ts';

describe('untrusted reverse proxy frames', () => {
  it.each([
    'process.stdout.write("x".repeat(300000))',
    String.raw`process.stdout.write(JSON.stringify({op:"open",id:"../../host"})+"\n")`,
    String.raw`process.stdout.write(JSON.stringify({op:"execute",id:"1",command:"sh"})+"\n")`,
  ])('closes a malformed/oversized worker stream: %s', async (payload) => {
    const child = spawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify('{"op":"ready"}\n')});setTimeout(()=>{${payload}},30);setInterval(()=>{},1000);`], { stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    const pipe = await connectPipeProxy(child, 1);
    await exited;
    expect(pipe.closed).toBe(true);
  });

  it('fails closed when the worker exits before readiness', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: ['pipe', 'pipe', 'pipe'] });
    await expect(connectPipeProxy(child, 1)).rejects.toThrow(/before ready/);
  });
});
