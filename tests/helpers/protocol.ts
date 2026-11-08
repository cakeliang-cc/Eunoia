/**
 * Shared plumbing for the protocol contract tests and the dual-provider Team
 * test.
 *
 * A fixture provider is a real registry entry: id, base URL, credential env
 * name and protocol. The tests therefore exercise the same `providerFor()` path
 * the Team runtime uses, not an adapter constructed by the test.
 */

import { createSdkModelTurn } from '../../src/agent/model-turn.ts';
import type { LoopOutputItem, ModelTurn } from '../../src/agent/model-port.ts';
import { closeProviders, providerFor } from '../../src/provider/index.ts';
import type { ProviderProtocol } from '../../src/provider/index.ts';

let sequence = 0;

export interface FixtureProviderHandle {
  readonly id: string;
  readonly modelId: string;
  readonly apiKeyEnv: string;
  readonly apiKey: string;
}

/** Register one fixture endpoint as a deployment provider configuration. */
export function registerFixtureProvider(input: {
  readonly protocol: ProviderProtocol;
  readonly baseURL: string;
  readonly apiKey: string;
  readonly requestTimeoutMs?: number;
}): FixtureProviderHandle {
  sequence += 1;
  const id = `fixture-provider-${sequence}`;
  const apiKeyEnv = `FIXTURE_PROVIDER_KEY_${sequence}`;
  const configs = JSON.parse(process.env.MODEL_PROVIDER_CONFIGS ?? '{}') as Record<
    string,
    unknown
  >;
  configs[id] = {
    id,
    baseURL: input.baseURL,
    apiKeyEnv,
    protocol: input.protocol,
    ...(input.requestTimeoutMs !== undefined ? { requestTimeoutMs: input.requestTimeoutMs } : {}),
  };
  process.env.MODEL_PROVIDER_CONFIGS = JSON.stringify(configs);
  process.env[apiKeyEnv] = input.apiKey;
  return { id, modelId: `fixture-model-${sequence}`, apiKeyEnv, apiKey: input.apiKey };
}

/** Resolve a real ModelTurn through the registry, exactly as a member does. */
export async function fixtureTurn(handle: FixtureProviderHandle): Promise<ModelTurn> {
  const adapter = providerFor(handle.id);
  const model = await adapter.createModelProvider().getModel(handle.modelId);
  return createSdkModelTurn(model);
}

export async function closeFixtureProviders(): Promise<void> {
  await closeProviders();
}

/**
 * Drop provider-private fields from an output item.
 *
 * Cross-protocol equivalence is a statement about product-level items; the
 * `raw` carrier is deliberately vendor-specific and is asserted on separately
 * (a fork must not forward it).
 */
export function normalizeOutput(output: readonly LoopOutputItem[]): unknown[] {
  return output.map((item) => {
    switch (item.type) {
      case 'message':
        return { type: 'message', role: item.role, content: item.content };
      case 'function_call':
        return {
          type: 'function_call',
          callId: item.callId,
          name: item.name,
          arguments: item.arguments,
        };
      case 'reasoning':
        return { type: 'reasoning', text: item.text };
    }
  });
}

/** Re-read a captured request body without `any` at every call site. */
export function bodyOf(request: { readonly body: unknown }): Record<string, unknown> {
  return (request.body ?? {}) as Record<string, unknown>;
}

export function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
