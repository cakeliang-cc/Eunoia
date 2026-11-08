/**
 * The media service owns the join between bytes and authorization.
 *
 * These tests use a real temporary directory so "no half file" is a statement
 * about the filesystem, not about a Map.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { FileMediaBlobStore } from '../../src/media/blob-store.ts';
import { MediaService } from '../../src/media/service.ts';
import { MediaError, isMediaError } from '../../src/media/errors.ts';
import { DEFAULT_MEDIA_LIMITS } from '../../src/media/limits.ts';
import { DecodeGate } from '../../src/media/decode.ts';
import { deepSeekImageTokens } from '../../src/provider/deepseek/image-tokens.ts';
import { imageBytes, seedAsset } from '../helpers/images.ts';
import type { ImageAsset } from '../../src/media/types.ts';

let store: InMemoryStore;
let root: string;
let blobs: FileMediaBlobStore;
let media: MediaService;
let userId: string;
let conversationId: string;
let asset: ImageAsset;
let original: Buffer;

async function expectMediaError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toSatisfy((error: unknown) => {
    expect(isMediaError(error)).toBe(true);
    expect((error as MediaError).code).toBe(code);
    return true;
  });
}

beforeEach(async () => {
  store = new InMemoryStore();
  root = await mkdtemp(join(tmpdir(), 'eunoia-media-'));
  blobs = new FileMediaBlobStore(root);
  media = new MediaService({
    store,
    blobs,
    limits: DEFAULT_MEDIA_LIMITS,
    gate: new DecodeGate(2),
  });
  userId = randomUUID();
  await store.ensureUser(userId);
  conversationId = (await store.createConversation(userId)).id;
  original = await imageBytes(600, 400, { format: 'image/png' });
  asset = await media.putImage({
    userId,
    conversationId,
    name: '设计稿.png',
    declaredMediaType: 'image/png',
    bytes: original,
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('putImage and storage (A03, A08)', () => {
  it('creates a private pending asset with three immutable files', async () => {
    expect(asset.status).toBe('pending');
    expect(asset.mediaType).toBe('image/png');
    expect([asset.width, asset.height]).toEqual([600, 400]);
    expect(asset.bytes).toBe(original.length);
    expect(asset.sha256).toHaveLength(64);

    const originalOnDisk = await blobs.read(asset.storageKey);
    expect(originalOnDisk.equals(original)).toBe(true);
    expect(await blobs.exists(asset.normalized.key)).toBe(true);
    expect(await blobs.exists(asset.request.key)).toBe(true);
    // Private permissions on the asset directory.
    const info = await stat(join(root, asset.storageKey.split('/').slice(0, 3).join('/')));
    expect(info.mode & 0o077).toBe(0);
  });

  it('replay reads the bound bytes, not a workspace file with the same name (A08)', async () => {
    const message = await store.appendMessage({
      conversationId,
      userId,
      role: 'user',
      content: '',
      contentParts: { version: 1, parts: [{ type: 'image', assetId: asset.id }] },
      assetIds: [asset.id],
    });
    // A same-named file elsewhere changing must not affect the asset.
    await writeFile(join(root, '设计稿.png'), Buffer.from('different'));
    const loaded = await media.loadPlanImages(userId, [asset.id]);
    expect(loaded[0]?.bytes.equals(await blobs.read(asset.request.key))).toBe(true);
    expect(await store.messageAssetIds(message.id)).toEqual([asset.id]);
  });

  it('tampering with the original is detected by the digest', async () => {
    await writeFile(join(root, asset.storageKey), Buffer.from('tampered'));
    expect(await media.verifyOriginal(asset)).toBe(false);
  });
});

describe('authorization (A07)', () => {
  it('does not resolve another user\'s or another conversation\'s asset', async () => {
    const other = randomUUID();
    await store.ensureUser(other);
    await expectMediaError(media.resolve(other, conversationId, [asset.id]), 'MEDIA_NOT_FOUND');
    await expectMediaError(
      media.resolve(userId, randomUUID(), [asset.id]),
      'MEDIA_NOT_FOUND',
    );
    await expectMediaError(media.readPreview(other, asset.id), 'MEDIA_NOT_FOUND');
  });
});

describe('draft lifecycle, binding and cleanup (A20)', () => {
  it('deletes an unbound draft but refuses a bound one', async () => {
    const draft = await media.putImage({
      userId,
      conversationId,
      name: 'draft.png',
      declaredMediaType: 'image/png',
      bytes: original,
    });
    await media.deleteDraft(userId, draft.id);
    expect(await store.getMediaAsset(userId, draft.id)).toBeNull();
    await expectMediaError(blobs.read(draft.storageKey), 'MEDIA_NOT_FOUND');

    const message = await store.appendMessage({
      conversationId,
      userId,
      role: 'user',
      content: '',
      contentParts: { version: 1, parts: [{ type: 'image', assetId: asset.id }] },
      assetIds: [asset.id],
    });
    expect(message.contentParts?.parts).toHaveLength(1);
    await expectMediaError(media.deleteDraft(userId, asset.id), 'MEDIA_REFERENCED');
  });

  it('does not collect a bound asset or a live lease, and collects after release', async () => {
    const linked = await media.putImage({
      userId,
      conversationId,
      name: 'linked.png',
      declaredMediaType: 'image/png',
      bytes: original,
    });
    const message = await store.appendMessage({
      conversationId,
      userId,
      role: 'user',
      content: '',
      contentParts: { version: 1, parts: [{ type: 'image', assetId: linked.id }] },
      assetIds: [linked.id],
    });
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    // Age the rows so the grace window has passed.
    const aged = await store.getMediaAsset(userId, linked.id);
    if (aged) {
      await store.deleteMediaAssets([linked.id]);
      await store.createMediaAsset({ ...aged, createdAt: old });
    }

    expect((await media.collect()).removed).toBe(0);

    // A lease also protects a pending draft.
    const leased = await media.putImage({
      userId,
      conversationId,
      name: 'leased.png',
      declaredMediaType: 'image/png',
      bytes: original,
    });
    const leasedRow = await store.getMediaAsset(userId, leased.id);
    if (leasedRow) {
      await store.deleteMediaAssets([leased.id]);
      await store.createMediaAsset({ ...leasedRow, createdAt: old });
    }
    await store.setMediaLease(userId, [leased.id], new Date(Date.now() + 60_000));
    expect((await media.collect()).removed).toBe(0);

    // Releasing the last reference marks it released; the sweep then removes it.
    await store.deleteMessagesAfter(userId, conversationId, 0);
    expect((await store.getMediaAsset(userId, linked.id))?.status).toBe('released');
    const swept = await media.collect();
    expect(swept.removed).toBeGreaterThanOrEqual(1);
    expect(await store.getMediaAsset(userId, linked.id)).toBeNull();
    void message;
  });

  it('enforces the per-message count and total before sending', async () => {
    const one = await media.putImage({
      userId,
      conversationId,
      name: 'a.png',
      declaredMediaType: 'image/png',
      bytes: original,
    });
    expect(() => media.assertMessageImages([one, one, one, one, one, one])).toThrow();
    const tooManyTotal = Array.from({ length: 3 }, () => ({
      ...one,
      bytes: DEFAULT_MEDIA_LIMITS.maxMessageImageBytes,
    }));
    expect(() => media.assertMessageImages(tooManyTotal)).toThrow();
  });
});

describe('transport byte versus visual token (B02)', () => {
  it('same dimensions and different compression have the same visual cost', async () => {
    const noisy = await imageBytes(400, 400, { format: 'image/png', noise: true });
    const flat = await imageBytes(400, 400, { format: 'image/png' });
    expect(noisy.length).not.toBe(flat.length);
    const first = await seedAsset({ store, blobs, userId, conversationId, bytes: noisy });
    const second = await seedAsset({ store, blobs, userId, conversationId, bytes: flat });
    expect(first.request.width).toBe(second.request.width);
    expect(first.request.height).toBe(second.request.height);
    expect(deepSeekImageTokens(first.request.width, first.request.height)).toBe(
      deepSeekImageTokens(second.request.width, second.request.height),
    );
    expect(first.request.bytes).not.toBe(second.request.bytes);
  });
});

describe('failure leaves no half file', () => {
  it('refuses a corrupt decode and leaves the media directory empty', async () => {
    const before = await readdir(root);
    await expectMediaError(
      media.putImage({
        userId,
        conversationId,
        name: 'bad.png',
        declaredMediaType: 'image/png',
        bytes: Buffer.from('not an image'),
      }),
      'MEDIA_CORRUPT',
    );
    expect(await readdir(root)).toEqual(before);
  });
});
