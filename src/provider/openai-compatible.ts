/**
 * One adapter for every OpenAI-compatible endpoint.
 *
 * The product used to construct a provider only in `deepseek.ts`, which made
 * "add a second provider" a code change. The transport difference between an
 * endpoint that implements the Responses API and one that only implements Chat
 * Completions is a single option (`useResponses`); everything else — base URL,
 * credential, timeout — is configuration. This module is that seam.
 *
 * Nothing here knows a vendor name. `profile.protocol` selects the wire
 * encoding and `profile.id` is only a cache/registry key.
 */

import { OpenAIProvider } from '@openai/agents';
import OpenAI from 'openai';
import type { ProviderAdapter, ProviderProfile } from './types.ts';

/** Resolve the credential named by the profile, without guessing a vendor. */
export function resolveProviderApiKey(
  profile: ProviderProfile,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const names = [profile.apiKeyEnv, ...(profile.apiKeyFallbackEnvs ?? [])];
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  throw new Error(
    `No API key for provider ${JSON.stringify(profile.id)}. Set ${names.join(' or ')}.`,
  );
}

function createClient(profile: ProviderProfile, apiKey: string): OpenAI {
  return new OpenAI({
    apiKey,
    baseURL: profile.baseURL,
    maxRetries: 0,
    ...(profile.requestTimeoutMs !== undefined ? { timeout: profile.requestTimeoutMs } : {}),
  });
}

export function createOpenAICompatibleAdapter(profile: ProviderProfile): ProviderAdapter {
  let provider: OpenAIProvider | null = null;
  let client: OpenAI | null = null;

  const sharedClient = (): OpenAI => {
    client ??= createClient(profile, resolveProviderApiKey(profile));
    return client;
  };

  return {
    profile,
    createModelProvider() {
      provider ??= new OpenAIProvider({
        // Passing the client is what applies `requestTimeoutMs`; constructing
        // the provider from apiKey/baseURL alone would silently keep the SDK's
        // ten-minute default.
        openAIClient: sharedClient(),
        // The protocol, not the vendor, decides the encoding.
        useResponses: profile.protocol === 'responses',
        useResponsesWebSocket: false,
      });
      return provider;
    },
    createClient() {
      return sharedClient();
    },
    async close() {
      await provider?.close();
      provider = null;
      client = null;
    },
  };
}
