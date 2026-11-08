/**
 * The request planner is pure, so every acceptance case about capability,
 * ordering, counting and body size can be asserted here without a provider.
 *
 * B01's calculator vectors live in their own file; this file covers B03–B09 and
 * A09/A10/A14/A15/A22's plan-level half.
 */

import { describe, expect, it } from 'vitest';
import type { UserContentV1 } from '../../src/agent/content.ts';
import {
  MediaPlanError,
  effectiveInputLimit,
  planMediaRequest,
} from '../../src/agent/request-plan.ts';
import { MODEL_CATALOG } from '../../src/models/catalog.ts';
import { MODEL_IDS } from '../../src/config.ts';
import { DEFAULT_MEDIA_LIMITS } from '../../src/media/limits.ts';
import { DEEPSEEK_FLASH_IMAGE_POLICY } from '../../src/provider/deepseek/image-policy.ts';
import { deepSeekImageTokens } from '../../src/provider/deepseek/image-tokens.ts';
import { ImagePolicyRegistry } from '../../src/provider/image-policy.ts';
import { FAKE_IMAGE_POLICY, fakeVisionProfile } from '../../src/provider/fake.ts';
import { makeAsset } from '../helpers/images.ts';

const FAST = MODEL_CATALOG[MODEL_IDS.fast]!;
const COMPANION = MODEL_CATALOG[MODEL_IDS.companion]!;
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

function imageContent(...ids: string[]): UserContentV1 {
  return { version: 1, parts: ids.map((assetId) => ({ type: 'image', assetId })) };
}

function png(width: number, height: number, overrides: Parameters<typeof makeAsset>[0] = {}) {
  return makeAsset({ mediaType: 'image/png', width, height, ...overrides });
}

function expectPlanError(
  result: ReturnType<typeof planMediaRequest>,
  code: string,
): MediaPlanError {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected a plan error');
  expect(result.error).toBeInstanceOf(MediaPlanError);
  expect(result.error.code).toBe(code);
  return result.error;
}

