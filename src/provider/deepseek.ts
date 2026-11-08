/**
 * DeepSeek adapter.
 *
 * DeepSeek's OpenAI-compatible surface implements the Responses API natively,
 * so this is the generic OpenAI-compatible adapter with DeepSeek's profile.
 * The vendor-specific parts are only the base URL, the credential names and the
 * protocol declaration; nothing in the orchestration branches on "deepseek".
 */

import { DEEPSEEK_BASE_URL } from '../config.ts';
import { createOpenAICompatibleAdapter } from './openai-compatible.ts';
import type { ProviderAdapter, ProviderProfile } from './types.ts';

export const DEEPSEEK_PROFILE: ProviderProfile = {
  id: 'deepseek',
  baseURL: DEEPSEEK_BASE_URL,
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  // `ANTHROPIC_AUTH_TOKEN` is accepted because this development environment
  // already exports it and it is a working DeepSeek key on every route.
  apiKeyFallbackEnvs: ['ANTHROPIC_AUTH_TOKEN'],
  protocol: 'responses',
};

export function createDeepSeekAdapter(): ProviderAdapter {
  return createOpenAICompatibleAdapter(DEEPSEEK_PROFILE);
}
