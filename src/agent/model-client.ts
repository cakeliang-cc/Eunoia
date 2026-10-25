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
 * - The product-logic layers (`memory`, `tools`, `safety`, `evaluation`,
 *   `service`) and the transport layer (`api`) must not *install* it. Installing
 *   a provider is a process-level side effect, so it belongs to whoever starts
 *   the process and to nobody else. `COMPANION_MODEL` is a plain constant and is
 *   imported freely; `installProvider` may only be called from a composition
 *   root, and `tests/architecture/boundaries.test.ts` enforces exactly that.
 *
 *   The rule is not decoration: `npm run eval` shipped without the call, and
 *   every case failed with "Missing credentials" — which reads like a bad key
 *   and is actually a missing line in an entry point.
 *
 * The runtime is the OpenAI Agents SDK (spec §8) pointed at DeepSeek's
 * OpenAI-compatible surface. DeepSeek implements the Responses API natively, so
 * the SDK's default model path works and no chat-completions adapter is needed.
 *
 * See docs/adr/005-agent-runtime.md.
 */

import { setDefaultModelProvider, type ModelProvider } from '@openai/agents';
import { MODEL_IDS } from '../config.ts';
import { defaultProviderId, providerFor } from '../provider/index.ts';

/** The model used by the companion itself. */
export const COMPANION_MODEL = MODEL_IDS.companion;

/**
 * Build the configured provider.
 *
 * The adapter owns credentials and protocol; this function only bridges it to
 * the SDK's process-level default for callers that have not moved to explicit
 * per-run injection yet.
 */
export function createProvider(): ModelProvider {
  return providerFor(defaultProviderId()).createModelProvider();
}

/**
 * Install the configured provider as the SDK default.
 *
 * Compatibility path for entry points that still rely on a global provider.
 * The companion run itself passes its provider explicitly.
 */
export function installProvider(): void {
  setDefaultModelProvider(createProvider());
}
