/**
 * The DeepSeek Flash image policy.
 *
 * One object: the calculator, its revision, and the fact that this is the
 * provider's published algorithm rather than an invented heuristic. The request
 * planner only sees the interface, so a second provider can supply a different
 * formula and a different revision without touching it.
 */

import type { ImageTokenPolicy } from '../image-policy.ts';
import {
  DEEPSEEK_IMAGE_POLICY_REVISION,
  deepSeekImageTokens,
} from './image-tokens.ts';

export const DEEPSEEK_FLASH_IMAGE_POLICY: ImageTokenPolicy = {
  id: 'deepseek-flash-v41',
  revision: DEEPSEEK_IMAGE_POLICY_REVISION,
  estimate(input) {
    const tokens = deepSeekImageTokens(input.width, input.height);
    return {
      estimatedTokens: tokens,
      // The v41 configuration caps one image at 1024 and has no alignment pad
      // that could push the real count above its own calculation, so the same
      // number is a documented bound for the image component.
      upperBoundTokens: tokens,
      basis: 'provider-calculator',
      policyRevision: DEEPSEEK_IMAGE_POLICY_REVISION,
    };
  },
};
