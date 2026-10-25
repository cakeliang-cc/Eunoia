/**
 * The model catalog.
 *
 * Adding a provider-backed model is a new entry here plus a provider adapter;
 * nothing in the session layer changes. Context numbers are capability facts,
 * not preferences: the product's budget lives in `defaultInputBudgetTokens`.
 */

import { MODEL_IDS } from '../config.ts';
import type { ModelProfile } from './types.ts';

const DEEPSEEK_CONTEXT = 1_048_576;
const DEEPSEEK_MAX_OUTPUT = 8_192;
const DEEPSEEK_SAFETY = 1_024;

export const MODEL_CATALOG: Readonly<Record<string, ModelProfile>> = {
  [MODEL_IDS.companion]: {
    id: MODEL_IDS.companion,
    providerId: 'deepseek',
    contextWindowTokens: DEEPSEEK_CONTEXT,
    maxOutputTokens: DEEPSEEK_MAX_OUTPUT,
    safetyBufferTokens: DEEPSEEK_SAFETY,
    // The agreed product default: 200k even though the model can take ~1M.
    defaultInputBudgetTokens: 200_000,
    tokenEstimator: 'mixed',
    supportsTools: true,
    supportsStreaming: true,
  },
  [MODEL_IDS.fast]: {
    id: MODEL_IDS.fast,
    providerId: 'deepseek',
    contextWindowTokens: DEEPSEEK_CONTEXT,
    maxOutputTokens: DEEPSEEK_MAX_OUTPUT,
    safetyBufferTokens: DEEPSEEK_SAFETY,
    defaultInputBudgetTokens: 200_000,
    tokenEstimator: 'mixed',
    supportsTools: true,
    supportsStreaming: true,
  },
};

export const DEFAULT_COMPANION_MODEL_ID = MODEL_IDS.companion;
export const DEFAULT_SUMMARY_MODEL_ID = MODEL_IDS.fast;
