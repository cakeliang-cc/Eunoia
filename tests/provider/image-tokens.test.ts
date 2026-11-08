/**
 * B01 — the DeepSeek v41 vectors.
 *
 * These numbers are the contract in the budget document. If the calculator
 * changes, either the document changes with a new policy revision or the test
 * fails; a silent drift would make every budget decision on this route wrong.
 */

import { describe, expect, it } from 'vitest';
import { deepSeekImageTokens } from '../../src/provider/deepseek/image-tokens.ts';

describe('DeepSeek image token calculator (v41)', () => {
  const vectors: readonly [number, number, number][] = [
    [544, 544, 184],
    [512, 512, 184],
    [100, 100, 184],
    [640, 480, 206],
    [480, 640, 210],
    [800, 800, 422],
    [1024, 1024, 652],
  ];

  for (const [width, height, expected] of vectors) {
    it(`${width}×${height} is ${expected}`, () => {
      expect(deepSeekImageTokens(width, height)).toBe(expected);
      // The grid is symmetric in a square and asymmetric when transposed.
      if (width !== height) {
        expect(deepSeekImageTokens(height, width)).toBeGreaterThan(0);
      }
    });
  }

  it('never exceeds the 1024 cap, even for a huge image', () => {
    expect(deepSeekImageTokens(8_000, 5_000)).toBeLessThanOrEqual(1_024);
    expect(deepSeekImageTokens(8_192, 1)).toBeLessThanOrEqual(1_024);
  });

  it('rejects invalid dimensions instead of pricing them at zero', () => {
    for (const [width, height] of [
      [0, 1],
      [1, 0],
      [-1, 100],
      [Number.NaN, 100],
      [Number.POSITIVE_INFINITY, 100],
      [1.5, 100],
      [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    ]) {
      expect(() => deepSeekImageTokens(width as number, height as number)).toThrow();
    }
  });

  it('converges on extreme aspect ratios without looping', () => {
    expect(deepSeekImageTokens(20_000, 13)).toBeGreaterThan(0);
    expect(deepSeekImageTokens(13, 20_000)).toBeGreaterThan(0);
  });
});
