/**
 * Decode before believing anything about an image.
 *
 * An extension, a browser `File.type` or a request's `Content-Type` is a claim.
 * The only claim this project acts on is what a decoder can actually read, which
 * is why `sharp` sits behind this one module: it validates, applies the EXIF
 * orientation, strips metadata from the derived images, bounds pixels before a
 * full raster is allocated, and gives the real dimensions of the bytes that will
 * be sent.
 *
 * Three derived facts, deliberately separate:
 *
 *   - the **original** bytes, unchanged, hashed and kept private;
 *   - a **normalized** image (orientation applied, EXIF/GPS removed, same pixel
 *     dimensions after rotation);
 *   - the **request variant** (long edge bounded, never upscaled), whose actual
 *     encoded dimensions are what the token policy counts.
 *
 * A failure here must leave nothing behind. This module writes no files at all;
 * the service writes the three blobs only after this returns, into a temporary
 * directory it renames atomically.
 */

import { createHash } from 'node:crypto';
import sharp from 'sharp';

/** Sharp's callable and metadata types without importing its namespace. */
type SharpImage = ReturnType<typeof sharp>;
type SharpMetadata = Awaited<ReturnType<SharpImage['metadata']>>;
import { MediaError } from './errors.ts';
import type { ImageMediaType, MediaLimits } from './types.ts';
import { MEDIA_PROCESSOR_VERSION, REQUEST_VARIANT_POLICY } from './limits.ts';

const FORMAT_TO_MEDIA_TYPE: Readonly<Record<string, ImageMediaType>> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/** What the raw bytes claim, independent of any filename or header. */
const MEDIA_TYPE_ALIASES: Readonly<Record<string, ImageMediaType>> = {
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/png': 'image/png',
  'image/webp': 'image/webp',
};

export interface DecodedImage {
  readonly mediaType: ImageMediaType;
  /** Oriented dimensions of the original. */
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
  readonly normalized: {
    readonly data: Buffer;
    readonly width: number;
    readonly height: number;
    readonly sha256: string;
  };
  readonly request: {
    readonly data: Buffer;
    readonly width: number;
    readonly height: number;
    readonly sha256: string;
  };
  readonly processorVersion: string;
  readonly policyRevision: string;
}

export interface DecodeOptions {
  readonly limits: MediaLimits;
  /** The client's declared type, if it made one. A mismatch is rejected. */
  readonly declaredMediaType?: string | null;
  /** Per-decode wall clock bound. Sharp cannot be cancelled, so the caller fails. */
  readonly timeoutMs?: number;
}

/**
 * Bound concurrent decodes.
 *
 * "At most two" is a product limit, and it has to be enforced around the whole
 * decode-and-encode pass — a semaphore around only the metadata read would let
 * five full rasters decode at once behind a cheap first step.
 */
export class DecodeGate {
  readonly #limit: number;
  #active = 0;
  readonly #waiting: (() => void)[] = [];
  #peak = 0;

  constructor(limit: number) {
    this.#limit = Math.max(1, limit);
  }

  /** High-water mark, exposed for the concurrency acceptance test. */
  get peak(): number {
    return this.#peak;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await work();
    } finally {
      this.#release();
    }
  }

  #acquire(): Promise<void> {
    if (this.#active < this.#limit) {
      this.#active += 1;
      this.#peak = Math.max(this.#peak, this.#active);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#waiting.push(() => {
        this.#active += 1;
        this.#peak = Math.max(this.#peak, this.#active);
        resolve();
      });
    });
  }

  #release(): void {
    this.#active -= 1;
    const next = this.#waiting.shift();
    if (next) next();
  }
}

/** A single process-wide gate, so the limit is a property of the process. */
export const PROCESS_DECODE_GATE = new DecodeGate(2);

