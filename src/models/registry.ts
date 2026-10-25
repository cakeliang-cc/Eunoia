/**
 * Model-id resolution.
 *
 * One place turns an id from a conversation, an environment variable, or a
 * summary config into a profile. An unknown id is a startup error, not a silent
 * fallback: a typo that quietly runs a different model is the same class of bug
 * the model-id guard already exists to prevent.
 */

import {
  DEFAULT_COMPANION_MODEL_ID,
  DEFAULT_SUMMARY_MODEL_ID,
  MODEL_CATALOG,
} from './catalog.ts';
import type { ModelProfile } from './types.ts';

export function isKnownModelId(id: string): boolean {
  return Object.hasOwn(MODEL_CATALOG, id);
}

export function modelProfile(id: string): ModelProfile {
  const profile = MODEL_CATALOG[id];
  if (!profile) {
    throw new Error(
      `unknown model id ${JSON.stringify(id)}; known: ${Object.keys(MODEL_CATALOG).join(', ')}`,
    );
  }
  return profile;
}

export function defaultModelProfile(env: NodeJS.ProcessEnv = process.env): ModelProfile {
  const id = env.COMPANION_MODEL_ID?.trim() || DEFAULT_COMPANION_MODEL_ID;
  return modelProfile(id);
}

export function summaryModelProfile(env: NodeJS.ProcessEnv = process.env): ModelProfile {
  const id = env.SESSION_SUMMARY_MODEL?.trim() || DEFAULT_SUMMARY_MODEL_ID;
  return modelProfile(id);
}
