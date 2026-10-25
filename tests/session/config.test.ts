/**
 * Limits are configuration, not folklore.
 *
 * The defaults are the product's current policy; tests that hard-code numbers
 * elsewhere would make a default change invisible. These assertions pin the
 * agreed values and the fail-fast behaviour for malformed overrides.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_SESSION_CONFIG, sessionConfig, sessionReplayBudget } from '../../src/session/config.ts';

describe('sessionConfig', () => {
  it('uses the agreed defaults when the environment is empty', () => {
    expect(sessionConfig({})).toEqual(DEFAULT_SESSION_CONFIG);
  });

  it('derives the replay budget from total input minus the prompt reserve', () => {
    expect(sessionReplayBudget(DEFAULT_SESSION_CONFIG)).toBe(192_000);
  });

  it('accepts overrides', () => {
    const config = sessionConfig({
      SESSION_INPUT_BUDGET_TOKENS: '64000',
      SESSION_PROMPT_RESERVE_TOKENS: '4000',
      SESSION_COMPACT_KEEP_RECENT_MESSAGES: '12',
      SESSION_IDLE_COMPACT_MINUTES: '60',
      SESSION_TOKEN_ESTIMATOR: 'chars4',
    });

    expect(config.inputBudgetTokens).toBe(64_000);
    expect(config.promptReserveTokens).toBe(4_000);
    expect(config.keepRecentMessages).toBe(12);
    expect(config.idleCompactMinutes).toBe(60);
    expect(config.tokenEstimator).toBe('chars4');
  });

  it('rejects malformed numbers instead of silently using a default', () => {
    expect(() => sessionConfig({ SESSION_INPUT_BUDGET_TOKENS: 'lots' })).toThrow(
      /SESSION_INPUT_BUDGET_TOKENS/,
    );
    expect(() => sessionConfig({ SESSION_COMPACT_TRIGGER_RATIO: '2' })).toThrow(
      /SESSION_COMPACT_TRIGGER_RATIO/,
    );
    expect(() => sessionConfig({ SESSION_TOKEN_ESTIMATOR: 'magic' })).toThrow(
      /SESSION_TOKEN_ESTIMATOR/,
    );
  });
});
