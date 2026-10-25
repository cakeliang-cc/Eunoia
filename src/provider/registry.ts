/**
 * Provider registry.
 *
 * Resolve by id; the adapter owns construction details. For now the only
 * registered provider is DeepSeek, but the call sites no longer construct an SDK
 * provider themselves.
 */

import { createDeepSeekAdapter } from './deepseek.ts';
import type { ProviderAdapter } from './types.ts';

const adapters = new Map<string, ProviderAdapter>();

export function providerFor(id = defaultProviderId()): ProviderAdapter {
  const existing = adapters.get(id);
  if (existing) return existing;

  if (id === 'deepseek') {
    const adapter = createDeepSeekAdapter();
    adapters.set(id, adapter);
    return adapter;
  }

  throw new Error(`unknown provider id ${JSON.stringify(id)}`);
}

export function defaultProviderId(env: NodeJS.ProcessEnv = process.env): string {
  return env.MODEL_PROVIDER?.trim() || 'deepseek';
}

export async function closeProviders(): Promise<void> {
  for (const adapter of adapters.values()) await adapter.close();
  adapters.clear();
}
