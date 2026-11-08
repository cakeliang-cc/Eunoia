/** R04/R05: real Chromium + real MCP + production pipe proxy, no host browser. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import sharp from 'sharp';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { BrowserRuntime } from '../../src/browser/runtime.ts';
import { McpClientManager } from '../../src/mcp/manager.ts';
import { MemoryMcpStore } from '../../src/mcp/store-memory.ts';
import { loadSecretBox, McpCredentialVault } from '../../src/mcp/credentials.ts';
import { DEFAULT_CONFIG_PARSE_OPTIONS, parseServerInput } from '../../src/mcp/config.ts';
import { rootExecutionScope, type ExecutionScope } from '../../src/tools/scope.ts';
import { ContainerCli } from '../../src/sandbox/runtime/container-cli.ts';

const enabled = process.env.BROWSER_INTEGRATION === '1' && Boolean(process.env.EUNOIA_BROWSER_IMAGE_DIGEST);
describe.skipIf(!enabled)('isolated browser execution', () => {
  const fixture = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'memberCookie=private; Path=/' });
    res.end('<html><title>Isolated preview</title><body><h1>Production pipe proxy</h1><p id="state"></p></body></html>');
  });
  const cli = new ContainerCli({ binary: 'docker', kind: 'docker' });
  const store = new MemoryMcpStore();
  const config = parseServerInput({ name: 'Browser', transport: 'stdio', enabled: true, stdio: { command: 'eunoia-browser', args: [], runLocation: 'browser' }, toolPolicy: { trustReadOnlyHint: true } }, { ...DEFAULT_CONFIG_PARSE_OPTIONS, userId: 'browser-user' }).config;
  const a: ExecutionScope = { ...rootExecutionScope({ userId: config.userId, conversationId: 'member-a' }), identity: { userId: config.userId, conversationId: 'member-a', role: 'member', memberId: 'a' } };
  const b: ExecutionScope = { ...rootExecutionScope({ userId: config.userId, conversationId: 'member-b' }), identity: { userId: config.userId, conversationId: 'member-b', role: 'member', memberId: 'b' } };
  let port = 0;
  const importedImages: Buffer[] = [];
  let manager: McpClientManager;
  beforeAll(async () => {
    await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    const address = fixture.address();
    if (!address || typeof address === 'string') throw new Error('fixture not listening');
    port = address.port;
    fixture.on('upgrade', (req, socket) => {
      const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.on('error', () => undefined);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      socket.write(Buffer.from([0x81, 5, ...Buffer.from('hello')]));
      socket.on('data', () => socket.end());
    });
    const runtime = new BrowserRuntime({ env: { ...process.env, SANDBOX_RUNTIME_CLASS: 'runc', SANDBOX_ALLOW_NON_GVISOR: '1', EUNOIA_BROWSER_ALLOWED_DOMAINS: 'example.com' }, previewRoute: async (scope, url) => url.protocol === 'http:' && url.hostname === `${scope.identity.memberId}.preview.localhost` && url.port === String(port) ? { address: '127.0.0.1', port } : null });
    manager = new McpClientManager({ store, vault: new McpCredentialVault(store, loadSecretBox({})), browserRuntime: runtime });
    await store.insertMcpServer(config);
    const status = await manager.connect(config.userId, config.id);
    expect(status.lastError, JSON.stringify(status.lastError)).toBeNull();
    expect(status.state).toBe('ready');
  }, 60_000);
  afterAll(async () => { await manager?.shutdown(); fixture.closeAllConnections(); await new Promise<void>((resolve) => fixture.close(() => resolve())); });

  async function call(scope: ExecutionScope, name: string, args: Record<string, unknown>) {
    const catalog = await manager.catalog(config.userId, config.id);
    const tool = catalog?.tools.find((entry) => entry.originalName === name);
    if (!catalog || !tool) throw new Error(`missing tool ${name}`);
    return manager.callTool({ userId: config.userId, serverId: config.id, originalName: name, arguments: args, catalogRevision: catalog.revision, contractHash: tool.contractHash, actionId: randomUUID(), conversationId: scope.identity.conversationId, identity: catalog.identity, scope, importImage: async (image) => {
      const bytes = Buffer.from(image.bytes); const metadata = await sharp(bytes).metadata();
      importedImages.push(bytes);
      return { assetId: `real-screenshot-${importedImages.length}`, mediaType: image.mediaType, width: metadata.width!, height: metadata.height!, bytes: bytes.length, name: image.name };
    } });
  }
  const text = (result: unknown): string => JSON.stringify(result);

  it('navigates an owned preview and keeps member profiles/pages separate', async () => {
    expect(text(await call(a, 'browser_navigate', { url: `http://a.preview.localhost:${port}/` }))).toContain('Isolated preview');
    expect(text(await call(a, 'browser_snapshot', {}))).toContain('Production pipe proxy');
    await call(a, 'browser_evaluate', { function: '() => { localStorage.setItem("memberSecret", "only-a"); return document.cookie; }' });
    expect(text(await call(b, 'browser_tabs', { action: 'list' }))).not.toContain('a.preview.localhost');
    expect(text(await call(b, 'browser_navigate', { url: `http://b.preview.localhost:${port}/` }))).toContain('Isolated preview');
    expect(text(await call(b, 'browser_evaluate', { function: '() => localStorage.getItem("memberSecret")' }))).not.toContain('only-a');
    expect(text(await call(a, 'browser_evaluate', { function: '() => localStorage.getItem("memberSecret")' }))).toContain('only-a');
  }, 60_000);

  it('refuses cross-member previews, host/metadata, redirects, unapproved public hosts and file URLs', async () => {
    for (const url of [`http://b.preview.localhost:${port}/`, 'http://127.0.0.1:8788/health', 'http://host.docker.internal:8788/health', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]:8788/health', 'https://example.org/', `http://a.preview.localhost:${port}/redirect`, 'file:///etc/passwd']) {
      const result = await call(a, 'browser_navigate', { url });
      expect(text(result)).not.toContain('root:x:');
      expect(text(result)).toMatch(/Error|403|Forbidden|blocked|denied|ERR_/i);
    }
  }, 120_000);

  it('takes a real PNG and denies direct TCP/DNS/UDP/IPv6 even with proxy settings cleared', async () => {
    await call(a, 'browser_navigate', { url: `http://a.preview.localhost:${port}/` });
    const result = await call(a, 'browser_take_screenshot', { type: 'png', filename: 'proof.png' });
    expect(importedImages.length, text(result)).toBeGreaterThan(0);
    expect(importedImages.at(-1)!.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(text(result)).toContain('real-screenshot-');
    const listed = await cli.runChecked(['ps', '--filter', `label=eunoia.mcp.server=${config.id}`, '--format', '{{.Names}}']);
    const names = listed.stdout.trim().split('\n').filter(Boolean);
    expect(names.length).toBeGreaterThanOrEqual(3);
    for (const name of names) {
      const info = JSON.parse((await cli.runChecked(['inspect', '--format', '{{json .HostConfig}}', name])).stdout) as { NetworkMode: string; Privileged: boolean; ReadonlyRootfs: boolean; Binds: unknown };
      expect(info.NetworkMode).toBe('none'); expect(info.Privileged).toBe(false); expect(info.ReadonlyRootfs).toBe(true); expect(info.Binds).toBeNull();
      const bypass = await cli.runChecked(['exec', name, 'node', '-e', String.raw`const net=require('net'),dns=require('dns'),dgram=require('dgram');Promise.all([new Promise(r=>{const s=net.connect(443,'1.1.1.1');s.on('connect',()=>r('TCP_BYPASS'));s.on('error',()=>r('tcp-blocked'));s.setTimeout(1000,()=>{s.destroy();r('tcp-blocked')})}),new Promise(r=>{const s=net.connect(80,'2606:4700:4700::1111');s.on('connect',()=>r('IPV6_BYPASS'));s.on('error',()=>r('ipv6-blocked'));s.setTimeout(1000,()=>{s.destroy();r('ipv6-blocked')})}),new Promise(r=>{const s=dgram.createSocket('udp4');s.on('error',()=>{s.close();r('udp-blocked')});s.send('x',53,'8.8.8.8',e=>{s.close();r(e?'udp-blocked':'UDP_BYPASS')})}),new Promise(r=>{dns.resolve4('example.com',e=>r(e?'dns-blocked':'DNS_BYPASS'));setTimeout(()=>r('dns-blocked'),1500)})]).then(x=>{console.log(x.join(','));process.exit(0)})`], { timeoutMs: 5_000 });
      expect(bypass.stdout).not.toMatch(/BYPASS/);
    }
  }, 60_000);

  it('opens the owned preview WebSocket and refuses a sibling member WebSocket', async () => {
    await call(a, 'browser_navigate', { url: `http://a.preview.localhost:${port}/` });
    const evaluate = (host: string) => call(a, 'browser_evaluate', { function: `() => new Promise(resolve => { const socket = new WebSocket('ws://${host}.preview.localhost:${port}/ws'); socket.onmessage = event => { resolve(event.data); socket.close(); }; socket.onerror = () => resolve('blocked'); setTimeout(() => { socket.close(); resolve('timeout'); }, 5000); })` });
    expect(text(await evaluate('a'))).toContain('hello');
    expect(text(await evaluate('b'))).toContain('blocked');
  }, 30_000);

  it('allows an explicitly approved public HTTPS host through CONNECT', async () => {
    expect(text(await call(b, 'browser_navigate', { url: 'https://example.com/' }))).toContain('Example Domain');
  }, 60_000);

  it('does not share cookies or local storage even on the same permitted public origin', async () => {
    await call(a, 'browser_navigate', { url: 'https://example.com/' });
    await call(a, 'browser_evaluate', { function: '() => { document.cookie = "memberSecret=only-a; Path=/"; localStorage.setItem("memberSecret", "only-a"); return document.cookie; }' });
    await call(b, 'browser_navigate', { url: 'https://example.com/' });
    const other = await call(b, 'browser_evaluate', { function: '() => ({cookie: document.cookie, storage: localStorage.getItem("memberSecret")})' });
    expect(text(other)).not.toContain('only-a');
    expect(text(await call(a, 'browser_evaluate', { function: '() => ({cookie: document.cookie, storage: localStorage.getItem("memberSecret")})' }))).toContain('only-a');
  }, 90_000);

  it('revokes an existing member browser after its network ceiling narrows', async () => {
    const narrowed = { ...a, capabilities: { ...a.capabilities, network: { mode: 'none' as const } } };
    expect(text(await call(narrowed, 'browser_navigate', { url: `http://a.preview.localhost:${port}/` }))).toMatch(/403|Forbidden|Error|ERR_/);
    await manager.closeBrowserSessions({ userId: config.userId, conversationId: 'member-a' });
    await manager.closeBrowserSessions({ userId: config.userId, conversationId: 'member-b' });
  }, 60_000);
  it('reaps the actual browser container when its control process is SIGKILLed', async () => {
    const id = randomUUID();
    const child = spawn(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('../fixtures/browser-worker-crash.ts', import.meta.url)), id], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const ready = new Promise<void>((resolve, reject) => {
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); if (output.includes('BROWSER_READY')) resolve(); });
      child.stderr.on('data', () => undefined);
      child.on('exit', () => reject(new Error('fixture exited before ready')));
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    try {
      await ready;
      const before = await cli.runChecked(['ps', '--filter', `label=eunoia.mcp.server=${id}`, '--format', '{{.Names}}']);
      expect(before.stdout.trim()).toMatch(/^eunoia-browser-/);
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
      await expect.poll(async () => (await cli.runChecked(['ps', '-a', '--filter', `label=eunoia.mcp.server=${id}`, '--format', '{{.Names}}'])).stdout.trim(), { timeout: 10_000 }).toBe('');
    } finally {
      clearTimeout(timer); child.kill('SIGKILL');
      const remaining = (await cli.run(['ps', '-aq', '--filter', `label=eunoia.mcp.server=${id}`])).stdout.trim().split('\n').filter(Boolean);
      if (remaining.length) await cli.run(['rm', '-f', ...remaining]);
    }
  }, 45_000);

});
