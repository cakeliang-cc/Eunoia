/**
 * The one module that constructs a model provider.
 *
 * Precisely scoped claim — an earlier version of this comment said "nothing else
 * imports a vendor SDK", which was untrue and which the boundary test caught:
 *
 * - This file is the only place that constructs a *provider*. Changing endpoint
 *   or credentials is a change here and nowhere else.
 * - The harness layer (`src/agent/infp-agent.ts`, `src/observability/tracing.ts`)
 *   does use SDK primitives — `Agent`, `run`, and the tracing interfaces. That is
 *   the SDK being the SDK, not leakage; abstracting it away would mean
 *   reimplementing it.
 * - The product-logic layers (`memory`, `tools`, `safety`, `evaluation`) and the
 *   transport layer (`api`) must not import it at all. That is the invariant
 *   `tests/architecture/boundaries.test.ts` enforces, and it is what keeps the
 *   bulk of the product's own code swappable.
 *
 * The runtime is the OpenAI Agents SDK (spec §8) pointed at DeepSeek's
 * OpenAI-compatible surface. DeepSeek implements the Responses API natively, so
 * the SDK's default model path works and no chat-completions adapter is needed.
 *
 * See docs/adr/005-agent-runtime.md.
 */

import { OpenAIProvider, setDefaultModelProvider } from '@openai/agents';
import { DEEPSEEK_BASE_URL, MODEL_IDS, resolveApiKey } from '../config.ts';

/** The model used by the companion itself. */
export const COMPANION_MODEL = MODEL_IDS.companion;

/**
 * Build the DeepSeek-backed provider.
 *
 * Throws if no API key is configured, rather than letting the SDK fail later
 * with an opaque authentication error.
 */
export function createProvider(): OpenAIProvider {
  return new OpenAIProvider({
    apiKey: resolveApiKey(),
    baseURL: DEEPSEEK_BASE_URL,
    useResponses: true,
  });
}

/**
 * Install DeepSeek as the default model provider.
 *
 * Call once before constructing an agent. Separated from `createProvider` so
 * that tests which never make a network call can build an agent without needing
 * a credential.
 */
export function installProvider(): void {
  setDefaultModelProvider(createProvider());
}
