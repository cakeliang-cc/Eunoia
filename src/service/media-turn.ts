/**
 * The service-level join between stored media and the pure request planner.
 *
 * The planner never touches a filesystem or a database. This module supplies it
 * with owner-scoped metadata, then — only after the plan passes every check —
 * loads the exact request-variant bytes and takes a lease on them. A preflight
 * can therefore answer a 422 before admission without reading pixels or leaving a
 * lease behind, and the turn itself never sends bytes the plan did not count.
 */

import type { UserContentV1 } from '../agent/content.ts';
import { contentImageIds } from '../agent/content.ts';
import type { PreparedImage, PreparedMediaPlan } from '../agent/request-plan.ts';
import { mediaOccurrences, planMediaRequest, withImageData } from '../agent/request-plan.ts';
import type { ImageAsset, MediaLimits } from '../media/types.ts';
import type { MediaService } from '../media/service.ts';
import { MediaError } from '../media/errors.ts';
import type { ImagePolicyRegistry } from '../provider/image-policy.ts';
import type { ModelProfile } from '../models/types.ts';

export interface MediaTurnDeps {
  readonly media: MediaService | null;
  readonly policies: ImagePolicyRegistry;
  readonly limits: MediaLimits;
  readonly inputBudgetTokens?: number | null;
  readonly availableModels?: readonly string[];
}

export interface PreflightInput {
  readonly userId: string;
  readonly conversationId: string;
  readonly profile: ModelProfile;
  readonly content: UserContentV1;
  /** User contents of the replay window, oldest first, excluding the current one. */
  readonly history: readonly UserContentV1[];
  readonly requiresTools?: boolean;
  readonly fixedTokens?: number;
  readonly fixedBodyBytes?: number;
}

export interface PreflightResult {
  readonly plan: PreparedMediaPlan;
  /** Unique metadata rows, for callers that need digests for the request hash. */
  readonly assets: readonly ImageAsset[];
}

/**
 * Resolve metadata and plan, throwing a typed error on any incompatibility.
 *
 * No bytes are read: the only facts needed are the route's limits and the
 * request variant's dimensions and byte count, all of which the asset row
 * already records.
 */
export async function preflightMedia(
  deps: MediaTurnDeps,
  input: PreflightInput,
): Promise<PreflightResult> {
  const occurrences = mediaOccurrences(input.content, input.history);
  if (occurrences.length === 0) {
    // Still produce a plan: it carries the text estimate and the route revision
    // the turn records, and it keeps one code path for text and image turns.
    const result = planMediaRequest({
      profile: input.profile,
      policy: null,
      current: input.content,
      history: input.history,
      assets: [],
      limits: deps.limits,
      ...(deps.inputBudgetTokens !== null && deps.inputBudgetTokens !== undefined
        ? { inputBudgetTokens: deps.inputBudgetTokens }
        : {}),
      ...(input.fixedTokens !== undefined ? { fixedTokens: input.fixedTokens } : {}),
      ...(input.fixedBodyBytes !== undefined ? { fixedBodyBytes: input.fixedBodyBytes } : {}),
      ...(input.requiresTools !== undefined ? { requiresTools: input.requiresTools } : {}),
      ...(deps.availableModels ? { availableModels: deps.availableModels } : {}),
    });
    if (!result.ok) throw result.error;
    return { plan: result.plan, assets: [] };
  }

  if (!deps.media) {
    throw new MediaError('MEDIA_UNAVAILABLE', '这个进程没有配置图片存储，不能接收图片。', 422);
  }

  const ids = [...new Set(occurrences.map((occurrence) => occurrence.assetId))];
  const assets = await deps.media.resolve(input.userId, input.conversationId, ids);

  // Product limits are about the current message, not the whole replay window.
  // Duplicates count as separate image blocks; the same asset sent twice is two
  // visual inputs and also two uploads' worth of bytes by policy.
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const currentAssets: ImageAsset[] = [];
  for (const id of contentImageIds(input.content)) {
    const asset = byId.get(id);
    if (asset) currentAssets.push(asset);
  }
  deps.media.assertMessageImages(currentAssets);

  const result = planMediaRequest({
    profile: input.profile,
    policy: deps.policies.forRoute(input.profile.capabilities),
    current: input.content,
    history: input.history,
    assets,
    limits: deps.limits,
    ...(deps.inputBudgetTokens !== null && deps.inputBudgetTokens !== undefined
      ? { inputBudgetTokens: deps.inputBudgetTokens }
      : {}),
    ...(input.fixedTokens !== undefined ? { fixedTokens: input.fixedTokens } : {}),
    ...(input.fixedBodyBytes !== undefined ? { fixedBodyBytes: input.fixedBodyBytes } : {}),
    ...(input.requiresTools !== undefined ? { requiresTools: input.requiresTools } : {}),
    ...(deps.availableModels ? { availableModels: deps.availableModels } : {}),
  });
  if (!result.ok) throw result.error;
  return { plan: result.plan, assets };
}

export interface LoadedMediaPlan {
  readonly plan: PreparedMediaPlan;
  /** Release the lease; safe to call more than once. */
  readonly release: () => Promise<void>;
}

/**
 * Load the planned request variants and lease them for the turn.
 *
 * The returned plan is the one the adapter must use. If a file is missing, the
 * load fails before the model is called, and the turn reports a resource error
 * rather than silently dropping the image.
 */
export async function loadMediaPlan(
  deps: Pick<MediaTurnDeps, 'media'>,
  userId: string,
  plan: PreparedMediaPlan,
): Promise<LoadedMediaPlan> {
  const ids = [...plan.images.keys()];
  if (ids.length === 0) return { plan, release: async () => {} };
  if (!deps.media) {
    throw new MediaError('MEDIA_UNAVAILABLE', '这个进程没有配置图片存储。', 422);
  }
  const loaded = await deps.media.loadPlanImages(
    userId,
    [...plan.images.values()].map((image) => image.assetId),
  );
  const data = new Map(loaded.map((entry) => [entry.assetId, entry.bytes]));
  return {
    plan: withImageData(plan, data),
    release: () => deps.media!.releaseLease(userId, ids),
  };
}

/** Convenience for tests: the ordered image list of a plan. */
export function plannedImages(plan: PreparedMediaPlan): PreparedImage[] {
  return [...plan.images.values()];
}
