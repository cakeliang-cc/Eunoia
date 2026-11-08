/**
 * Second-provider configuration is deployment data, not a vendor branch.
 *
 * These tests never create a provider (that needs a credential); they pin the
 * resolution rules the fixture-backed protocol tests and the Team runtime rely
 * on: an id maps to a profile, the profile names the protocol, and a malformed
 * configuration fails instead of silently falling back to DeepSeek.
 */

import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  DEEPSEEK_PROFILE,
  providerFor,
  providerProfile,
  providerProfiles,
  providerProtocol,
  closeProviders,
} from '../../src/provider/index.ts';

const ORIGINAL = process.env.MODEL_PROVIDER_CONFIGS;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.MODEL_PROVIDER_CONFIGS;
  else process.env.MODEL_PROVIDER_CONFIGS = ORIGINAL;
});

describe('provider configuration', () => {
  it('declares the protocol on the built-in profile', () => {
    expect(DEEPSEEK_PROFILE.protocol).toBe('responses');
    expect(providerProtocol('deepseek', {})).toBe('responses');
  });

  it('adds a second provider from MODEL_PROVIDER_CONFIGS without a code change', () => {
    const env = {
      MODEL_PROVIDER_CONFIGS: JSON.stringify({
        'second-vendor': {
          baseURL: 'https://second.example/v1',
          apiKeyEnv: 'SECOND_VENDOR_KEY',
          protocol: 'chat-completions',
          requestTimeoutMs: 30_000,
        },
      }),
    };
    const profiles = providerProfiles(env);
    expect(profiles.get('second-vendor')).toMatchObject({
      id: 'second-vendor',
      baseURL: 'https://second.example/v1',
      apiKeyEnv: 'SECOND_VENDOR_KEY',
      protocol: 'chat-completions',
      requestTimeoutMs: 30_000,
    });
    expect(providerProtocol('second-vendor', env)).toBe('chat-completions');
    // The built-in entry is still present and still on its own protocol.
    expect(profiles.get('deepseek')?.protocol).toBe('responses');
  });

  it('accepts an array form as well as an object', () => {
    const env = {
      MODEL_PROVIDER_CONFIGS: JSON.stringify([
        {
          id: 'array-provider',
          baseURL: 'http://127.0.0.1:9999/v1',
          apiKeyEnv: 'ARRAY_KEY',
          protocol: 'responses',
        },
      ]),
    };
    expect(providerProfile('array-provider', env).protocol).toBe('responses');
  });

  it('rejects a malformed configuration instead of falling back', () => {
    expect(() =>
      providerProfiles({ MODEL_PROVIDER_CONFIGS: '{not json' }),
    ).toThrow(/MODEL_PROVIDER_CONFIGS/);
    expect(() =>
      providerProfiles({
        MODEL_PROVIDER_CONFIGS: JSON.stringify({
          bad: { baseURL: 'ftp://x', apiKeyEnv: 'K', protocol: 'responses' },
        }),
      }),
    ).toThrow(/baseURL/);
    expect(() =>
      providerProfiles({
        MODEL_PROVIDER_CONFIGS: JSON.stringify({
          bad: { baseURL: 'https://x/v1', apiKeyEnv: 'K', protocol: 'grpc' },
        }),
      }),
    ).toThrow(/protocol/);
  });

  it('lets a deployment override the built-in endpoint without a name branch', () => {
    process.env.MODEL_PROVIDER_CONFIGS = JSON.stringify({
      deepseek: {
        baseURL: 'http://127.0.0.1:7777/v1',
        apiKeyEnv: 'LOCAL_KEY',
        protocol: 'chat-completions',
      },
    });
    expect(providerProfile('deepseek').baseURL).toBe('http://127.0.0.1:7777/v1');
    expect(providerProtocol('deepseek')).toBe('chat-completions');
    expect(providerFor('deepseek').profile.baseURL).toBe('http://127.0.0.1:7777/v1');
  });

  it('rejects an unknown provider id', () => {
    expect(() => providerProfile('missing-provider', {})).toThrow(/unknown provider/);
  });
});

// Close adapters registered by these tests so no HTTP wrapper outlives the file.
afterAll(async () => {
  await closeProviders();
});
