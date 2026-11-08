/**
 * `read_image` against a real workspace and the real media pipeline.
 *
 * The important properties are the refusals and the identity: a `.jpg` holding
 * PNG bytes is stored as PNG, editing the source afterwards does not change the
 * asset, and anything that is not JPEG/PNG/WebP is refused rather than guessed.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { MemoryMediaBlobStore } from '../../src/media/blob-store.ts';
import { MediaService } from '../../src/media/service.ts';
import { DEFAULT_MEDIA_LIMITS } from '../../src/media/limits.ts';
import { createToolMediaPort } from '../../src/media/tool-media.ts';
import { WorkspaceFiles } from '../../src/sandbox/workspace-files.ts';
import { readImageTool } from '../../src/tools/coding/read-image-tool.ts';
import { DEFAULT_TOOL_POLICY } from '../../src/tools/types.ts';
import type { ToolContext } from '../../src/tools/types.ts';
import { TurnReadLedger } from '../../src/tools/ledger.ts';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function setup(files: Record<string, Buffer | string>): Promise<{
  context: ToolContext;
  media: MediaService;
  root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'eunoia-read-image-'));
  for (const [path, body] of Object.entries(files)) {
    await writeFile(join(root, path), body);
  }
  const media = new MediaService({
    store: new InMemoryStore(),
    blobs: new MemoryMediaBlobStore(),
    limits: DEFAULT_MEDIA_LIMITS,
  });
  cleanups.push(async () => rm(root, { recursive: true, force: true }));
  return {
    root,
    media,
    context: {
      workspace: new WorkspaceFiles({ root }),
      policy: DEFAULT_TOOL_POLICY,
      ledger: new TurnReadLedger(),
      now: new Date('2026-07-01T00:00:00Z'),
      userId: 'user-1',
      conversationId: 'conv-1',
      toolCallId: 'call-1',
      media: createToolMediaPort(media),
    },
  };
}

async function run(context: ToolContext, path: string) {
  const checked = readImageTool.contract?.validate({ file_path: path });
  if (!checked || !checked.ok) throw new Error(checked?.error ?? 'contract missing');
  return readImageTool.execute(checked.value, context);
}

describe('read_image', () => {
  it('stores the actual decoded format and returns an image block', async () => {
    const png = await sharp({ create: { width: 4, height: 3, channels: 3, background: '#336699' } })
      .png()
      .toBuffer();
    const { context, media } = await setup({ 'design.png': png });
    const result = await run(context, 'design.png');
    expect(result.ok).toBe(true);
    const image = result.content?.find((block) => block.type === 'image');
    expect(image?.type).toBe('image');
    if (image?.type === 'image') {
      expect(image.mediaType).toBe('image/png');
      expect(image.width).toBe(4);
      expect(image.height).toBe(3);
      const preview = await media.readPreview('user-1', image.assetId);
      expect(preview.asset.status).toBe('bound');
    }
  });

  it('refuses an extension whose declared type does not match the bytes', async () => {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#000' } })
      .png()
      .toBuffer();
    const { context } = await setup({ 'fake.jpg': png });
    const result = await run(context, 'fake.jpg');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('图片无法解码');
  });

  it('keeps the bytes immutable after the source file changes', async () => {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } })
      .png()
      .toBuffer();
    const { context, media, root } = await setup({ 'a.png': png });
    const result = await run(context, 'a.png');
    const image = result.content?.find((block) => block.type === 'image');
    if (image?.type !== 'image') throw new Error('no image');
    const before = await media.readPreview('user-1', image.assetId);
    const other = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#000000' } })
      .png()
      .toBuffer();
    await writeFile(join(root, 'a.png'), other);
    const after = await media.readPreview('user-1', image.assetId);
    expect(Buffer.compare(before.bytes, after.bytes)).toBe(0);
  });

  it('refuses formats it does not support', async () => {
    const { context } = await setup({ 'drawing.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>' });
    const result = await run(context, 'drawing.svg');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('不支持的图片格式');
  });

  it('refuses a missing file and a path outside the workspace', async () => {
    const { context } = await setup({});
    expect((await run(context, 'missing.png')).ok).toBe(false);
    expect((await run(context, '../../etc/passwd.png')).ok).toBe(false);
  });

  it('refuses a file that only claims to be an image', async () => {
    const { context } = await setup({ 'fake.png': 'not an image at all' });
    const result = await run(context, 'fake.png');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('图片无法解码');
  });

  it('refuses too large a file before decoding', async () => {
    const { context } = await setup({ 'big.png': Buffer.alloc(21 * 1024 * 1024) });
    const result = await run(context, 'big.png');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('上限');
  });

  it('refuses without media or conversation context', async () => {
    const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#000' } })
      .png()
      .toBuffer();
    const { context } = await setup({ 'a.png': png });
    const withoutMedia = { ...context, media: null };
    expect((await run(withoutMedia, 'a.png')).ok).toBe(false);
    const withoutConversation = { ...context, conversationId: undefined };
    expect((await run(withoutConversation, 'a.png')).ok).toBe(false);
  });

  it('does not read a symlink that points outside the workspace', async () => {
    const { context, root } = await setup({});
    const outside = await mkdtemp(join(tmpdir(), 'eunoia-outside-'));
    cleanups.push(async () => rm(outside, { recursive: true, force: true }));
    const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#000' } })
      .png()
      .toBuffer();
    await writeFile(join(outside, 'secret.png'), png);
    await import('node:fs/promises').then(({ symlink }) =>
      symlink(join(outside, 'secret.png'), join(root, 'link.png')),
    );
    const result = await run(context, 'link.png');
    expect(result.ok).toBe(false);
  });
});
