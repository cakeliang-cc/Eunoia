/**
 * An offline second route, for the replaceability acceptance test.
 *
 * The point of this provider is not to be a second paid service. It is to prove
 * that one canonical message can be planned and encoded by a different adapter
 * with a different image-token formula, different route limits, a different wire
 * field name and a different detail setting — without the generic planner, the
 * session store or the frontend changing.
 *
 * It deliberately fails if it is handed an image block with no planned bytes:
 * that is the same rule the real adapter follows, and a fake that fabricated a
 * filename in that case would make the acceptance test meaningless.
 *
 * It is not listed by `/api/models`. Tests construct its profile explicitly;
 * production has no way to select it.
 */

import sharp from 'sharp';
import type {
  LoopInputItem,
  ModelTurn,
  ModelTurnEvent,
  ModelTurnRequest,
} from '../agent/model-port.ts';
import type { PreparedImage, PreparedMediaPlan } from '../agent/request-plan.ts';
import type { ImageTokenPolicy } from './image-policy.ts';
import type { ModelProfile } from '../models/types.ts';

export const FAKE_VISION_MODEL_ID = 'fake-vision-offline';
export const FAKE_IMAGE_POLICY_ID = 'fake-tile-v1';
const FAKE_POLICY_REVISION = 'fake-tile-v1@2026-11-08';

/**
 * A formula that is intentionally unlike DeepSeek's: ~4 tiles per 64×64 block
 * plus a fixed header, with a separate documented bound. If the generic planner
 * produced the same count for both routes, it would still be using a vendor
 * branch somewhere.
 */
export const FAKE_IMAGE_POLICY: ImageTokenPolicy = {
  id: FAKE_IMAGE_POLICY_ID,
  revision: FAKE_POLICY_REVISION,
  estimate(input) {
    const tiles = Math.ceil((input.width * input.height) / 4096);
    return {
      estimatedTokens: tiles + 48,
      upperBoundTokens: tiles + 48 + 64,
      basis: 'documented-bound',
      policyRevision: FAKE_POLICY_REVISION,
    };
  },
};

export function fakeVisionProfile(): ModelProfile {
  return {
    id: FAKE_VISION_MODEL_ID,
    providerId: 'fake',
    displayName: 'Offline Vision Double',
    contextWindowTokens: 12_000,
    maxOutputTokens: 512,
    safetyBufferTokens: 128,
    defaultInputBudgetTokens: 8_000,
    tokenEstimator: 'chars4',
    supportsTools: true,
    supportsStreaming: true,
    capabilities: {
      input: { text: 'supported', image: 'supported' },
      output: { text: 'supported' },
      tools: 'supported',
      imagePolicyId: FAKE_IMAGE_POLICY_ID,
      policyRevision: FAKE_POLICY_REVISION,
      image: {
        mediaTypes: ['image/jpeg', 'image/png', 'image/webp'],
        // Stricter than the product: a route limit is combined by taking the
        // minimum, so this proves the stricter one wins.
        maxCount: 3,
        maxBytesPerImage: 5 * 1024 * 1024,
        maxPixels: 7_000_000,
        detail: 'low',
      },
    },
  };
}

/** The wire this fake speaks. Different field names on purpose. */
export interface FakeWireImage {
  readonly kind: 'fake_image_tile';
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly digest: string;
  readonly detail: string;
  /** Base64, like a real inline protocol, but under a different field name. */
  readonly tile: string;
  /** Decoded by the double, so a test cannot pass with a filename or a URL. */
  readonly decodedWidth: number;
  readonly decodedHeight: number;
}

export interface FakeWireRequest {
  readonly protocol: 'fake-tiles/1';
  readonly modelId: string;
  readonly text: string[];
  readonly tiles: FakeWireImage[];
  readonly toolNames: string[];
}

export interface FakeVisionCapture {
  readonly requests: FakeWireRequest[];
  readonly calls: number;
}

export function createFakeVisionCapture(): FakeVisionCapture {
  return {
    requests: [],
    get calls() {
      return this.requests.length;
    },
  };
}

export interface FakeVisionTurnOptions {
  readonly capture?: FakeVisionCapture;
  /** Override the reply; receives the decoded wire. */
  readonly reply?: (wire: FakeWireRequest) => string;
}

export function createFakeVisionTurn(options: FakeVisionTurnOptions = {}): ModelTurn {
  return async function* fakeVisionTurn(
    request: ModelTurnRequest,
  ): AsyncIterable<ModelTurnEvent> {
    if (request.signal?.aborted) throw aborted();
    const wire = await encodeFakeRequest(request);
    if (request.signal?.aborted) throw aborted();
    options.capture?.requests.push(wire);

    const text =
      options.reply?.(wire) ??
      (wire.tiles.length === 0
        ? 'fake-ok images=0'
        : `fake-ok images=${wire.tiles.length} order=` +
          wire.tiles
            .map((tile) => `${tile.decodedWidth}x${tile.decodedHeight}:${tile.digest.slice(0, 8)}`)
            .join(','));

    yield { type: 'text_delta', text };
    yield {
      type: 'done',
      output: [{ type: 'message', role: 'assistant', content: text }],
      usage: {
        inputTokens: wire.tiles.reduce((sum, tile) => sum + tile.decodedWidth, 0),
        outputTokens: 8,
        totalTokens: wire.tiles.reduce((sum, tile) => sum + tile.decodedWidth, 0) + 8,
        cachedTokens: 0,
      },
      responseId: 'fake-response',
    };
  };
}

async function encodeFakeRequest(request: ModelTurnRequest): Promise<FakeWireRequest> {
  const text: string[] = [];
  const tiles: FakeWireImage[] = [];

  for (const item of request.input) {
    if (item.type !== 'message' || typeof item.content === 'string') continue;
    for (const part of item.content) {
      if (part.type === 'text') {
        text.push(part.text);
        continue;
      }
      const image = request.media?.images.get(part.assetId);
      if (!image?.data) throw new Error(`fake route received no planned bytes for ${part.assetId}`);
      tiles.push(await toWireImage(image));
    }
  }

  return {
    protocol: 'fake-tiles/1',
    modelId: request.media?.modelId ?? FAKE_VISION_MODEL_ID,
    text,
    tiles,
    toolNames: request.tools.map((tool) => tool.name),
  };
}

async function toWireImage(image: PreparedImage): Promise<FakeWireImage> {
  const bytes = Buffer.from(image.data ?? new Uint8Array());
  // A real protocol would decode the tile. Doing it here turns "the adapter
  // passed a string" into "the target could read pixels", which is the claim the
  // acceptance test needs.
  const metadata = await sharp(bytes).metadata();
  return {
    kind: 'fake_image_tile',
    mime: image.mediaType,
    width: image.variantWidth,
    height: image.variantHeight,
    byteLength: bytes.length,
    digest: image.variantSha256,
    detail: image.detail,
    tile: bytes.toString('base64'),
    decodedWidth: metadata.width ?? 0,
    decodedHeight: metadata.height ?? 0,
  };
}

function aborted(): Error {
  const error = new Error('cancelled');
  error.name = 'AbortError';
  return error;
}

/** The plan's image count, for a test that only wants the wiring checked. */
export function plannedImageCount(plan: PreparedMediaPlan): number {
  return [...plan.images.values()].filter((image) => image.data !== undefined).length;
}

/** Re-exported so a test does not need to know the internal item shape. */
export type FakeInputItem = LoopInputItem;