describe('capability preflight (A09, A10, A14, A15)', () => {
  it('rejects an image on a text route with the current scope', () => {
    const result = planMediaRequest({
      profile: COMPANION,
      policy: null,
      current: imageContent(ID_A),
      history: [],
      assets: [png(100, 100)],
      limits: DEFAULT_MEDIA_LIMITS,
    });
    const error = expectPlanError(result, 'MODEL_INPUT_UNSUPPORTED');
    expect(error.status).toBe(422);
    expect(error.details.scope).toBe('current');
    expect(error.details.modality).toBe('image');
  });

  it('rejects text with a historical image and reports scope=history', () => {
    const result = planMediaRequest({
      profile: COMPANION,
      policy: null,
      current: { version: 1, parts: [{ type: 'text', text: '只看文字' }] },
      history: [imageContent(ID_A)],
      assets: [png(100, 100)],
      limits: DEFAULT_MEDIA_LIMITS,
    });
    expect(expectPlanError(result, 'MODEL_INPUT_UNSUPPORTED').details.scope).toBe('history');
  });

  it('allows a text route once the image is behind the summary boundary (A15)', () => {
    const result = planMediaRequest({
      profile: COMPANION,
      policy: null,
      current: { version: 1, parts: [{ type: 'text', text: '那幅画后来怎么样了' }] },
      // The summary replaced the image with text; the request carries no image.
      history: [{ version: 1, parts: [{ type: 'text', text: '（摘要：用户发过一张画）' }] }],
      assets: [],
      limits: DEFAULT_MEDIA_LIMITS,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.images.size).toBe(0);
    expect(result.plan.imageTokens).toBe(0);
  });

  it('refuses a supported route with no registered token policy (A10)', () => {
    const result = planMediaRequest({
      profile: FAST,
      policy: null,
      current: imageContent(ID_A),
      history: [],
      assets: [png(100, 100)],
      limits: DEFAULT_MEDIA_LIMITS,
    });
    const error = expectPlanError(result, 'MODEL_CAPABILITY_UNKNOWN');
    expect(error.details.policyRevision).toBe(FAST.capabilities.policyRevision);
  });

  it('refuses a route whose declared image support is unknown', () => {
    const unknown = {
      ...FAST,
      capabilities: {
        ...FAST.capabilities,
        input: { ...FAST.capabilities.input, image: 'unknown' as const },
      },
    };
    const result = planMediaRequest({
      profile: unknown,
      policy: DEEPSEEK_FLASH_IMAGE_POLICY,
      current: imageContent(ID_A),
      history: [],
      assets: [png(100, 100)],
      limits: DEFAULT_MEDIA_LIMITS,
    });
    expect(expectPlanError(result, 'MODEL_CAPABILITY_UNKNOWN').details.reason).toMatch(/unknown/);
  });

  it('does not silently drop tools to make an image fit', () => {
    const noTools = {
      ...FAST,
      capabilities: { ...FAST.capabilities, tools: 'unsupported' as const },
    };
    const result = planMediaRequest({
      profile: noTools,
      policy: DEEPSEEK_FLASH_IMAGE_POLICY,
      current: imageContent(ID_A),
      history: [],
      assets: [png(100, 100)],
      limits: DEFAULT_MEDIA_LIMITS,
      requiresTools: true,
    });
    expect(expectPlanError(result, 'MODEL_TOOLS_UNSUPPORTED').status).toBe(422);
  });
});

describe('counting the actual request variant (B03, B04, B05, B06)', () => {
  it('counts the variant dimensions, not the original (B03)', () => {
    const asset = png(3_000, 2_000, {
      id: ID_A,
      request: {
        key: 'k',
        width: 1_500,
        height: 1_000,
        bytes: 123_456,
        sha256: 'variant',
        processorVersion: 'test',
        policyRevision: 'request-variant/1',
      },
    });
    const result = planMediaRequest({
      profile: FAST,
      policy: DEEPSEEK_FLASH_IMAGE_POLICY,
      current: imageContent(ID_A),
      history: [],
      assets: [asset],
      limits: DEFAULT_MEDIA_LIMITS,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.imageTokens).toBe(deepSeekImageTokens(1_500, 1_000));
    expect(result.plan.imageTokens).not.toBe(deepSeekImageTokens(3_000, 2_000));
  });

  it('counts the same image once per occurrence (B04)', () => {
    const asset = png(800, 800, { id: ID_A });
    const result = planMediaRequest({
      profile: FAST,
      policy: DEEPSEEK_FLASH_IMAGE_POLICY,
      current: {
        version: 1,
        parts: [
          { type: 'image', assetId: ID_A },
          { type: 'image', assetId: ID_A },
        ],
      },
      history: [],
      assets: [asset],
      limits: DEFAULT_MEDIA_LIMITS,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.occurrences).toBe(2);
    expect(result.plan.imageTokens).toBe(2 * 422);
    expect(result.plan.images.size).toBe(1);
  });

  it('five 800×800 request images cost 2110 tokens and not their Base64 (B05)', () => {
    const asset = png(800, 800, {
      id: ID_A,
      request: {
        key: 'k',
        width: 800,
        height: 800,
        bytes: 1_000_000,
        sha256: 'variant',
        processorVersion: 'test',
        policyRevision: 'request-variant/1',
      },
    });
    const result = planMediaRequest({
      profile: FAST,
      policy: DEEPSEEK_FLASH_IMAGE_POLICY,
      current: imageContent(ID_A, ID_A, ID_A, ID_A, ID_A),
      history: [],
      assets: [asset],
      limits: DEFAULT_MEDIA_LIMITS,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.imageTokens).toBe(2_110);
    // A short text estimate must not contain the encoded body's bytes.
    expect(result.plan.textTokens).toBeLessThan(100);
    expect(result.plan.requestBodyBytes).toBeGreaterThan(6_000_000);
  });

  it('uses a different formula and different limits on the second route (B06/A22)', () => {
    const fake = fakeVisionProfile();
    const asset = png(800, 800, { id: ID_A });
    const result = planMediaRequest({
      profile: fake,
      policy: FAKE_IMAGE_POLICY,
      current: imageContent(ID_A),
      history: [],
      assets: [asset],
      limits: DEFAULT_MEDIA_LIMITS,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.imageTokens).toBe(Math.ceil((800 * 800) / 4096) + 48);
    expect(result.plan.imageTokens).not.toBe(deepSeekImageTokens(800, 800));
    expect(result.plan.imagePolicyId).toBe('fake-tile-v1');
    expect(result.plan.modelId).toBe(fake.id);
  });

  it('takes the stricter of product and route image limits', () => {
    const fake = fakeVisionProfile();
    const result = planMediaRequest({
      profile: fake,
      policy: FAKE_IMAGE_POLICY,
      current: imageContent(ID_A, ID_B),
      history: [],
      assets: [png(100, 100, { id: ID_A }), png(100, 100, { id: ID_B })],
      limits: DEFAULT_MEDIA_LIMITS,
    });
    expect(result.ok).toBe(true);
    // Fake route allows 3; a fourth would fail with the route's number.
    const tooMany = planMediaRequest({
      profile: fake,
      policy: FAKE_IMAGE_POLICY,
      current: imageContent(ID_A, ID_A, ID_A, ID_A),
      history: [],
      assets: [png(100, 100, { id: ID_A })],
      limits: DEFAULT_MEDIA_LIMITS,
    });
    expect(expectPlanError(tooMany, 'IMAGE_COUNT_EXCEEDED').details.maxCount).toBe(3);
  });
});

describe('budget boundaries and uncertainty (B07, B08, B09)', () => {
  const fake = fakeVisionProfile();
  const asset = png(100, 100, { id: ID_A });

  it('accepts exactly the limit and rejects one token under it (B07)', () => {
    const base = planMediaRequest({
      profile: fake,
      policy: FAKE_IMAGE_POLICY,
      current: { version: 1, parts: [{ type: 'text', text: 'hi' }] },
      history: [],
      assets: [],
      limits: DEFAULT_MEDIA_LIMITS,
      inputBudgetTokens: 10_000,
      fixedTokens: 5_000,
    });
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    const exact = base.plan.estimatedInputTokens;

    const fits = planMediaRequest({
      profile: fake,
      policy: FAKE_IMAGE_POLICY,
      current: { version: 1, parts: [{ type: 'text', text: 'hi' }] },
      history: [],
      assets: [],
      limits: DEFAULT_MEDIA_LIMITS,
      inputBudgetTokens: exact,
      fixedTokens: 5_000,
    });
    expect(fits.ok).toBe(true);

    const justUnder = planMediaRequest({
      profile: fake,
      policy: FAKE_IMAGE_POLICY,
      current: { version: 1, parts: [{ type: 'text', text: 'hi' }] },
      history: [],
      assets: [],
      limits: DEFAULT_MEDIA_LIMITS,
      inputBudgetTokens: exact - 1,
      fixedTokens: 5_000,
    });
    expect(expectPlanError(justUnder, 'CONTEXT_BUDGET_EXCEEDED').details.inputLimit).toBe(
      exact - 1,
    );
  });

  it('reports uncertainty when the point estimate fits but the bound does not (B08)', () => {
    const estimatedPlan = planMediaRequest({
      profile: fake,
      policy: FAKE_IMAGE_POLICY,
      current: imageContent(ID_A),
      history: [],
      assets: [asset],
      limits: DEFAULT_MEDIA_LIMITS,
      inputBudgetTokens: 10_000,
      fixedTokens: 5_000,
    });
    expect(estimatedPlan.ok).toBe(true);
    if (!estimatedPlan.ok) return;
    const between = estimatedPlan.plan.estimatedInputTokens + 1;
    expect(between).toBeLessThan(estimatedPlan.plan.upperBoundInputTokens);

    const uncertain = planMediaRequest({
      profile: fake,
      policy: FAKE_IMAGE_POLICY,
      current: imageContent(ID_A),
      history: [],
      assets: [asset],
      limits: DEFAULT_MEDIA_LIMITS,
      inputBudgetTokens: between,
      fixedTokens: 5_000,
      fixedBodyBytes: 0,
    });
    const error = expectPlanError(uncertain, 'CONTEXT_BUDGET_UNCERTAIN');
    expect(error.status).toBe(422);
    expect(error.details.estimatedTokens).toBe(estimatedPlan.plan.estimatedInputTokens);
  });

  it('separates a request-body overrun from a context overrun (B09)', () => {
    const hugeVariant = png(800, 800, {
      id: ID_A,
      request: {
        key: 'k',
        width: 800,
        height: 800,
        bytes: 6_000_000,
        sha256: 'big',
        processorVersion: 'test',
        policyRevision: 'request-variant/1',
      },
    });
    const result = planMediaRequest({
      profile: FAST,
      policy: DEEPSEEK_FLASH_IMAGE_POLICY,
      current: imageContent(ID_A, ID_A, ID_A, ID_A, ID_A),
      history: [],
      assets: [hugeVariant],
      limits: DEFAULT_MEDIA_LIMITS,
      inputBudgetTokens: 200_000,
    });
    const error = expectPlanError(result, 'REQUEST_BODY_TOO_LARGE');
    expect(error.status).toBe(413);
    expect(error.details.requestBodyBytes).toBeGreaterThan(32 * 1024 * 1024);
  });

  it('exposes the same effective limit the session budget uses', () => {
    expect(effectiveInputLimit(FAST)).toBe(
      Math.min(
        FAST.defaultInputBudgetTokens,
        FAST.contextWindowTokens - FAST.maxOutputTokens - FAST.safetyBufferTokens,
      ),
    );
  });
});

describe('policy registry', () => {
  it('resolves only registered ids and never defaults to DeepSeek', () => {
    const registry = new ImagePolicyRegistry().register(FAKE_IMAGE_POLICY);
    expect(registry.forRoute({ imagePolicyId: 'fake-tile-v1', policyRevision: 'x' })?.id).toBe(
      'fake-tile-v1',
    );
    expect(registry.forRoute({ policyRevision: 'x' })).toBeNull();
    expect(registry.forRoute({ imagePolicyId: 'not-registered', policyRevision: 'x' })).toBeNull();
  });
});
