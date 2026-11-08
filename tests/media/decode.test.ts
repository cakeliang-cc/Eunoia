/**
 * Decode is the trust boundary. Extension, header and browser MIME are claims;
 * these tests make the decoder the thing that decides, and pin the derived
 * variant's actual dimensions (which is what a budget counts).
 */

import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { DecodeGate, decodeImage } from '../../src/media/decode.ts';
import { DEFAULT_MEDIA_LIMITS, mediaLimits } from '../../src/media/limits.ts';
import { isMediaError, type MediaError } from '../../src/media/errors.ts';
import {
  SVG_DOCUMENT,
  ONE_PIXEL_GIF,
  apngMarkerBytes,
  imageBytes,
} from '../helpers/images.ts';

const gate = new DecodeGate(2);

async function expectMediaError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toSatisfy((error: unknown) => {
    expect(isMediaError(error)).toBe(true);
    expect((error as { code: string }).code).toBe(code);
    return true;
  });
}

describe('image decoding (A03–A04)', () => {
  it('accepts JPEG, PNG and WebP and reports their actual dimensions', async () => {
    for (const format of ['image/jpeg', 'image/png', 'image/webp'] as const) {
      const bytes = await imageBytes(320, 200, { format });
      const decoded = await decodeImage(
        bytes,
        { limits: DEFAULT_MEDIA_LIMITS, declaredMediaType: format },
        gate,
      );
      expect(decoded.mediaType).toBe(format);
      expect([decoded.width, decoded.height]).toEqual([320, 200]);
      expect([decoded.request.width, decoded.request.height]).toEqual([320, 200]);
      // The original remains byte-identical and keeps its own digest.
      expect(decoded.sha256).toHaveLength(64);
      expect(decoded.request.data.length).toBeGreaterThan(0);
    }
  });

  it('bounds the request variant long edge without upscaling', async () => {
    const bytes = await imageBytes(3_000, 2_000, { format: 'image/jpeg' });
    const decoded = await decodeImage(bytes, { limits: DEFAULT_MEDIA_LIMITS }, gate);
    expect(decoded.request.width).toBe(2_048);
    expect(decoded.request.height).toBeLessThanOrEqual(2_048);
    expect(decoded.width).toBe(3_000);

    const small = await imageBytes(100, 100, { format: 'image/png' });
    const tiny = await decodeImage(small, { limits: DEFAULT_MEDIA_LIMITS }, gate);
    expect([tiny.request.width, tiny.request.height]).toEqual([100, 100]);
  });

  it('rejects a declared MIME that disagrees with the bytes', async () => {
    const png = await imageBytes(20, 20, { format: 'image/png' });
    await expectMediaError(
      decodeImage(png, { limits: DEFAULT_MEDIA_LIMITS, declaredMediaType: 'image/jpeg' }, gate),
      'MEDIA_MIME_MISMATCH',
    );
  });

  it('rejects corrupt bytes, SVG, GIF and APNG', async () => {
    await expectMediaError(
      decodeImage(Buffer.from('not an image'), { limits: DEFAULT_MEDIA_LIMITS }, gate),
      'MEDIA_CORRUPT',
    );
    await expectMediaError(
      decodeImage(SVG_DOCUMENT, { limits: DEFAULT_MEDIA_LIMITS, declaredMediaType: 'image/svg+xml' }, gate),
      'MEDIA_UNSUPPORTED_FORMAT',
    );
    await expectMediaError(
      decodeImage(ONE_PIXEL_GIF, { limits: DEFAULT_MEDIA_LIMITS, declaredMediaType: 'image/gif' }, gate),
      'MEDIA_ANIMATED_UNSUPPORTED',
    );
    // The marker may make libvips refuse the container before our own scan; the
    // contract is an explicit 415 either way, never a usable asset.
    await expect(
      decodeImage(await apngMarkerBytes(), { limits: DEFAULT_MEDIA_LIMITS }, gate),
    ).rejects.toSatisfy((error: unknown) => {
      expect(isMediaError(error)).toBe(true);
      expect((error as MediaError).status).toBe(415);
      return true;
    });
  });

  it('applies EXIF orientation before measuring the variant (B11)', async () => {
    const raw = await sharp({
      create: { width: 300, height: 200, channels: 3, background: '#3388cc' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const decoded = await decodeImage(raw, { limits: DEFAULT_MEDIA_LIMITS }, gate);
    // Orientation 6 is a 90° rotation: the displayed image is portrait.
    expect([decoded.width, decoded.height]).toEqual([200, 300]);
    expect(decoded.request.width).toBeLessThan(decoded.request.height);
  });
});

describe('media limits (A05)', () => {
  it('rejects bytes over the per-file ceiling before decoding', async () => {
    await expectMediaError(
      decodeImage(Buffer.alloc(1_001), { limits: { ...DEFAULT_MEDIA_LIMITS, maxImageBytes: 1_000 } }, gate),
      'MEDIA_TOO_LARGE',
    );
  });

  it('checks dimension and pixel ceilings against the oriented image', async () => {
    const wide = await imageBytes(400, 50);
    await expectMediaError(
      decodeImage(wide, { limits: { ...DEFAULT_MEDIA_LIMITS, maxDimension: 399 } }, gate),
      'MEDIA_DIMENSIONS_EXCEEDED',
    );
    await expectMediaError(
      decodeImage(wide, { limits: { ...DEFAULT_MEDIA_LIMITS, maxPixels: 19_999 } }, gate),
      'MEDIA_PIXELS_EXCEEDED',
    );
  });

  it('accepts an image exactly at the long-edge ceiling', async () => {
    const edge = await imageBytes(120, 1, { format: 'image/png' });
    const decoded = await decodeImage(
      edge,
      { limits: { ...DEFAULT_MEDIA_LIMITS, maxDimension: 120 } },
      gate,
    );
    expect(decoded.width).toBe(120);
  });

  it('accepts exactly 40M pixels and rejects one pixel more', async () => {
    const exact = await imageBytes(8_000, 5_000, { color: '#123456' });
    const decoded = await decodeImage(exact, { limits: DEFAULT_MEDIA_LIMITS }, gate);
    expect(decoded.width * decoded.height).toBe(40_000_000);

    const over = await imageBytes(8_001, 5_000, { color: '#123456' });
    await expectMediaError(
      decodeImage(over, { limits: DEFAULT_MEDIA_LIMITS }, gate),
      'MEDIA_PIXELS_EXCEEDED',
    );
  });

  it('never decodes more than the configured concurrency (A05)', async () => {
    const limited = new DecodeGate(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        limited.run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
        }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(2);
    expect(limited.peak).toBeLessThanOrEqual(2);
  });
});

describe('product limit configuration', () => {
  it('has documented defaults', () => {
    const limits = mediaLimits({});
    expect(limits).toMatchObject({
      maxImagesPerMessage: 5,
      maxImageBytes: 10 * 1024 * 1024,
      maxMessageImageBytes: 20 * 1024 * 1024,
      maxDimension: 8_192,
      maxPixels: 40_000_000,
      maxConcurrentDecodes: 2,
      requestLongEdge: 2_048,
      maxRequestBodyBytes: 32 * 1024 * 1024,
    });
  });
});
