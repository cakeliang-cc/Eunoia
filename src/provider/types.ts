/**
 * Provider ports.
 *
 * A provider owns transport: a base URL, credentials, and a protocol. It does
 * not own session budgets, summaries, or prompt policy. Keeping this interface
 * here means the session layer can stay completely unaware of vendor SDKs.
 */

import type { ModelProvider } from '@openai/agents';
import type OpenAI from 'openai';

/**
 * The wire protocol a provider speaks.
 *
 * This is the only distinction the product is allowed to branch on. A vendor
 * name is configuration; the protocol decides how text, tool calls and usage
 * are encoded. Two providers can share a protocol, and one vendor can expose
 * both (an OpenAI-compatible endpoint usually does).
 *
 * - `responses` is the OpenAI Responses API (`POST {baseURL}/responses`, SSE
 *   events such as `response.output_text.delta`).
 * - `chat-completions` is the Chat Completions API
 *   (`POST {baseURL}/chat/completions`, `chat.completion.chunk` SSE frames
 *   terminated by `[DONE]`).
 */
export type ProviderProtocol = 'responses' | 'chat-completions';

export interface ProviderProfile {
  readonly id: string;
  readonly baseURL: string;
  /** Environment variable this provider prefers for its key. */
  readonly apiKeyEnv: string;
  /** The wire protocol this endpoint implements. */
  readonly protocol: ProviderProtocol;
  /**
   * Fallback environment variables, in order. Used only when `apiKeyEnv` is
   * empty; it exists for installations that already export another name.
   */
  readonly apiKeyFallbackEnvs?: readonly string[];
  /**
   * Per-request timeout. Undefined keeps the vendor SDK's default, so adopting
   * a shorter timeout is explicit configuration rather than a silent change.
   */
  readonly requestTimeoutMs?: number;
}

export interface ProviderAdapter {
  readonly profile: ProviderProfile;
  /** The Agents SDK provider used for one run. */
  createModelProvider(): ModelProvider;
  /** A plain client for auxiliary calls such as summaries. */
  createClient(): OpenAI;
  close(): Promise<void>;
}
