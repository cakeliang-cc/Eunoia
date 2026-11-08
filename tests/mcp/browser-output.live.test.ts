/**
 * The opt-in real Playwright MCP check (R06).
 *
 * This test starts the installed `@playwright/mcp` as a real stdio server with a
 * temporary `--output-dir`, navigates headless Chrome to a local page, takes a
 * screenshot and asserts that the *file path* the server returned became a media
 * asset and one image block.
 *
 * `--image-responses omit` is deliberate: it forces the file-path branch instead
 * of letting the server send base64, which is what this card is about.
 *
 * It is skipped, never silently passed, when the live prerequisites are absent.
 * Run with:
 *
 *   PLAYWRIGHT_MCP_LIVE=1 npx vitest run tests/mcp/browser-output.live.test.ts
 *
 * `PLAYWRIGHT_MCP_CLI` may point at a `@playwright/mcp` `cli.js` outside this
 * checkout (useful when the package is installed in another prefix).
 *
 * The child gets a temporary `HOME`: Playwright keeps a per-user server registry
 * under the OS cache directory, and a deployment that cannot write there must
 * not turn into a browser failure. `PLAYWRIGHT_MCP_LIVE_NO_SANDBOX=1` adds
 * Chrome's `--no-sandbox` for outer sandboxes (containers, CI) that forbid
 * Chrome's own sandbox; it is never enabled silently.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { McpClientManager } from '../../src/mcp/manager.ts';
import { MemoryMcpStore } from '../../src/mcp/store-memory.ts';
import { loadSecretBox, McpCredentialVault } from '../../src/mcp/credentials.ts';
import { DEFAULT_CONFIG_PARSE_OPTIONS, parseServerInput } from '../../src/mcp/config.ts';
import type { McpCatalog } from '../../src/mcp/types.ts';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { MemoryMediaBlobStore } from '../../src/media/blob-store.ts';
import { MediaService } from '../../src/media/service.ts';
import { DEFAULT_MEDIA_LIMITS } from '../../src/media/limits.ts';
import { DecodeGate } from '../../src/media/decode.ts';
import { createToolMediaPort } from '../../src/media/tool-media.ts';
import type { ToolContentBlock } from '../../src/tools/types.ts';

const USER = 'user-1';
const CONVERSATION = 'conv-1';
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

function resolvePlaywrightCli(): string | null {
  const override = process.env.PLAYWRIGHT_MCP_CLI?.trim();
  if (override && existsSync(override)) return override;
  const require = createRequire(import.meta.url);
  try {
    const entry = require.resolve('@playwright/mcp');
    const cli = join(dirname(entry), 'cli.js');
    if (existsSync(cli)) return cli;
  } catch {
    // Not installed in this checkout; fall through to the bin path.
  }
  const bin = join(process.cwd(), 'node_modules', '.bin', 'playwright-mcp');
  return existsSync(bin) ? bin : null;
}

function chromeExecutable(): string | null {
  const candidates = [
    process.env.PLAYWRIGHT_MCP_CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function startPage(): Promise<{ readonly url: string; readonly close: () => Promise<void> }> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      '<!doctype html><html><body style="margin:0;background:#123456">' +
        '<h1 style="color:#fff;font:48px sans-serif">Eunoia R06</h1>' +
        '</body></html>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function callTool(
  manager: McpClientManager,
  catalog: McpCatalog,
  media: MediaService,
  originalName: string,
  args: Record<string, unknown>,
) {
  const entry = catalog.tools.find((tool) => tool.originalName === originalName);
  if (!entry) throw new Error(`no tool ${originalName}`);
  const actionId = randomUUID();
  await manager.ensureAction({
    id: actionId,
    userId: USER,
    conversationId: CONVERSATION,
    turnId: null,
    step: null,
    callId: `call-${actionId}`,
    serverId: catalog.serverId,
    identity: catalog.identity,
    catalogRevision: catalog.revision,
    contractHash: entry.contractHash,
    toolName: originalName,
    argumentsJson: JSON.stringify(args),
    argumentsDigest: 'd',
    classification: 'external_read',
    state: 'prepared',
    conclusion: null,
    error: null,
    resultJson: null,
    sentAt: null,
    finishedAt: null,
    createdAt: new Date().toISOString(),
  });
  const port = createToolMediaPort(media);
  const mapped = await manager.callTool({
    userId: USER,
    serverId: catalog.serverId,
    originalName,
    arguments: args,
    catalogRevision: catalog.revision,
    contractHash: entry.contractHash,
    actionId,
    conversationId: CONVERSATION,
    identity: catalog.identity,
    importImage: (image) =>
      port.importToolImage({
        userId: USER,
        conversationId: CONVERSATION,
        actionId,
        name: image.name,
        mediaType: image.mediaType,
        bytes: image.bytes,
      }),
  });
  return { mapped, actionId };
}

describe('live @playwright/mcp screenshot file path', () => {
  it(
    'becomes one tool image after navigating a real headless Chrome',
    async (ctx) => {
      if (process.env.PLAYWRIGHT_MCP_LIVE !== '1') {
        ctx.skip('PLAYWRIGHT_MCP_LIVE is not 1; this is an opt-in real-browser check');
        return;
      }
      const cli = resolvePlaywrightCli();
      if (!cli) {
        ctx.skip(
          '@playwright/mcp is not installed: no node_modules/@playwright/mcp/cli.js and PLAYWRIGHT_MCP_CLI is unset',
        );
        return;
      }
      const chrome = chromeExecutable();
      if (!chrome) {
        ctx.skip('no Chrome/Chromium executable found for --browser chrome');
        return;
      }

      const directory = await mkdtemp(join(tmpdir(), 'eunoia-pw-live-'));
      const outputDir = join(directory, 'browser-output');
      await mkdir(outputDir);
      cleanups.push(() => rm(directory, { recursive: true, force: true }));

      const parsed = parseServerInput(
        {
          name: 'Playwright live',
          enabled: true,
          transport: 'stdio',
          stdio: {
            command: process.execPath,
            args: [
              cli,
              '--browser',
              'chrome',
              '--headless',
              '--isolated',
              '--image-responses',
              'omit',
              ...(process.env.PLAYWRIGHT_MCP_LIVE_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
              '--output-dir',
              outputDir,
            ],
            runLocation: 'host',
            // Playwright writes a server registry under the OS cache directory.
            // Point HOME at the temp directory so this check does not require a
            // writable user cache (and does not touch the real one).
            envRefs: { HOME: 'env:MCP_PLAYWRIGHT_HOME' },
          },
          toolPolicy: { autoApproveReads: true },
        },
        {
          ...DEFAULT_CONFIG_PARSE_OPTIONS,
          userId: USER,
          allowHostProcess: true,
          newId: () => randomUUID(),
        },
      );

      const home = join(directory, 'home');
      await mkdir(home, { recursive: true });
      const env = { ...process.env, MCP_PLAYWRIGHT_HOME: home };
      const store = new MemoryMcpStore();
      const vault = new McpCredentialVault(store, loadSecretBox({}));
      const manager = new McpClientManager({
        store,
        vault,
        now: () => new Date(),
        browserOutput: { cwd: process.cwd() },
        connect: (connectionOptions) =>
          import('../../src/mcp/client.ts').then(({ McpConnection }) =>
            McpConnection.open({ ...connectionOptions, env }),
          ),
      });
      await store.insertMcpServer(parsed.config);
      cleanups.push(() => manager.shutdown());

      const mediaStore = new InMemoryStore();
      const blobs = new MemoryMediaBlobStore();
      const media = new MediaService({
        store: mediaStore,
        blobs,
        limits: DEFAULT_MEDIA_LIMITS,
        gate: new DecodeGate(2),
      });

      const status = await manager.connect(USER, parsed.config.id);
      if (status.state !== 'ready') {
        const message = status.lastError?.message ?? status.state;
        if (/Executable doesn't exist|Failed to launch|Missing X server|Host system is missing|browserType\.launch/i.test(message)) {
          ctx.skip(`Playwright could not launch Chrome (${chrome}): ${message}`);
          return;
        }
        throw new Error(`connect failed: ${status.state} ${JSON.stringify(status.lastError)}`);
      }
      const catalog = await manager.catalog(USER, parsed.config.id);
      if (!catalog) throw new Error('no catalog');
      if (!catalog.tools.some((tool) => tool.originalName === 'browser_navigate')) {
        ctx.skip(
          `the installed @playwright/mcp (${catalog.serverInfo?.version ?? 'unknown version'}) exposes no browser_navigate`,
        );
        return;
      }

      const page = await startPage();
      const navigated = await callTool(manager, catalog, media, 'browser_navigate', {
        url: page.url,
      });
      if (!navigated.mapped.result.ok) {
        const message = navigated.mapped.result.error ?? navigated.mapped.result.output;
        if (/Target crashed|Failed to launch|Executable doesn't exist|Missing X server|Protocol error|browser has been closed/i.test(message)) {
          ctx.skip(`Chrome could not run in this environment (${chrome}): ${message.slice(0, 300)}`);
          return;
        }
        throw new Error(`browser_navigate failed: ${message}`);
      }
      expect(navigated.mapped.result.output).toContain(page.url);

      const shot = await callTool(manager, catalog, media, 'browser_take_screenshot', {});
      expect(shot.mapped.result.ok).toBe(true);
      const blocks: readonly ToolContentBlock[] = shot.mapped.result.content ?? [];
      const images = blocks.filter(
        (block): block is Extract<ToolContentBlock, { type: 'image' }> => block.type === 'image',
      );
      // `--image-responses omit` means the server sent no image block; the one
      // we assert here must be the imported file.
      expect(
        images,
        JSON.stringify({
          ok: shot.mapped.result.ok,
          browser: shot.mapped.result.meta?.browser,
          output: shot.mapped.result.output.slice(0, 600),
        }),
      ).toHaveLength(1);
      const image = images[0] as Extract<ToolContentBlock, { type: 'image' }>;
      expect(image.source).toBe('tool');
      expect(blocks[0]?.type).toBe('text');

      const files = (await readdir(outputDir)).filter((name) => /\.(png|jpg|jpeg|webp)$/i.test(name));
      expect(files.length).toBeGreaterThan(0);
      expect(files).toContain(image.name);
      const fileBytes = await readFile(join(outputDir, image.name));
      const fileHash = createHash('sha256').update(fileBytes).digest('hex');
      const asset = await mediaStore.getMediaAsset(USER, image.assetId);
      expect(asset?.sha256).toBe(fileHash);
      expect(asset?.bytes).toBe(fileBytes.length);
      expect(asset?.status).toBe('bound');
      expect((await media.readOriginal(asset!)).equals(fileBytes)).toBe(true);
      expect(shot.mapped.result.output).not.toContain(outputDir);
      expect(shot.mapped.result.meta?.browser).toMatchObject({
        status: 'imported',
        tool: 'browser_take_screenshot',
        file: image.name,
      });
    },
    180_000,
  );
});
