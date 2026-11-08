/**
 * R06: a real MCP server process returns a *file path*, and the host has to turn
 * it into an immutable media asset and the next model request.
 *
 * The server is a real child process speaking MCP over stdio, writing a real PNG
 * under a real temporary `--output-dir`. The media service, store and blob store
 * are real too, so the assertions are about bytes that exist: file hash →
 * asset hash → request-variant hash.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
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
import { planToolImages } from '../../src/service/media-turn.ts';
import { defaultImagePolicies } from '../../src/provider/image-policy-registry.ts';
import { MODEL_CATALOG } from '../../src/models/catalog.ts';
import { MODEL_IDS } from '../../src/config.ts';
import type { ImportedToolImage, ToolContentBlock } from '../../src/tools/types.ts';
import { BROWSER_PNG_4X3, sha256Of } from '../helpers/browser-output.ts';

const fixture = fileURLToPath(
  new URL('../fixtures/playwright-mcp-browser-output-server.mjs', import.meta.url),
);
const USER = 'user-1';
const CONVERSATION = 'conv-1';
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

interface Harness {
  readonly manager: McpClientManager;
  readonly catalog: McpCatalog;
  readonly media: MediaService;
  readonly mediaStore: InMemoryStore;
  readonly blobs: MemoryMediaBlobStore;
  readonly outputDir: string;
  readonly log: string;
  readonly marker: string;
}

async function setup(options: { readonly maxBytes?: number } = {}): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'eunoia-browser-mcp-'));
  const outputDir = join(directory, 'browser-output');
  await mkdir(outputDir);
  const log = join(directory, 'calls.log');
  const marker = `run-${randomUUID()}`;
  const env = {
    ...process.env,
    MCP_TEST_MARKER: marker,
    MCP_TEST_LOG: log,
    MCP_BROWSER_OUTPUT_DIR: outputDir,
  };
  const parsed = parseServerInput(
    {
      name: 'Playwright',
      enabled: true,
      transport: 'stdio',
      stdio: {
        command: process.execPath,
        args: [fixture, '--browser', 'chrome', '--headless', '--output-dir', outputDir],
        runLocation: 'host',
        envRefs: {
          FIXTURE_MARKER: 'env:MCP_TEST_MARKER',
          FIXTURE_LOG: 'env:MCP_TEST_LOG',
          MCP_BROWSER_OUTPUT_DIR: 'env:MCP_BROWSER_OUTPUT_DIR',
        },
      },
    },
    {
      ...DEFAULT_CONFIG_PARSE_OPTIONS,
      userId: USER,
      allowHostProcess: true,
      newId: () => randomUUID(),
    },
  );

  const store = new MemoryMcpStore();
  const vault = new McpCredentialVault(store, loadSecretBox({}));
  const manager = new McpClientManager({
    store,
    vault,
    now: () => new Date(),
    browserOutput: {
      ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
      cwd: process.cwd(),
    },
    connect: (connectionOptions) =>
      import('../../src/mcp/client.ts').then(({ McpConnection }) =>
        McpConnection.open({ ...connectionOptions, env }),
      ),
  });
  await store.insertMcpServer(parsed.config);
  cleanups.push(async () => {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  });

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
    throw new Error(`connect failed: ${status.state} ${JSON.stringify(status.lastError)}`);
  }
  const catalog = await manager.catalog(USER, parsed.config.id);
  if (!catalog) throw new Error('no catalog');
  return { manager, catalog, media, mediaStore, blobs, outputDir, log, marker };
}

async function callScreenshot(
  harness: Harness,
  toolName: 'browser_take_screenshot' | 'browser_storage_state',
  args: Record<string, unknown>,
  options: { readonly withMedia?: boolean } = {},
): Promise<{
  readonly content: readonly ToolContentBlock[];
  readonly output: string;
  readonly meta: Record<string, unknown> | undefined;
  readonly actionId: string;
}> {
  const entry = harness.catalog.tools.find((tool) => tool.originalName === toolName);
  if (!entry) throw new Error(`no tool ${toolName}`);
  const actionId = randomUUID();
  await harness.manager.ensureAction({
    id: actionId,
    userId: USER,
    conversationId: CONVERSATION,
    turnId: null,
    step: null,
    callId: 'call-1',
    serverId: harness.catalog.serverId,
    identity: harness.catalog.identity,
    catalogRevision: harness.catalog.revision,
    contractHash: entry.contractHash,
    toolName,
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
  const port = createToolMediaPort(harness.media);
  const mapped = await harness.manager.callTool({
    userId: USER,
    serverId: harness.catalog.serverId,
    originalName: toolName,
    arguments: args,
    catalogRevision: harness.catalog.revision,
    contractHash: entry.contractHash,
    actionId,
    conversationId: CONVERSATION,
    identity: harness.catalog.identity,
    ...(options.withMedia === false
      ? {}
      : {
          importImage: (image: {
            readonly name: string;
            readonly mediaType: string;
            readonly bytes: Uint8Array;
          }): Promise<ImportedToolImage> =>
            port.importToolImage({
              userId: USER,
              conversationId: CONVERSATION,
              actionId,
              name: image.name,
              mediaType: image.mediaType,
              bytes: image.bytes,
            }),
        }),
  });
  return {
    content: mapped.result.content ?? [],
    output: mapped.result.output,
    meta: mapped.result.meta,
    actionId,
  };
}

function imageBlocks(content: readonly ToolContentBlock[]) {
  return content.filter(
    (block): block is Extract<ToolContentBlock, { type: 'image' }> => block.type === 'image',
  );
}

describe('browser screenshot file path → media pipeline', () => {
  it('imports the file as one immutable tool image and preserves text-then-image', async () => {
    const harness = await setup();
    const result = await callScreenshot(harness, 'browser_take_screenshot', { mode: 'ok' });

    // Order: the server's text stays first, exactly one image follows it.
    expect(result.content.map((block) => block.type)).toEqual(['text', 'image']);
    const images = imageBlocks(result.content);
    expect(images).toHaveLength(1);
    const image = images[0] as Extract<ToolContentBlock, { type: 'image' }>;
    expect(image.source).toBe('tool');
    expect(image.mediaType).toBe('image/png');
    expect(image.width).toBe(4);
    expect(image.height).toBe(3);

    // The file the server wrote is the file that was imported.
    const files = (await readdir(harness.outputDir)).filter((name) => name.endsWith('.png'));
    expect(files).toHaveLength(1);
    const fileBytes = await readFile(join(harness.outputDir, files[0] as string));
    const fileHash = createHash('sha256').update(fileBytes).digest('hex');
    expect(fileHash).toBe(sha256Of(BROWSER_PNG_4X3));
    expect(image.name).toBe(files[0]);

    // The media row is the same bytes, bound to this conversation.
    const asset = await harness.mediaStore.getMediaAsset(USER, image.assetId);
    expect(asset).not.toBeNull();
    expect(asset?.sha256).toBe(fileHash);
    expect(asset?.bytes).toBe(fileBytes.length);
    expect(asset?.status).toBe('bound');
    expect(asset?.conversationId).toBe(CONVERSATION);
    expect(asset?.storageKey).toContain(image.assetId);

    // The blob store really contains the bytes, not a reference.
    const original = await harness.media.readOriginal(asset!);
    expect(original.equals(fileBytes)).toBe(true);
    expect(sha256Of(original)).toBe(fileHash);
    const stored = await harness.blobs.read(asset!.storageKey);
    expect(stored.equals(fileBytes)).toBe(true);

    // No absolute host path or base64 in the text projection.
    expect(result.output).not.toContain(harness.outputDir);
    expect(result.output).not.toContain(fileBytes.toString('base64'));
    expect(result.output).toContain('已导入媒体库');
    expect(result.output).toContain(files[0] as string);
    expect(result.meta?.browser).toMatchObject({
      status: 'imported',
      source: 'file',
      tool: 'browser_take_screenshot',
      file: files[0],
      scope: 'viewport',
      sha256: fileHash,
      width: 4,
      height: 3,
    });
    expect(result.meta?.mcp).toMatchObject({ images: 1, contentBlocks: 2 });
  });

  it('counts a second identical screenshot honestly: the service does not dedupe', async () => {
    const harness = await setup();
    const first = await callScreenshot(harness, 'browser_take_screenshot', { mode: 'double-same' });
    const second = await callScreenshot(harness, 'browser_take_screenshot', { mode: 'double-same' });
    const firstImage = imageBlocks(first.content)[0]!;
    const secondImage = imageBlocks(second.content)[0]!;
    expect(firstImage.assetId).not.toBe(secondImage.assetId);

    const firstAsset = await harness.mediaStore.getMediaAsset(USER, firstImage.assetId);
    const secondAsset = await harness.mediaStore.getMediaAsset(USER, secondImage.assetId);
    expect(firstAsset?.sha256).toBe(secondAsset?.sha256);
    expect(firstAsset?.storageKey).not.toBe(secondAsset?.storageKey);
    expect(await harness.blobs.read(secondAsset!.storageKey)).toBeTruthy();

    // Two imports, two immutable rows. "Deduplicated" would be a lie here; the
    // count is what the request planner must see.
    const assets = await harness.media.conversationAssets(USER, CONVERSATION);
    expect(assets).toHaveLength(2);
    expect(new Set(assets.map((asset) => asset.sha256)).size).toBe(1);
  });

  it('flows into the next model request through the ToolContentBlock image path', async () => {
    const harness = await setup();
    const result = await callScreenshot(harness, 'browser_take_screenshot', { mode: 'ok' });
    const image = imageBlocks(result.content)[0]!;
    const asset = await harness.mediaStore.getMediaAsset(USER, image.assetId);
    if (!asset) throw new Error('asset missing');

    // The loop's prepareMedia → this service-side planner is the exact path a
    // tool-returned image takes before the next model step.
    const planned = await planToolImages(
      {
        media: harness.media,
        policies: defaultImagePolicies(),
        limits: DEFAULT_MEDIA_LIMITS,
      },
      {
        userId: USER,
        conversationId: CONVERSATION,
        profile: MODEL_CATALOG[MODEL_IDS.fast]!,
        imageIds: [image.assetId],
        requiresTools: true,
      },
    );
    expect(planned).not.toBeNull();
    const prepared = planned!.plan.images.get(image.assetId);
    expect(prepared).toBeDefined();
    // file hash → original asset hash → request-variant hash, all real.
    expect(prepared?.sourceSha256).toBe(asset.sha256);
    expect(prepared?.data).toBeDefined();
    expect(sha256Of(prepared!.data!)).toBe(prepared?.variantSha256);
    expect(planned!.plan.imageTokens).toBeGreaterThan(0);
    const metadata = await sharp(prepared!.data!).metadata();
    expect(metadata.width).toBe(prepared?.variantWidth);
    expect(metadata.height).toBe(prepared?.variantHeight);
  });

  it('refuses every untrusted file-path shape without creating an asset', async () => {
    const cases: readonly { mode: string; code: string; maxBytes?: number }[] = [
      { mode: 'outside', code: 'path_outside_output_dir' },
      { mode: 'traversal', code: 'path_outside_output_dir' },
      { mode: 'symlink', code: 'path_outside_output_dir' },
      { mode: 'notimage', code: 'not_an_image' },
      { mode: 'oversized', code: 'file_too_large', maxBytes: 1_024 },
      { mode: 'empty', code: 'file_empty' },
      { mode: 'missing', code: 'file_missing' },
      { mode: 'truncated', code: 'import_failed' },
      { mode: 'url', code: 'path_invalid' },
      { mode: 'empty-text', code: 'path_missing' },
      { mode: 'ambiguous', code: 'path_ambiguous' },
    ];
    for (const testCase of cases) {
      const harness = await setup(
        testCase.maxBytes !== undefined ? { maxBytes: testCase.maxBytes } : {},
      );
      const result = await callScreenshot(harness, 'browser_take_screenshot', {
        mode: testCase.mode,
      });
      expect(result.meta?.browser, testCase.mode).toMatchObject({
        status: 'failed',
        code: testCase.code,
      });
      expect(imageBlocks(result.content), testCase.mode).toHaveLength(0);
      expect(result.output, testCase.mode).toContain('模型没有看到');
      // The note the host adds never names a host path; the server's own text is
      // left untouched (it is external data, and the note says it was not read).
      const note = result.content.at(-1);
      expect(note?.type, testCase.mode).toBe('text');
      if (note?.type === 'text') {
        expect(note.text, testCase.mode).not.toContain(harness.outputDir);
        expect(note.text, testCase.mode).not.toContain('/var/');
        expect(note.text, testCase.mode).not.toContain('/private/');
      }
      expect(JSON.stringify(result.meta?.browser), testCase.mode).not.toContain(harness.outputDir);
      const assets = await harness.media.conversationAssets(USER, CONVERSATION);
      expect(assets, testCase.mode).toHaveLength(0);
    }
  }, 120_000);

  it('never imports a path from a tool outside the allowlist', async () => {
    const harness = await setup();
    const result = await callScreenshot(harness, 'browser_storage_state', {});
    expect(imageBlocks(result.content)).toHaveLength(0);
    // Not applicable: the storage-state link stays ordinary text with no note
    // and no metadata, because the adapter never owned it.
    expect(result.meta?.browser).toBeUndefined();
    expect(result.output).toContain('Storage state');
    expect(await harness.media.conversationAssets(USER, CONVERSATION)).toHaveLength(0);
  });

  it('needs a media store: without one there is no image and the file is not read', async () => {
    const harness = await setup();
    const result = await callScreenshot(
      harness,
      'browser_take_screenshot',
      { mode: 'ok' },
      { withMedia: false },
    );
    expect(imageBlocks(result.content)).toHaveLength(0);
    expect(result.meta?.browser).toMatchObject({ status: 'failed', code: 'no_media_store' });
    expect(result.output).toContain('没有被读取');
    expect(result.output).toContain('模型没有看到');
  });

  it('records the server, instance, tool and action in meta', async () => {
    const harness = await setup();
    const result = await callScreenshot(harness, 'browser_take_screenshot', { mode: 'ok' });
    const browser = result.meta?.browser as Record<string, unknown>;
    expect(browser).toMatchObject({
      serverId: harness.catalog.serverId,
      serverName: 'Playwright',
      tool: 'browser_take_screenshot',
      action: result.actionId,
    });
    expect(String(browser.instanceId)).toContain(harness.catalog.serverId);
    expect(JSON.stringify(browser)).not.toContain(harness.outputDir);
  });
});
