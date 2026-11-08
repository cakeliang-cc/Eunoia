/**
 * Plan a request's media before a single byte reaches a provider.
 *
 * This module is pure: it receives the route's declared capability, the token
 * policy the route names, the ordered content of the current message and the
 * replay window, and metadata for every referenced asset. It performs no I/O, so
 * its decisions are exactly what a unit test can pin — and so it cannot
 * accidentally read a different image than the one it counted.
 *
 * The three numbers stay separate, which is the point of the budget document:
 *
 *   - **storage bytes** are the asset's raw size, used only for product limits;
 *   - **request body bytes** are derived from the encoded request variant plus
 *     Base64's 4/3 expansion and the text/protocol overhead;
 *   - **input tokens** use the route's image policy on the *request variant's*
 *     actual dimensions, plus the text estimate.
 *
 * An unsupported route and an unconfigured route are different answers. So are
 * "the point estimate already exceeds the window" and "the point estimate fits
 * but the documented protection bound does not" — the latter is uncertainty, and
 * the client is allowed to choose a smaller request rather than being told a
 * false certainty.
 */

import type { UserContentV1 } from './content.ts';
import { contentText } from './content.ts';
import type { ImageAsset, MediaLimits } from '../media/types.ts';
import type { ModelProfile } from '../models/types.ts';
import type { ImageCostEstimate, ImageTokenPolicy } from '../provider/image-policy.ts';
import type { ImageCostBasis } from '../provider/image-policy-types.ts';
import { estimateTokens, type TokenEstimatorMode } from '../session/tokens.ts';

export type MediaPlanErrorCode =
  | 'MODEL_INPUT_UNSUPPORTED'
  | 'MODEL_CAPABILITY_UNKNOWN'
  | 'MODEL_TOOLS_UNSUPPORTED'
  | 'IMAGE_COUNT_EXCEEDED'
  | 'IMAGE_BYTES_EXCEEDED'
  | 'MEDIA_TYPE_UNSUPPORTED'
  | 'CONTEXT_BUDGET_EXCEEDED'
  | 'CONTEXT_BUDGET_UNCERTAIN'
  | 'REQUEST_BODY_TOO_LARGE';

export type MediaScope = 'current' | 'history';

export interface MediaPlanErrorDetails {
  readonly modality?: 'image' | 'tools' | 'output';
  readonly scope?: MediaScope;
  readonly blockIndex?: number;
  readonly modelId?: string;
  readonly policyRevision?: string;
  readonly estimatedTokens?: number;
  readonly upperBoundTokens?: number;
  readonly inputLimit?: number;
  readonly requestBodyBytes?: number;
  readonly maxRequestBodyBytes?: number;
  readonly maxCount?: number;
  readonly count?: number;
  readonly availableModels?: readonly string[];
  readonly reason?: string;
}

export class MediaPlanError extends Error {
  readonly code: MediaPlanErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details: MediaPlanErrorDetails;

  constructor(
    code: MediaPlanErrorCode,
    message: string,
    status: number,
    details: MediaPlanErrorDetails = {},
    retryable = false,
  ) {
    super(message);
    this.name = 'MediaPlanError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.details = details;
  }
}

export function isMediaPlanError(error: unknown): error is MediaPlanError {
  return error instanceof MediaPlanError;
}

export interface PreparedImage {
  readonly assetId: string;
  readonly name: string;
  readonly mediaType: ImageAsset['mediaType'];
  /** Dimensions of the original after EXIF orientation. */
  readonly width: number;
  readonly height: number;
  /** Dimensions of the request variant — what the provider receives. */
  readonly variantWidth: number;
  readonly variantHeight: number;
  readonly variantBytes: number;
  readonly sourceSha256: string;
  readonly variantSha256: string;
  readonly detail: string;
  readonly estimatedTokens: number;
  readonly upperBoundTokens: number;
  readonly basis: ImageCostBasis;
  readonly policyRevision: string;
  /**
   * The exact encoded bytes the adapter sends. Absent on a metadata-only
   * preflight; a model adapter refuses a plan without them rather than sending a
   * placeholder.
   */
  readonly data?: Uint8Array;
}

export interface PreparedMediaPlan {
  readonly modelId: string;
  readonly providerId: string;
  readonly policyRevision: string;
  readonly imagePolicyId: string | null;
  /** Unique images by id. Occurrences are counted separately below. */
  readonly images: ReadonlyMap<string, PreparedImage>;
  /** How many times an image appears in the whole request. */
  readonly occurrences: number;
  readonly imageTokens: number;
  readonly upperBoundImageTokens: number;
  readonly textTokens: number;
  readonly estimatedInputTokens: number;
  readonly upperBoundInputTokens: number;
  readonly inputLimit: number;
  readonly requestBodyBytes: number;
  readonly basis: ImageCostBasis | null;
}

