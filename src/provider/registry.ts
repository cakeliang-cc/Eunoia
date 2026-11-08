/**
 * Provider registry.
 *
 * Resolve by id; the adapter owns construction details. Two provider
 * configurations with different protocols are two entries here, not two code
 * paths in the orchestration: the Team runtime asks the registry for the
 * provider named by the member's profile and receives the same `ModelTurn`
 * adapter shape either way.
 *
 * Extra providers are deployment configuration (`MODEL_PROVIDER_CONFIGS`), so a
 * second endpoint can be added without editing this file and without a vendor
 * name appearing in the loop, the Team service or the fork path.
 */

import { DEEPSEEK_PROFILE } from './deepseek.ts';
import { createOpenAICompatibleAdapter } from './openai-compatible.ts';
import type { ProviderAdapter, ProviderProfile, ProviderProtocol } from './types.ts';

interface CachedAdapter {
  /** Identity of the profile that produced the adapter. */
  readonly fingerprint: string;
  readonly adapter: ProviderAdapter;
}

const adapters = new Map<string, CachedAdapter>();

/**
 * Parse `MODEL_PROVIDER_CONFIGS`.
 *
 * Accepts either an object keyed by provider id or an array whose entries carry
 * `id`. A malformed value is a startup error: silently ignoring it would run
 * the default provider while the operator believes a second one is configured.
 */
function parseProviderConfigs(raw: string): ProviderProfile[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `MODEL_PROVIDER_CONFIGS is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const entries: Array<[string | null, unknown]> = Array.isArray(parsed)
    ? parsed.map((entry) => [null, entry] as const)
    : typeof parsed === 'object' && parsed !== null
      ? Object.entries(parsed)
      : (() => {
          throw new Error('MODEL_PROVIDER_CONFIGS must be a JSON object or array');
        })();

  return entries.map(([keyId, value]) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('MODEL_PROVIDER_CONFIGS entries must be objects');
    }
    const record = value as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : keyId;
    const baseURL = record.baseURL;
    const apiKeyEnv = record.apiKeyEnv;
    const protocol = record.protocol;
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new Error('MODEL_PROVIDER_CONFIGS entry is missing "id"');
    }
    if (typeof baseURL !== 'string' || !/^https?:\/\//.test(baseURL)) {
      throw new Error(`provider ${id}: baseURL must be an http(s) URL`);
    }
    if (typeof apiKeyEnv !== 'string' || apiKeyEnv.trim().length === 0) {
      throw new Error(`provider ${id}: apiKeyEnv is required`);
    }
    if (protocol !== 'responses' && protocol !== 'chat-completions') {
      throw new Error(`provider ${id}: protocol must be "responses" or "chat-completions"`);
    }
    const timeout = record.requestTimeoutMs;
    const fallbacks = record.apiKeyFallbackEnvs;
    return {
      id,
      baseURL,
      apiKeyEnv,
      protocol,
      ...(typeof timeout === 'number' && timeout > 0 ? { requestTimeoutMs: timeout } : {}),
      ...(Array.isArray(fallbacks) && fallbacks.every((entry) => typeof entry === 'string')
        ? { apiKeyFallbackEnvs: fallbacks as string[] }
        : {}),
    } satisfies ProviderProfile;
  });
}

/**
 * Every configured provider profile, keyed by id.
 *
 * Read on demand rather than frozen at import: a test or an operator tool can
 * set the environment before the first resolution, and a restart is not needed
 * to see a configuration error.
 */
export function providerProfiles(
  env: NodeJS.ProcessEnv = process.env,
): ReadonlyMap<string, ProviderProfile> {
  const profiles = new Map<string, ProviderProfile>();
  profiles.set(DEEPSEEK_PROFILE.id, DEEPSEEK_PROFILE);
  const raw = env.MODEL_PROVIDER_CONFIGS?.trim();
  if (raw) {
    for (const profile of parseProviderConfigs(raw)) profiles.set(profile.id, profile);
  }
  return profiles;
}

export function providerProfile(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): ProviderProfile {
  const profile = providerProfiles(env).get(id);
  if (!profile) throw new Error(`unknown provider id ${JSON.stringify(id)}`);
  return profile;
}

/** The wire protocol a provider id speaks, for fork and transcript boundaries. */
export function providerProtocol(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): ProviderProtocol {
  return providerProfile(id, env).protocol;
}

export function providerFor(id = defaultProviderId()): ProviderAdapter {
  const profile = providerProfile(id);
  const fingerprint = JSON.stringify(profile);
  const existing = adapters.get(id);
  if (existing && existing.fingerprint === fingerprint) return existing.adapter;
  if (existing) void existing.adapter.close();

  // One adapter shape for every provider: the profile carries protocol, URL and
  // credential name, so an override of the built-in entry is honoured too.
  const adapter = createOpenAICompatibleAdapter(profile);
  adapters.set(id, { fingerprint, adapter });
  return adapter;
}

export function defaultProviderId(env: NodeJS.ProcessEnv = process.env): string {
  return env.MODEL_PROVIDER?.trim() || 'deepseek';
}

export async function closeProviders(): Promise<void> {
  for (const cached of adapters.values()) await cached.adapter.close();
  adapters.clear();
}
