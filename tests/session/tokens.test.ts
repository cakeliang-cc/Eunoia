/**
 * Token estimates are deliberately pessimistic.
 *
 * `chars / 4` is the English rule that made the old window undercount Chinese by
 * roughly four times. These tests pin the mixed estimate and the truncation
 * helper, because a systematic underestimate makes compaction run too late.
 */

import { describe, expect, it } from 'vitest';
import { estimateMessageTokens, estimateTokens, truncateToTokens } from '../../src/session/tokens.ts';

describe('estimateTokens', () => {
  it('counts Chinese characters as roughly one token each', () => {
    expect(estimateTokens('今天不想上班')).toBe(6);
  });

  it('counts English at roughly four characters per token', () => {
    expect(estimateTokens('hello world')).toBe(3);
  });

  it('mixes both scripts conservatively', () => {
    const mixed = estimateTokens('今天 hello');
    const chineseOnly = estimateTokens('今天');
    const englishOnly = estimateTokens(' hello');
    expect(mixed).toBeGreaterThanOrEqual(chineseOnly + englishOnly);
  });

  it('still supports the old chars/4 mode for comparison', () => {
    expect(estimateTokens('今天不想上班', 'chars4')).toBe(2);
  });

  it('adds a small per-message overhead', () => {
    expect(estimateMessageTokens({ content: '你好' })).toBe(6);
  });
});

describe('truncateToTokens', () => {
  it('leaves text that fits untouched', () => {
    expect(truncateToTokens('今天不想上班', 10)).toBe('今天不想上班');
  });

  it('cuts on the estimate and marks the cut', () => {
    const text = '我'.repeat(20);
    const cut = truncateToTokens(text, 5);
    expect(cut.endsWith('…')).toBe(true);
    expect(estimateTokens(cut)).toBeLessThanOrEqual(6);
  });
});