export interface MediaOccurrence {
  readonly assetId: string;
  readonly scope: MediaScope;
  readonly blockIndex: number;
}

export interface PlanMediaInput {
  readonly profile: ModelProfile;
  readonly policy: ImageTokenPolicy | null;
  readonly current: UserContentV1;
  readonly history: readonly UserContentV1[];
  /** Metadata for every id referenced by `current` or `history`. */
  readonly assets: readonly ImageAsset[];
  readonly limits: MediaLimits;
  /** Product full-input budget; falls back to the profile's default. */
  readonly inputBudgetTokens?: number;
  /** System prompt + tool schema estimate, which are never dropped. */
  readonly fixedTokens?: number;
  /** Tool schema/JSON overhead in the body estimate. */
  readonly fixedBodyBytes?: number;
  /** Whether this turn will carry tools; cannot be silently dropped for images. */
  readonly requiresTools?: boolean;
  readonly availableModels?: readonly string[];
}

export type PlanMediaResult =
  | { readonly ok: true; readonly plan: PreparedMediaPlan }
  | { readonly ok: false; readonly error: MediaPlanError };

/** Every image occurrence, in request order (history first, then current). */
export function mediaOccurrences(
  current: UserContentV1,
  history: readonly UserContentV1[],
): MediaOccurrence[] {
  const occurrences: MediaOccurrence[] = [];
  for (const content of history) {
    for (const [blockIndex, part] of content.parts.entries()) {
      if (part.type === 'image') {
        occurrences.push({ assetId: part.assetId, scope: 'history', blockIndex });
      }
    }
  }
  for (const [blockIndex, part] of current.parts.entries()) {
    if (part.type === 'image') {
      occurrences.push({ assetId: part.assetId, scope: 'current', blockIndex });
    }
  }
  return occurrences;
}

