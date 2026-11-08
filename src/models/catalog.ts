/**
 * The model catalog.
 *
 * Adding a provider-backed model is a new entry here plus a provider adapter;
 * nothing in the session layer changes. Context numbers are capability facts,
 * not preferences: the product's budget lives in `defaultInputBudgetTokens`.
 *
 * The two DeepSeek entries deliberately disagree about image input. This is not
 * an oversight: the vision guide documents image support for `deepseek-flash`,
 * and the text tier has not been verified for it. Claiming the whole vendor is
 * visual because one endpoint is would be exactly the inference the design
 * forbids. A person who wants to send an image selects the flash route; the UI
 * reads that from `/api/media/capabilities`, never from the model name.
 */

import { MODEL_IDS } from '../config.ts';
import type { ModelProfile, RouteCapabilities } from './types.ts';

const DEEPSEEK_CONTEXT = 1_048_576;
const DEEPSEEK_MAX_OUTPUT = 8_192;
const DEEPSEEK_SAFETY = 1_024;

/**
 * The policy revision is fixed to the sources this build was implemented
 * against. A provider rule change updates the policy module, its revision and
 * its test vectors — never the stored message structure.
 */
const DEEPSEEK_VISION_REVISION = 'deepseek-flash-v41@2026-11-08';

const TEXT_ONLY: RouteCapabilities = {
  input: { text: 'supported', image: 'unsupported' },
  output: { text: 'supported' },
  tools: 'supported',
  policyRevision: 'deepseek-text@2026-11-08',
};

const DEEPSEEK_FLASH_VISION: RouteCapabilities = {
  input: { text: 'supported', image: 'supported' },
  output: { text: 'supported' },
  tools: 'supported',
  imagePolicyId: 'deepseek-flash-v41',
  policyRevision: DEEPSEEK_VISION_REVISION,
  image: {
    mediaTypes: ['image/jpeg', 'image/png', 'image/webp'],
    // The route is not documented with a per-request count; this is the
    // product's stricter ceiling, raised to cover a replay window of several
    // messages while still bounding one request.
    maxCount: 20,
    maxBytesPerImage: 10 * 1024 * 1024,
    maxPixels: 40_000_000,
    detail: 'auto',
  },
};

export const MODEL_CATALOG: Readonly<Record<string, ModelProfile>> = {
  [MODEL_IDS.companion]: {
    id: MODEL_IDS.companion,
    providerId: 'deepseek',
    displayName: 'DeepSeek V4 Pro',
    contextWindowTokens: DEEPSEEK_CONTEXT,
    maxOutputTokens: DEEPSEEK_MAX_OUTPUT,
    safetyBufferTokens: DEEPSEEK_SAFETY,
    // The agreed product default: 200k even though the model can take ~1M.
    defaultInputBudgetTokens: 200_000,
    tokenEstimator: 'mixed',
    supportsTools: true,
    supportsStreaming: true,
    capabilities: TEXT_ONLY,
  },
  [MODEL_IDS.fast]: {
    id: MODEL_IDS.fast,
    providerId: 'deepseek',
    displayName: 'DeepSeek Flash（可看图）',
    contextWindowTokens: DEEPSEEK_CONTEXT,
    maxOutputTokens: DEEPSEEK_MAX_OUTPUT,
    safetyBufferTokens: DEEPSEEK_SAFETY,
    defaultInputBudgetTokens: 200_000,
    tokenEstimator: 'mixed',
    supportsTools: true,
    supportsStreaming: true,
    capabilities: DEEPSEEK_FLASH_VISION,
  },
};

export const DEFAULT_COMPANION_MODEL_ID = MODEL_IDS.companion;
export const DEFAULT_SUMMARY_MODEL_ID = MODEL_IDS.fast;
