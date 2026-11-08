/**
 * Deployment limits for Subagent/Agent Team.
 *
 * The numbers here are a ceiling and a default, never a claim about speed. A
 * browser or a model can lower them per team; `clampTeamConfig` makes raising
 * them impossible. Budget defaults follow the acceptance plan: 24 requests,
 * 400k input tokens, 32k output tokens for a small collaboration.
 */

import type { TeamBudgetLimits, TeamConfig, TeamLimits } from './types.ts';
import { defaultTeamConfig } from './types.ts';

function int(value: string | undefined, fallback: number, min = 1): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

function money(value: string | undefined): number | null {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function teamFeatureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TEAM_ENABLED !== '0' && env.TEAM_ENABLED !== 'false';
}

export function teamLimits(env: NodeJS.ProcessEnv = process.env): TeamLimits {
  return {
    maxMembers: int(env.TEAM_MAX_MEMBERS, 4),
    maxConcurrentModelRequests: int(env.TEAM_MAX_CONCURRENT_REQUESTS, 3),
    maxDepth: int(env.TEAM_MAX_DEPTH, 2),
    maxActivations: int(env.TEAM_MAX_ACTIVATIONS, 32),
    maxModelRequests: int(env.TEAM_MAX_MODEL_REQUESTS, 64),
    maxTasks: int(env.TEAM_MAX_TASKS, 256),
    maxMessages: int(env.TEAM_MAX_MESSAGES, 128),
    maxMessageChars: int(env.TEAM_MAX_MESSAGE_CHARS, 4_000, 64),
    maxQueuedMessagesPerMember: int(env.TEAM_MAX_QUEUED_MESSAGES, 16),
    maxAutoActivationsPerMember: int(env.TEAM_MAX_AUTO_ACTIVATIONS, 8, 0),
    maxBroadcastFanout: int(env.TEAM_MAX_BROADCAST_FANOUT, 8),
  };
}

export function teamBudget(env: NodeJS.ProcessEnv = process.env): TeamBudgetLimits {
  return {
    maxInputTokens: int(env.TEAM_MAX_INPUT_TOKENS, 400_000),
    maxOutputTokens: int(env.TEAM_MAX_OUTPUT_TOKENS, 32_000),
    maxRequests: int(env.TEAM_MAX_REQUESTS, 24),
    maxEstimatedCostUsd: money(env.TEAM_MAX_COST_USD),
  };
}

/** The deployment ceiling, used both for a new team and for clamping updates. */
export function teamCeiling(
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
): TeamConfig {
  const base = defaultTeamConfig(modelId);
  return {
    ...base,
    limits: teamLimits(env),
    budget: teamBudget(env),
  };
}