export function planMediaRequest(input: PlanMediaInput): PlanMediaResult {
  const { profile, limits } = input;
  const capabilities = profile.capabilities;
  const occurrences = mediaOccurrences(input.current, input.history);
  const byId = new Map(input.assets.map((asset) => [asset.id, asset]));
  const mode: TokenEstimatorMode = profile.tokenEstimator;

  const currentImages = input.current.parts.filter((part) => part.type === 'image').length;
  if (currentImages > limits.maxImagesPerMessage) {
    return fail(
      new MediaPlanError(
        'IMAGE_COUNT_EXCEEDED',
        `一次最多发送 ${limits.maxImagesPerMessage} 张图片`,
        422,
        { maxCount: limits.maxImagesPerMessage, count: currentImages },
      ),
    );
  }

  let policy: ImageTokenPolicy | null = null;
  if (occurrences.length > 0) {
    const imageSupport = capabilities.input.image;
    if (imageSupport === 'unsupported') {
      const first = occurrences[0] as MediaOccurrence;
      return fail(
        new MediaPlanError(
          'MODEL_INPUT_UNSUPPORTED',
          first.scope === 'current'
            ? '当前模型不支持图片输入，请换一个能看图的模型，或移除图片。'
            : '历史消息里有图片，但当前模型不能看图；可以切换到能看图的模型，或新建纯文字对话。',
          422,
          {
            modality: 'image',
            scope: first.scope,
            blockIndex: first.blockIndex,
            modelId: profile.id,
            policyRevision: capabilities.policyRevision,
            ...(input.availableModels ? { availableModels: input.availableModels } : {}),
          },
        ),
      );
    }
    if (imageSupport === 'unknown') {
      const first = occurrences[0] as MediaOccurrence;
      return fail(
        new MediaPlanError(
          'MODEL_CAPABILITY_UNKNOWN',
          '这个模型的图片能力还没有配置，不能把图片当作已确认支持。',
          422,
          {
            modality: 'image',
            scope: first.scope,
            blockIndex: first.blockIndex,
            modelId: profile.id,
            policyRevision: capabilities.policyRevision,
            reason: 'image support is unknown',
          },
        ),
      );
    }
    if (capabilities.output.text !== 'supported') {
      return fail(
        new MediaPlanError(
          'MODEL_CAPABILITY_UNKNOWN',
          '这个模型没有可用的文本输出策略。',
          422,
          { modality: 'output', modelId: profile.id },
        ),
      );
    }
    if (input.requiresTools === true && capabilities.tools !== 'supported') {
      return fail(
        new MediaPlanError(
          'MODEL_TOOLS_UNSUPPORTED',
          '这一轮需要工具，但当前路由不能同时承载工具和图片；不会为了放行图片而丢掉工具。',
          422,
          { modality: 'tools', modelId: profile.id },
        ),
      );
    }
    if (!capabilities.image || !capabilities.imagePolicyId || input.policy === null) {
      return fail(
        new MediaPlanError(
          'MODEL_CAPABILITY_UNKNOWN',
          '这个模型声明了能看图，但没有可用的图片计数策略，不能按 0 Token 放行。',
          422,
          {
            modality: 'image',
            modelId: profile.id,
            policyRevision: capabilities.policyRevision,
            reason: input.policy === null ? 'image token policy is not registered' : 'image limits are not configured',
          },
        ),
      );
    }
    policy = input.policy;
    if (occurrences.length > capabilities.image.maxCount) {
      return fail(
        new MediaPlanError(
          'IMAGE_COUNT_EXCEEDED',
          `当前路由一次最多承载 ${capabilities.image.maxCount} 张图片`,
          422,
          { maxCount: capabilities.image.maxCount, count: occurrences.length },
        ),
      );
    }
  }

  const images = new Map<string, PreparedImage>();
  let imageTokens = 0;
  let upperBoundImageTokens = 0;
  let bodyImageBytes = 0;
  let basis: ImageCostBasis | null = null;

  for (const occurrence of occurrences) {
    const asset = byId.get(occurrence.assetId);
    if (!asset) {
      // The caller resolved ownership before planning; a missing asset here is a
      // programming error, not a user error, and must not become a text-only
      // request.
      return fail(
        new MediaPlanError(
          'MODEL_CAPABILITY_UNKNOWN',
          '请求计划缺少图片资源，不能当作纯文本继续。',
          422,
          {
            modality: 'image',
            scope: occurrence.scope,
            blockIndex: occurrence.blockIndex,
            modelId: profile.id,
            reason: 'asset metadata missing from plan',
          },
        ),
      );
    }

    const routeImage = capabilities.image;
    if (!routeImage) {
      return fail(
        new MediaPlanError('MODEL_CAPABILITY_UNKNOWN', '路由没有图片限制声明。', 422, {
          modality: 'image',
          modelId: profile.id,
        }),
      );
    }
    if (!routeImage.mediaTypes.includes(asset.mediaType)) {
      return fail(
        new MediaPlanError(
          'MEDIA_TYPE_UNSUPPORTED',
          `当前路由不接受 ${asset.mediaType}`,
          422,
          {
            modality: 'image',
            scope: occurrence.scope,
            blockIndex: occurrence.blockIndex,
            modelId: profile.id,
            reason: 'route media type list',
          },
        ),
      );
    }
    if (asset.bytes > routeImage.maxBytesPerImage) {
      return fail(
        new MediaPlanError(
          'IMAGE_BYTES_EXCEEDED',
          '这张图片超过当前路由的单图大小上限。',
          413,
          {
            modality: 'image',
            scope: occurrence.scope,
            blockIndex: occurrence.blockIndex,
            modelId: profile.id,
            reason: `image is ${asset.bytes} bytes, route allows ${routeImage.maxBytesPerImage}`,
          },
        ),
      );
    }

    let estimate = images.get(asset.id)?.estimatedTokens;
    let upper = images.get(asset.id)?.upperBoundTokens;
    if (estimate === undefined || upper === undefined) {
      const cost: ImageCostEstimate = policy!.estimate({
        width: asset.request.width,
        height: asset.request.height,
        detail: routeImage.detail,
        mediaType: asset.mediaType,
      });
      // A route that cannot bound its own image cost is not allowed to accept an
      // image: "unknown" must not quietly become the point estimate.
      if (cost.upperBoundTokens === undefined) {
        return fail(
          new MediaPlanError(
            'MODEL_CAPABILITY_UNKNOWN',
            '图片计数策略没有可用的保护上限，不能确认这次请求能放进上下文。',
            422,
            {
              modality: 'image',
              modelId: profile.id,
              policyRevision: cost.policyRevision,
              reason: 'image policy has no upper bound',
            },
          ),
        );
      }
      estimate = cost.estimatedTokens;
      upper = cost.upperBoundTokens;
      basis = cost.basis;
      images.set(asset.id, {
        assetId: asset.id,
        name: asset.name,
        mediaType: asset.mediaType,
        width: asset.width,
        height: asset.height,
        variantWidth: asset.request.width,
        variantHeight: asset.request.height,
        variantBytes: asset.request.bytes,
        sourceSha256: asset.sha256,
        variantSha256: asset.request.sha256,
        detail: routeImage.detail,
        estimatedTokens: estimate,
        upperBoundTokens: upper,
        basis: cost.basis,
        policyRevision: cost.policyRevision,
      });
    }

    // Every occurrence is a separate visual input. Storage deduplicates bytes;
    // the model context does not.
    imageTokens += estimate;
    upperBoundImageTokens += upper;
    // Base64's 4/3 expansion, the data-URL prefix/JSON field, and a per-image
    // envelope. The encoded body is checked again after encoding by the adapter.
    bodyImageBytes += 4 * Math.ceil(asset.request.bytes / 3) + 96;
  }

  const textTokens = estimateTextTokens(input.current, input.history, mode);
  const fixedTokens = Math.max(0, input.fixedTokens ?? 0);
  const estimatedInputTokens = fixedTokens + textTokens + imageTokens;
  const upperBoundInputTokens = fixedTokens + textTokens + upperBoundImageTokens;
  const inputLimit = effectiveInputLimit(profile, input.inputBudgetTokens);
  const bodyBytes =
    bodyImageBytes +
    Math.ceil(Buffer.byteLength(contentText(input.current), 'utf8')) +
    input.history.reduce((sum, content) => sum + Buffer.byteLength(contentText(content), 'utf8'), 0) +
    Math.max(0, input.fixedBodyBytes ?? 0);

  const plan: PreparedMediaPlan = {
    modelId: profile.id,
    providerId: profile.providerId,
    policyRevision: capabilities.policyRevision,
    imagePolicyId: capabilities.imagePolicyId ?? null,
    images,
    occurrences: occurrences.length,
    imageTokens,
    upperBoundImageTokens,
    textTokens,
    estimatedInputTokens,
    upperBoundInputTokens,
    inputLimit,
    requestBodyBytes: bodyBytes,
    basis,
  };

  if (bodyBytes > limits.maxRequestBodyBytes) {
    return fail(
      new MediaPlanError(
        'REQUEST_BODY_TOO_LARGE',
        '图片编码后的请求体超过上限，请减少图片数量或换更小的图片。',
        413,
        { requestBodyBytes: bodyBytes, maxRequestBodyBytes: limits.maxRequestBodyBytes },
      ),
    );
  }

  if (estimatedInputTokens > inputLimit) {
    return fail(
      new MediaPlanError(
        'CONTEXT_BUDGET_EXCEEDED',
        '按当前图片和文本估算，这次请求已经超过输入预算。',
        422,
        {
          estimatedTokens: estimatedInputTokens,
          upperBoundTokens: upperBoundInputTokens,
          inputLimit,
          modelId: profile.id,
          policyRevision: capabilities.policyRevision,
        },
      ),
    );
  }
  if (upperBoundInputTokens > inputLimit) {
    return fail(
      new MediaPlanError(
        'CONTEXT_BUDGET_UNCERTAIN',
        '点估算能放下，但保守保护值超过预算；可以少发一些历史、换较小图片或新建对话。',
        422,
        {
          estimatedTokens: estimatedInputTokens,
          upperBoundTokens: upperBoundInputTokens,
          inputLimit,
          modelId: profile.id,
          policyRevision: capabilities.policyRevision,
        },
      ),
    );
  }

  return { ok: true, plan };
}

