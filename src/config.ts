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

/**
 * The working tree the agent may read, and what it may do there.
 *
 * This is process configuration, never a request field: a path that arrives on
 * a chat request would let the model choose its own sandbox. `null` means no
 * file tools at all, which is the default and the safe state.
 *
 * Writes and commands are separate flags with the same default (off). The usual
 * mistake is to treat "the workspace is configured" as consent for everything;
 * a person who wants the agent to read a repository has not thereby agreed to
 * let it run `npm install`.
 */
export interface WorkspaceConfig {
  readonly root: string;
  readonly writes: boolean;
  readonly commands: boolean;
  readonly ignore: readonly string[];
  readonly allowSensitive: boolean;
}

/** Parse a boolean-ish environment value, defaulting to false. */
export function envFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

/** Read the workspace configuration, or null when none is configured. */
export function workspaceConfig(env: NodeJS.ProcessEnv = process.env): WorkspaceConfig | null {
  const root = env.WORKSPACE_ROOT?.trim();
  if (!root) return null;
  return {
    root,
    writes: envFlag(env.WORKSPACE_WRITES),
    commands: envFlag(env.WORKSPACE_COMMANDS),
    ignore: (env.WORKSPACE_IGNORE ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
    allowSensitive: envFlag(env.WORKSPACE_ALLOW_SENSITIVE),
  };
}

/** The per-turn tool-step cap. Bounded, because this is a runaway guard. */
export function agentMaxSteps(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.AGENT_MAX_STEPS ?? '', 10);
  if (!Number.isFinite(parsed)) return 12;
  return Math.min(Math.max(parsed, 1), 50);
}