export async function decodeImage(
  bytes: Uint8Array,
  options: DecodeOptions,
  gate: DecodeGate = PROCESS_DECODE_GATE,
): Promise<DecodedImage> {
  const { limits } = options;
  if (bytes.length === 0) {
    throw new MediaError('MEDIA_CORRUPT', '图片是空的', 415);
  }
  if (bytes.length > limits.maxImageBytes) {
    throw new MediaError('MEDIA_TOO_LARGE', `图片超过 ${limits.maxImageBytes} 字节上限`, 413, {
      details: { maxBytes: limits.maxImageBytes },
    });
  }

  return gate.run(async () => {
    const metadata = await readMetadata(bytes, limits);
    // Formats with a specific refusal reason are named before the generic
    // unsupported-format branch, so a GIF does not read as "unknown bytes".
    if (metadata.format === 'gif') {
      throw new MediaError('MEDIA_ANIMATED_UNSUPPORTED', '暂不支持 GIF 动图', 415);
    }
    if (metadata.format === 'svg') {
      throw new MediaError('MEDIA_UNSUPPORTED_FORMAT', '暂不支持 SVG', 415);
    }
    const detected = FORMAT_TO_MEDIA_TYPE[metadata.format ?? ''];
    if (!detected) {
      throw new MediaError(
        'MEDIA_UNSUPPORTED_FORMAT',
        '只支持 JPEG、PNG、WebP 的静态图片',
        415,
        { details: { format: metadata.format ?? 'unknown' } },
      );
    }

    const declared = normalizeDeclared(options.declaredMediaType);
    if (declared !== null && declared !== detected) {
      throw new MediaError(
        'MEDIA_MIME_MISMATCH',
        '声明的图片类型与实际内容不一致',
        415,
        { details: { declaredMediaType: declared, detectedMediaType: detected } },
      );
    }

    rejectAnimation(bytes, metadata);

    const orientation = metadata.orientation ?? 1;
    const swap = orientation >= 5 && orientation <= 8;
    const width = swap ? (metadata.height ?? 0) : (metadata.width ?? 0);
    const height = swap ? (metadata.width ?? 0) : (metadata.height ?? 0);
    if (width <= 0 || height <= 0) {
      throw new MediaError('MEDIA_CORRUPT', '读不出图片尺寸', 415);
    }
    if (width > limits.maxDimension || height > limits.maxDimension) {
      throw new MediaError(
        'MEDIA_DIMENSIONS_EXCEEDED',
        `图片单边不能超过 ${limits.maxDimension} 像素`,
        413,
        { details: { width, height, maxDimension: limits.maxDimension } },
      );
    }
    if (width * height > limits.maxPixels) {
      throw new MediaError(
        'MEDIA_PIXELS_EXCEEDED',
        `图片总像素不能超过 ${limits.maxPixels}`,
        413,
        { details: { width, height, maxPixels: limits.maxPixels } },
      );
    }

    const encoded = await encodeVariants(bytes, detected, limits);
    return {
      mediaType: detected,
      width: encoded.normalized.width,
      height: encoded.normalized.height,
      sha256: sha256(bytes),
      normalized: encoded.normalized,
      request: encoded.request,
      processorVersion: MEDIA_PROCESSOR_VERSION,
      policyRevision: REQUEST_VARIANT_POLICY,
    };
  });
}

function normalizeDeclared(value: string | null | undefined): ImageMediaType | null {
  if (!value) return null;
  const base = value.split(';')[0]?.trim().toLowerCase() ?? '';
  if (base.length === 0 || base === 'application/octet-stream') return null;
  return MEDIA_TYPE_ALIASES[base] ?? null;
}

async function readMetadata(
  bytes: Uint8Array,
  limits: MediaLimits,
): Promise<SharpMetadata> {
  try {
    return await withTimeout(
      sharp(bytes, {
        // The decoder refuses an oversized raster before allocating it. The
        // explicit arithmetic check afterwards reports a better message for
        // dimensions that are large but still under the guard.
        limitInputPixels: limits.maxPixels,
        animated: true,
        failOn: 'error',
      }).metadata(),
      10_000,
      '读取图片信息超时',
    );
  } catch (error) {
    if (error instanceof MediaError) throw error;
    // libvips enforces `limitInputPixels` before allocating the raster, so this
    // is the first signal an oversized image gives. Reporting it as "corrupt"
    // would send the person looking for a different file instead of a smaller
    // one.
    if (error instanceof Error && /pixel limit|exceeds.*pixels/i.test(error.message)) {
      throw new MediaError(
        'MEDIA_PIXELS_EXCEEDED',
        `图片总像素不能超过 ${limits.maxPixels}`,
        413,
        { details: { maxPixels: limits.maxPixels } },
      );
    }
    throw new MediaError('MEDIA_CORRUPT', '图片无法解码，可能已损坏', 415);
  }
}

/**
 * Reject every moving or multi-page image, including formats a browser might
 * still call a normal image.
 *
 * Metadata is not enough on its own for WebP/APNG: libvips reports pages for
 * some builds and not others, so the container marker is checked as well.
 */