/** The full input ceiling: product budget capped by the model's own window. */
export function effectiveInputLimit(profile: ModelProfile, override?: number): number {
  const contextCap =
    profile.contextWindowTokens - profile.maxOutputTokens - profile.safetyBufferTokens;
  const product = override ?? profile.defaultInputBudgetTokens;
  return Math.max(1_024, Math.min(product, contextCap));
}

/** Attach the encoded request bytes to a plan that was preflighted without them. */
export function withImageData(
  plan: PreparedMediaPlan,
  data: ReadonlyMap<string, Uint8Array>,
): PreparedMediaPlan {
  const images = new Map<string, PreparedImage>();
  for (const [id, image] of plan.images) {
    const bytes = data.get(id);
    images.set(id, bytes ? { ...image, data: bytes } : image);
  }
  return { ...plan, images };
}

export function imageOccurrenceCount(
  current: UserContentV1,
  history: readonly UserContentV1[],
): number {
  return mediaOccurrences(current, history).length;
}

function estimateTextTokens(
  current: UserContentV1,
  history: readonly UserContentV1[],
  mode: TokenEstimatorMode,
): number {
  // Role framing per message, then the text itself. Images are added by their
  // policy above and are never passed through the text estimator.
  let total = 0;
  for (const content of [...history, current]) total += estimateTokens(contentText(content), mode) + 4;
  return total;
}

function fail(error: MediaPlanError): PlanMediaResult {
  return { ok: false, error };
}
