/**
 * Image fixtures and a media seeding helper.
 *
 * Generated at test time rather than committed as binaries: a repository full of
 * JPEGs is hard to review, and a committed 10 MB "large image" is a test nobody
 * wants to clone. `sharp` produces deterministic bytes for the dimensions and
 * format each case actually needs.
 */

import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { decodeImage, DecodeGate } from '../../src/media/decode.ts';
import { DEFAULT_MEDIA_LIMITS } from '../../src/media/limits.ts';
import type { BlobPaths, MediaBlobStore } from '../../src/media/blob-store.ts';
import type { MediaAssetStore } from '../../src/media/store.ts';
import type { ImageAsset, ImageMediaType } from '../../src/media/types.ts';

export async function imageBytes(
  width: number,
  height: number,
  options: {
    readonly format?: ImageMediaType;
    readonly color?: string;
    /** Add deterministic noise so compression ratio varies without dimensions. */
    readonly noise?: boolean;
  } = {},
): Promise<Buffer> {
  const format = options.format ?? 'image/png';
  let image = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: options.color ?? '#d94f4f',
    },
  });
  if (options.noise === true) {
    const channels = 3;
    const data = Buffer.alloc(width * height * channels);
    let seed = 17;
    for (let index = 0; index < data.length; index += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      data[index] = seed % 256;
    }
    image = sharp(data, { raw: { width, height, channels } });
  }
  if (format === 'image/jpeg') return image.jpeg({ quality: 80 }).toBuffer();
  if (format === 'image/webp') return image.webp({ quality: 80 }).toBuffer();
  return image.png({ compressionLevel: options.noise ? 0 : 9 }).toBuffer();
}

/** A minimal valid 1×1 GIF, used to prove moving/other formats are refused. */
export const ONE_PIXEL_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
  'base64',
);

export const SVG_DOCUMENT = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
  'utf8',
);

/** A valid PNG with an `acTL` marker appended: enough for APNG detection. */
export async function apngMarkerBytes(): Promise<Buffer> {
  const png = await imageBytes(32, 32);
  return Buffer.concat([png, Buffer.from('acTL', 'ascii')]);
}

export function makeAsset(overrides: Partial<ImageAsset> = {}): ImageAsset {
  const id = overrides.id ?? randomUUID();
  const sha = overrides.sha256 ?? randomUUID().replace(/-/g, '');
  const directory = `${overrides.userId ?? 'user-1'}/${overrides.conversationId ?? 'conv-1'}/${id}`;
  const width = overrides.width ?? 100;
  const height = overrides.height ?? 80;
  return {
    id,
    userId: overrides.userId ?? 'user-1',
    conversationId: overrides.conversationId ?? 'conv-1',
    name: overrides.name ?? 'image.png',
    mediaType: overrides.mediaType ?? 'image/png',
    bytes: overrides.bytes ?? 1_000,
    width,
    height,
    sha256: sha,
    storageKey: overrides.storageKey ?? `${directory}/original.png`,
    normalized: overrides.normalized ?? {
      key: `${directory}/normalized.png`,
      width,
      height,
      bytes: 1_000,
      sha256: sha,
      processorVersion: 'test',
      policyRevision: 'request-variant/1',
    },
    request: overrides.request ?? {
      key: `${directory}/request.png`,
      width: Math.min(width, 2_048),
      height: Math.min(height, 2_048),
      bytes: 900,
      sha256: sha,
      processorVersion: 'test',
      policyRevision: 'request-variant/1',
    },
    status: overrides.status ?? 'pending',
    leaseExpiresAt: overrides.leaseExpiresAt ?? null,
    createdAt: overrides.createdAt ?? new Date(),
  };
}

/** Decode and persist an asset into a store + blob store, as an upload would. */
export async function seedAsset(input: {
  readonly store: MediaAssetStore;
  readonly blobs: MediaBlobStore;
  readonly userId: string;
  readonly conversationId: string;
  readonly bytes: Uint8Array;
  readonly name?: string;
  readonly status?: ImageAsset['status'];
}): Promise<ImageAsset> {
  const decoded = await decodeImage(
    input.bytes,
    { limits: DEFAULT_MEDIA_LIMITS, declaredMediaType: null },
    new DecodeGate(2),
  );
  const id = randomUUID();
  const extension =
    decoded.mediaType === 'image/jpeg' ? 'jpg' : decoded.mediaType === 'image/png' ? 'png' : 'webp';
  const directory = `${input.userId}/${input.conversationId}/${id}`;
  const paths: BlobPaths = {
    original: `${directory}/original.${extension}`,
    normalized: `${directory}/normalized.${extension}`,
    request: `${directory}/request.${extension}`,
  };
  await input.blobs.put(paths, {
    original: input.bytes,
    normalized: decoded.normalized.data,
    request: decoded.request.data,
  });
  const asset: ImageAsset = {
    id,
    userId: input.userId,
    conversationId: input.conversationId,
    name: input.name ?? 'fixture.png',
    mediaType: decoded.mediaType,
    bytes: input.bytes.length,
    width: decoded.width,
    height: decoded.height,
    sha256: decoded.sha256,
    storageKey: paths.original,
    normalized: {
      key: paths.normalized,
      width: decoded.normalized.width,
      height: decoded.normalized.height,
      bytes: decoded.normalized.data.length,
      sha256: decoded.normalized.sha256,
      processorVersion: decoded.processorVersion,
      policyRevision: decoded.policyRevision,
    },
    request: {
      key: paths.request,
      width: decoded.request.width,
      height: decoded.request.height,
      bytes: decoded.request.data.length,
      sha256: decoded.request.sha256,
      processorVersion: decoded.processorVersion,
      policyRevision: decoded.policyRevision,
    },
    status: input.status ?? 'pending',
    leaseExpiresAt: null,
    createdAt: new Date(),
  };
  await input.store.createMediaAsset(asset);
  return asset;
}
