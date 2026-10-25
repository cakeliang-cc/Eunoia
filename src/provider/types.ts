/**
 * Provider ports.
 *
 * A provider owns transport: a base URL, credentials, and a protocol. It does
 * not own session budgets, summaries, or prompt policy. Keeping this interface
 * here means the session layer can stay completely unaware of vendor SDKs.
 */

import type { ModelProvider } from '@openai/agents';
import type OpenAI from 'openai';

export interface ProviderProfile {
  readonly id: string;
  readonly baseURL: string;
  /** Environment variable this provider prefers for its key. */
  readonly apiKeyEnv: string;
}

export interface ProviderAdapter {
  readonly profile: ProviderProfile;
  /** The Agents SDK provider used for one run. */
  createModelProvider(): ModelProvider;
  /** A plain client for auxiliary calls such as summaries. */
  createClient(): OpenAI;
  close(): Promise<void>;
}
