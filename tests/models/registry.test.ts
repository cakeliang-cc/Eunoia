/**
 * Model profiles, not provider SDKs.
 *
 * A model's context window is a capability fact. The product budget is a
 * separate, lower number; these tests keep the two from collapsing into one
 * global constant again.
 */

import { describe, expect, it } from 'vitest';
import { MODEL_IDS } from '../../src/config.ts';
import { defaultModelProfile, modelProfile } from '../../src/models/registry.ts';
import { sessionConfig, sessionReplayBudget } from '../../src/session/config.ts';

function profile(overrides: {
  contextWindowTokens: number;
  maxOutputTokens?: number;
  safetyBufferTokens?: number;
  defaultInputBudgetTokens?: number;
}) {
  return {
    ...modelProfile(MODEL_IDS.companion),
    ...overrides,
  };
}

describe('model profiles', () => {
  it('exposes the DeepSeek companion and fast profiles', () => {
    expect(modelProfile(MODEL_IDS.companion)).toMatchObject({
      id: MODEL_IDS.companion,
      providerId: 'deepseek',
      contextWindowTokens: 1_048_576,
    });
    expect(modelProfile(MODEL_IDS.fast).id).toBe(MODEL_IDS.fast);
  });

  it('fails on an unknown model instead of silently running another one', () => {
    expect(() => modelProfile('deepseek-chat')).toThrow(/unknown model id/);
  });

  it('uses the configured companion model as the default', () => {
    expect(defaultModelProfile({ COMPANION_MODEL_ID: MODEL_IDS.fast }).id).toBe(MODEL_IDS.fast);
  });
});

describe('model-specific replay budget', () => {
  const config = sessionConfig({ SESSION_PROMPT_RESERVE_TOKENS: '8000' });

  it('keeps DeepSeek at the agreed 200k product default', () => {
    expect(sessionReplayBudget(config, modelProfile(MODEL_IDS.companion))).toBe(192_000);
  });

  it('caps a 200k model at its own context, not DeepSeek 1M', () => {
    expect(
      sessionReplayBudget(
        config,
        profile({ contextWindowTokens: 200_000, defaultInputBudgetTokens: 160_000 }),
      ),
    ).toBe(152_000);
  });

  it('caps a 160k model below that', () => {
    expect(
      sessionReplayBudget(
        config,
        profile({ contextWindowTokens: 160_000, defaultInputBudgetTokens: 120_000 }),
      ),
    ).toBe(112_000);
  });

  it('lets an explicit override raise the budget without exceeding the model', () => {
    const raised = sessionConfig({
      SESSION_INPUT_BUDGET_TOKENS: '500000',
      SESSION_PROMPT_RESERVE_TOKENS: '8000',
    });
    expect(sessionReplayBudget(raised, modelProfile(MODEL_IDS.companion))).toBe(492_000);

    const blocked = sessionConfig({
      SESSION_INPUT_BUDGET_TOKENS: '500000',
      SESSION_PROMPT_RESERVE_TOKENS: '8000',
    });
    expect(
      sessionReplayBudget(
        blocked,
        profile({ contextWindowTokens: 200_000, defaultInputBudgetTokens: 160_000 }),
      ),
    ).toBe(182_784);
  });
});
