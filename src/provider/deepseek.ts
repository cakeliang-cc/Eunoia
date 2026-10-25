/**
 * DeepSeek adapter.
 *
 * The only provider today. It serves both the Agents runtime (Responses API)
 * and the small OpenAI-compatible client used for summaries. The adapter is
 * cached so the provider's connection wrappers are not rebuilt per call.
 */

import { OpenAIProvider } from '@openai/agents';
import OpenAI from 'openai';
import { DEEPSEEK_BASE_URL, resolveApiKey } from '../config.ts';
import type { ProviderAdapter, ProviderProfile } from './types.ts';

const PROFILE: ProviderProfile = {
  id: 'deepseek',
  baseURL: DEEPSEEK_BASE_URL,
  apiKeyEnv: 'DEEPSEEK_API_KEY',
};

export function createDeepSeekAdapter(): ProviderAdapter {
  let provider: OpenAIProvider | null = null;

  return {
    profile: PROFILE,
    createModelProvider() {
      provider ??= new OpenAIProvider({
        apiKey: resolveApiKey(),
        baseURL: DEEPSEEK_BASE_URL,
        useResponses: true,
      });
      return provider;
    },
    createClient() {
      return new OpenAI({
        apiKey: resolveApiKey(),
        baseURL: DEEPSEEK_BASE_URL,
        maxRetries: 1,
        timeout: 60_000,
      });
    },
    async close() {
      await provider?.close();
      provider = null;
    },
  };
}