function rejectAnimation(bytes: Uint8Array, metadata: SharpMetadata): void {
  const format = metadata.format;
  if (format === 'gif') {
    throw new MediaError('MEDIA_ANIMATED_UNSUPPORTED', '暂不支持 GIF 动图', 415);
  }
  if (format === 'svg') {
    throw new MediaError('MEDIA_UNSUPPORTED_FORMAT', '暂不支持 SVG', 415);
  }
  const pages = metadata.pages ?? 1;
  if (pages > 1 || metadata.pageHeight !== undefined) {
    throw new MediaError('MEDIA_ANIMATED_UNSUPPORTED', '暂不支持动态图或多页图片', 415);
  }
  if (format === 'webp' && hasAscii(bytes, 12, 'ANIM')) {
    throw new MediaError('MEDIA_ANIMATED_UNSUPPORTED', '暂不支持动态 WebP', 415);
  }
  if (format === 'png' && hasAscii(bytes, 8, 'acTL')) {
    throw new MediaError('MEDIA_ANIMATED_UNSUPPORTED', '暂不支持动态 PNG', 415);
  }
}

/**
 * Look for an ASCII marker in the first few KB of the container.
 *
 * Chunks live near the front, and scanning the whole file would make validation
 * O(size) for no extra certainty; a marker after the header is still found
 * because the window is deliberately larger than any realistic header.
 */
function hasAscii(bytes: Uint8Array, from: number, marker: string): boolean {
  const end = Math.min(bytes.length, 64 * 1024);
  const needle = [...marker].map((char) => char.charCodeAt(0));
  for (let index = Math.max(0, from); index <= end - needle.length; index += 1) {
    let match = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (bytes[index + offset] !== needle[offset]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

function encodeOptions(format: ImageMediaType) {
  if (format === 'image/jpeg') return { quality: 88, mozjpeg: true };
  if (format === 'image/webp') return { quality: 88, effort: 4 };
  return { compressionLevel: 9, adaptiveFiltering: true };
}

/** One explicit overload per format, so the option object stays type checked. */
function encodeToFormat(image: SharpImage, format: ImageMediaType): SharpImage {
  if (format === 'image/jpeg') return image.toFormat('jpeg', encodeOptions(format));
  if (format === 'image/webp') return image.toFormat('webp', encodeOptions(format));
  return image.toFormat('png', encodeOptions(format));
}

async function encodeVariants(
  bytes: Uint8Array,
  format: ImageMediaType,
  limits: MediaLimits,
): Promise<{
  normalized: { data: Buffer; width: number; height: number; sha256: string };
  request: { data: Buffer; width: number; height: number; sha256: string };
}> {
  try {
    const normalizedImage = encodeToFormat(
      // `rotate()` with no angle applies EXIF orientation. No `withMetadata()`
      // call follows, so EXIF (including GPS) and the ICC profile are not
      // carried into the derived image.
      sharp(bytes, { limitInputPixels: limits.maxPixels, failOn: 'error' }).rotate(),
      format,
    );
    const normalized = await withTimeout(
      normalizedImage.toBuffer({ resolveWithObject: true }),
      15_000,
      '处理图片超时',
    );

    const requestImage = encodeToFormat(
      sharp(normalized.data, { limitInputPixels: limits.maxPixels, failOn: 'error' }).resize({
        width: limits.requestLongEdge,
        height: limits.requestLongEdge,
        fit: 'inside',
        // A 100×100 image is sent at 100×100: enlarging it would change the
        // token count without adding a pixel of information.
        withoutEnlargement: true,
      }),
      format,
    );
    const request = await withTimeout(
      requestImage.toBuffer({ resolveWithObject: true }),
      15_000,
      '生成请求图片超时',
    );

    return {
      normalized: {
        data: normalized.data,
        width: normalized.info.width,
        height: normalized.info.height,
        sha256: sha256(normalized.data),
      },
      request: {
        data: request.data,
        width: request.info.width,
        height: request.info.height,
        sha256: sha256(request.data),
      },
    };
  } catch (error) {
    if (error instanceof MediaError) throw error;
    throw new MediaError('MEDIA_CORRUPT', '图片处理失败，可能已损坏', 415);
  }
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new MediaError('MEDIA_STORE_FAILED', message, 504, {
      retryable: true,
    })), ms);
    timer.unref();
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Exposed so a request planner can reuse the same projected size rule. */
export function requestVariantRevision(): string {
  return REQUEST_VARIANT_POLICY;
}
