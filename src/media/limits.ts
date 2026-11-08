/**
 * Product media limits, loaded once at process start.
 *
 * The server publishes these numbers through `/api/media/capabilities`, and the
 * client uses that response instead of keeping a second copy. A browser-side
 * `10 * 1024 * 1024` is how the two limits drift: the client checks one value,
 * the server enforces another, and the error message names neither.
 *
 * Every value is a product policy, not a model fact. A route may be stricter
 * still; the request planner takes the minimum of the two.
 */

import type { MediaLimits } from './types.ts';

export const DEFAULT_MEDIA_LIMITS: MediaLimits = {
  maxImagesPerMessage: 5,
  maxImageBytes: 10 * 1024 * 1024,
  maxMessageImageBytes: 20 * 1024 * 1024,
  maxDimension: 8_192,
  maxPixels: 40_000_000,
  maxConcurrentDecodes: 2,
  requestLongEdge: 2_048,
  maxRequestBodyBytes: 32 * 1024 * 1024,
  unboundGraceMs: 24 * 60 * 60 * 1000,
  leaseMs: 5 * 60 * 1000,
};

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function mediaLimits(env: NodeJS.ProcessEnv = process.env): MediaLimits {
  return {
    maxImagesPerMessage: integer(env, 'MEDIA_MAX_IMAGES_PER_MESSAGE', 5, 1, 20),
    maxImageBytes: integer(env, 'MEDIA_MAX_IMAGE_BYTES', 10 * 1024 * 1024, 1, 100 * 1024 * 1024),
    maxMessageImageBytes: integer(
      env,
      'MEDIA_MAX_MESSAGE_IMAGE_BYTES',
      20 * 1024 * 1024,
      1,
      200 * 1024 * 1024,
    ),
    maxDimension: integer(env, 'MEDIA_MAX_DIMENSION', 8_192, 1, 65_535),
    maxPixels: integer(env, 'MEDIA_MAX_PIXELS', 40_000_000, 1, 400_000_000),
    maxConcurrentDecodes: integer(env, 'MEDIA_MAX_CONCURRENT_DECODES', 2, 1, 16),
    requestLongEdge: integer(env, 'MEDIA_REQUEST_LONG_EDGE', 2_048, 64, 8_192),
    maxRequestBodyBytes: integer(
      env,
      'MEDIA_MAX_REQUEST_BODY_BYTES',
      32 * 1024 * 1024,
      1,
      256 * 1024 * 1024,
    ),
    unboundGraceMs: integer(
      env,
      'MEDIA_UNBOUND_GRACE_MS',
      24 * 60 * 60 * 1000,
      60_000,
      30 * 24 * 60 * 60 * 1000,
    ),
    leaseMs: integer(env, 'MEDIA_LEASE_MS', 5 * 60 * 1000, 30_000, 60 * 60 * 1000),
  };
}

/** Revision of the request-variant policy. A variant key includes it. */
export const REQUEST_VARIANT_POLICY = 'request-variant/1';

/** Revision of the decode/normalise pipeline. A variant key includes it. */
export const MEDIA_PROCESSOR_VERSION = 'sharp-0.35.5/exif-orient/1';
