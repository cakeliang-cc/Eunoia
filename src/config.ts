/**
 * Canonical configuration constants.
 *
 * Model IDs must be DeepSeek's canonical IDs. DeepSeek silently resolves
 * several aliases to `deepseek-flash` — `deepseek-chat`, `deepseek-reasoner`,
 * and `deepseek-v4-flash` all do — so a misconfigured name runs the wrong model
 * with no error at all. `tests/architecture/model-ids.test.ts` enforces this.
 *
 * See docs/adr/005-agent-runtime.md.
 */

/**
 * DeepSeek's OpenAI-compatible surface. The Agents SDK drives this through the
 * Responses API, which DeepSeek implements natively.
 */
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

/** The only two model IDs that exist. Everything else is an alias. */
export const MODEL_IDS = {
  /** Stronger tier, text-only. Used for the companion itself. */
  companion: 'deepseek-v4-pro',
  /** Fast tier. Used for cheap/auxiliary calls (memory extraction, eval judging). */
  fast: 'deepseek-flash',
} as const;

/**
 * Aliases that resolve to `deepseek-flash` without error. Listed so the guard
 * test can reject them by name, and so the reason is discoverable.
 */
export const FORBIDDEN_MODEL_ALIASES = [
  'deepseek-chat',
  'deepseek-reasoner',
  'deepseek-v4-flash',
] as const;

/** Context window for both models. */
export const MODEL_CONTEXT_WINDOW = 1_048_576;

/**
 * Environment variable holding the DeepSeek API key.
 *
 * `DEEPSEEK_API_KEY` is the name to prefer going forward. `ANTHROPIC_AUTH_TOKEN`
 * is accepted as a fallback because it is what this development environment
 * already has set, and it is a working DeepSeek key on every route.
 */
export function resolveApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.DEEPSEEK_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim();
  if (!key) {
    throw new Error(
      'No DeepSeek API key found. Set DEEPSEEK_API_KEY (preferred) or ANTHROPIC_AUTH_TOKEN.',
    );
  }
  return key;
}
