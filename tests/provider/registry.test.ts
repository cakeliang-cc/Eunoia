/**
 * Provider ids resolve to adapters, not to SDK calls at the call site.
 *
 * These tests intentionally never create a provider: `createModelProvider()`
 * requires a credential, while resolution and failure behaviour do not.
 */

import { describe, expect, it } from 'vitest';
import { defaultProviderId, providerFor } from '../../src/provider/index.ts';

describe('provider registry', () => {
  it('resolves the DeepSeek adapter by id', () => {
    expect(providerFor('deepseek').profile).toMatchObject({
      id: 'deepseek',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    });
  });

  it('returns the same adapter for repeated lookups', () => {
    expect(providerFor('deepseek')).toBe(providerFor('deepseek'));
  });

  it('rejects an unknown provider', () => {
    expect(() => providerFor('not-a-provider')).toThrow(/unknown provider/);
  });

  it('defaults to DeepSeek and allows an override', () => {
    expect(defaultProviderId({})).toBe('deepseek');
    expect(defaultProviderId({ MODEL_PROVIDER: 'deepseek' })).toBe('deepseek');
  });
});
