/**
 * Session limits, loaded once at process start.
 *
 * Every value has a default because the product should run without a wall of
 * environment variables. The defaults are deliberately visible in
 * `.env.example`; a limit that only exists in a source file is a limit nobody
 * can find when behaviour changes.
 *
 * Invalid values fail startup. Falling back silently to a default would make a
 * typo look like a compaction policy, and the failure would surface much later
 * as "why did it forget?".
 */

import type { TokenEstimatorMode } from './tokens.ts';

export interface SessionConfig {
  readonly compactionEnabled: boolean;
  readonly inputBudgetTokens: number;
  readonly promptReserveTokens: number;
  readonly compactTriggerRatio: number;
  readonly keepRecentMessages: number;
  readonly keepRecentTokens: number;
  readonly compactMinMessages: number;
  readonly summaryModel: string;
  readonly summaryTargetTokens: number;
  readonly summaryMaxInputTokens: number;
  readonly idleCompactMinutes: number;
  readonly compactCheckIntervalSeconds: number;
  readonly idleScanLimit: number;
  readonly tokenEstimator: TokenEstimatorMode;
  readonly replayMaxMessages: number;
  readonly listLimit: number;
  readonly messageLimit: number;
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  compactionEnabled: true,
  inputBudgetTokens: 200_000,
  promptReserveTokens: 8_000,
  compactTriggerRatio: 0.85,
  keepRecentMessages: 8,
  keepRecentTokens: 4_000,
  compactMinMessages: 12,
  summaryModel: 'deepseek-flash',
  summaryTargetTokens: 2_000,
  summaryMaxInputTokens: 64_000,
  idleCompactMinutes: 0,
  compactCheckIntervalSeconds: 60,
  idleScanLimit: 200,
  tokenEstimator: 'mixed',
  replayMaxMessages: 4_000,
  listLimit: 30,
  messageLimit: 200,
};

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function number(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function boolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new Error(`${name} must be true or false, got ${JSON.stringify(raw)}`);
}

export function sessionConfig(env: NodeJS.ProcessEnv = process.env): SessionConfig {
  const inputBudgetTokens = integer(env, 'SESSION_INPUT_BUDGET_TOKENS', 200_000, 4_096, 2_000_000);
  const promptReserveTokens = integer(
    env,
    'SESSION_PROMPT_RESERVE_TOKENS',
    8_000,
    0,
    inputBudgetTokens - 1_024,
  );
  const summaryMaxInputTokens = integer(
    env,
    'SESSION_SUMMARY_MAX_INPUT_TOKENS',
    64_000,
    1_024,
    2_000_000,
  );
  const tokenEstimator = (env.SESSION_TOKEN_ESTIMATOR?.trim() || 'mixed') as TokenEstimatorMode;
  if (tokenEstimator !== 'mixed' && tokenEstimator !== 'chars4') {
    throw new Error('SESSION_TOKEN_ESTIMATOR must be "mixed" or "chars4"');
  }

  return {
    compactionEnabled: boolean(env, 'SESSION_COMPACTION_ENABLED', true),
    inputBudgetTokens,
    promptReserveTokens,
    compactTriggerRatio: number(env, 'SESSION_COMPACT_TRIGGER_RATIO', 0.85, 0.1, 1),
    keepRecentMessages: integer(env, 'SESSION_COMPACT_KEEP_RECENT_MESSAGES', 8, 0, 1_000),
    keepRecentTokens: integer(env, 'SESSION_COMPACT_KEEP_RECENT_TOKENS', 4_000, 0, 2_000_000),
    compactMinMessages: integer(env, 'SESSION_COMPACT_MIN_MESSAGES', 12, 2, 100_000),
    summaryModel: env.SESSION_SUMMARY_MODEL?.trim() || 'deepseek-flash',
    summaryTargetTokens: integer(env, 'SESSION_SUMMARY_TARGET_TOKENS', 2_000, 64, 8_192),
    summaryMaxInputTokens,
    idleCompactMinutes: integer(env, 'SESSION_IDLE_COMPACT_MINUTES', 0, 0, 10_080),
    compactCheckIntervalSeconds: integer(env, 'SESSION_COMPACT_CHECK_INTERVAL_SECONDS', 60, 0, 86_400),
    idleScanLimit: integer(env, 'SESSION_IDLE_SCAN_LIMIT', 200, 1, 10_000),
    tokenEstimator,
    replayMaxMessages: integer(env, 'SESSION_REPLAY_MAX_MESSAGES', 4_000, 10, 100_000),
    listLimit: integer(env, 'SESSION_LIST_LIMIT', 30, 1, 200),
    messageLimit: integer(env, 'SESSION_MESSAGE_LIMIT', 200, 1, 1_000),
  };
}

/** The usable replay budget after the system prompt and memory blocks. */
export function sessionReplayBudget(config: SessionConfig): number {
  return config.inputBudgetTokens - config.promptReserveTokens;
}
