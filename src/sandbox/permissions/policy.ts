/**
 * Permission policy resolution and rule evaluation.
 *
 * Pure functions only: a `SandboxPolicy` value plus persisted scope policies go
 * in, an `EffectivePermissionPolicy` value comes out. That makes the part that
 * decides precedence testable without a store, a container or a clock.
 *
 * Resolution is **not** "the narrowest scope wins". A policy layer may tighten a
 * parent or ask for an extension; it may not silently widen one. The mode of a
 * narrower scope is accepted only when it is no wider than its parent or the
 * deployment explicitly allows that mode (ADR 020 §4.2, §12.1).
 */

import { createHash } from 'node:crypto';
import type { SandboxPolicy } from '../types.ts';
import type { SandboxPermissionSettings } from '../config.ts';
import {
  type AutoReviewSettings,
  type ApprovalSettings,
  type EffectivePermissionPolicy,
  type EffectivePolicyScope,
  type PermissionEvaluationRequest,
  type PermissionMode,
  type PermissionPolicyRecord,
  type PermissionRule,
  type PermissionScopeLevel,
  type RestrictedAllowlist,
} from './types.ts';

/** Narrower modes have a lower rank. `restricted` sits just above read-only. */
const MODE_RANK: Readonly<Record<PermissionMode, number>> = {
  'read-only': 0,
  restricted: 1,
  'on-request': 2,
  auto: 3,
};

export function modeRank(mode: PermissionMode): number {
  return MODE_RANK[mode];
}

export function isNarrowerOrEqual(mode: PermissionMode, parent: PermissionMode): boolean {
  return MODE_RANK[mode] <= MODE_RANK[parent];
}

export interface DeploymentPolicyInput {
  readonly settings: SandboxPermissionSettings;
  readonly policy: SandboxPolicy;
  readonly now: Date;
}

/** The organization layer: never stored, always rebuilt from operator config. */
export function deploymentPermissionPolicy(
  input: DeploymentPolicyInput,
): PermissionPolicyRecord {
  const at = input.now.toISOString();
  return {
    policyId: `policy_org_${input.settings.organizationId}`,
    scopeType: 'organization',
    scopeId: input.settings.organizationId,
    version: 1,
    mode: input.settings.mode,
    rules: [],
    autoReview: input.settings.autoReview,
    approval: input.settings.approval,
    restricted: input.settings.restricted,
    allowedModes: input.settings.allowedModes,
    expiresAt: null,
    createdAt: at,
    updatedAt: at,
  };
}

export interface ResolvePolicyInput {
  readonly deployment: PermissionPolicyRecord;
  readonly deploymentPolicy: SandboxPolicy;
  readonly scopes: {
    readonly session?: PermissionPolicyRecord | null;
    readonly task?: PermissionPolicyRecord | null;
    readonly sandbox?: PermissionPolicyRecord | null;
  };
  readonly now: Date;
}

/**
 * The effective policy for one task/sandbox.
 *
 * Expired scope policies are ignored entirely; the platform falls back to the
 * parent rather than remembering a mode nobody renewed.
 */
export function resolveEffectivePermissionPolicy(
  input: ResolvePolicyInput,
): EffectivePermissionPolicy {
  const layers = orderedLayers(input.scopes, input.now);
  const allowedModes = input.deployment.allowedModes ?? [input.deployment.mode];

  let mode = input.deployment.mode;
  const scopes: EffectivePolicyScope[] = [
    {
      scopeType: 'organization',
      scopeId: input.deployment.scopeId,
      version: input.deployment.version,
      mode: input.deployment.mode,
      expiresAt: null,
    },
  ];
  let autoReview: AutoReviewSettings = input.deployment.autoReview;
  let approval: ApprovalSettings = input.deployment.approval;
  let restricted: RestrictedAllowlist = input.deployment.restricted;
  const rules: PermissionRule[] = [...input.deployment.rules];

  for (const layer of layers) {
    // A narrower layer can tighten freely. A wider mode is only honoured when
    // the deployment listed it as an allowed control-plane target.
    if (isNarrowerOrEqual(layer.mode, mode) || allowedModes.includes(layer.mode)) {
      mode = layer.mode;
    }
    autoReview = layer.autoReview;
    approval = layer.approval;
    restricted = layer.restricted;
    rules.push(...layer.rules);
    scopes.push({
      scopeType: layer.scopeType,
      scopeId: layer.scopeId,
      version: layer.version,
      mode,
      expiresAt: layer.expiresAt,
    });
  }

  const narrowed = narrowPolicyForMode(input.deploymentPolicy, mode, restricted);
  const digest = policyDigest(input.deployment, input.deploymentPolicy);
  const version = [
    `ppv1:${digest}`,
    `s${input.scopes.session?.version ?? 0}`,
    `t${input.scopes.task?.version ?? 0}`,
    `b${input.scopes.sandbox?.version ?? 0}`,
  ].join('.');

  return {
    mode,
    version,
    permissionVersion:
      1 +
      (input.scopes.session?.version ?? 0) +
      (input.scopes.task?.version ?? 0) +
      (input.scopes.sandbox?.version ?? 0),
    rules,
    autoReview,
    approval,
    restricted,
    sandboxPolicy: narrowed,
    scopes,
  };
}

function orderedLayers(
  scopes: ResolvePolicyInput['scopes'],
  now: Date,
): PermissionPolicyRecord[] {
  const order: [PermissionScopeLevel, PermissionPolicyRecord | null | undefined][] = [
    ['session', scopes.session],
    ['task', scopes.task],
    ['sandbox', scopes.sandbox],
  ];
  const layers: PermissionPolicyRecord[] = [];
  for (const [scopeType, policy] of order) {
    if (!policy) continue;
    if (policy.scopeType !== scopeType) continue;
    if (policy.expiresAt !== null && Date.parse(policy.expiresAt) <= now.getTime()) continue;
    layers.push(policy);
  }
  return layers;
}

/**
 * Narrow the structural policy to what the mode actually allows.
 *
 * `read-only` removes every writable prefix, which `compileRuntimeConfig` turns
 * into a read-only bind mount — the enforcement is at the mount, not in a list
 * of command names. `restricted` replaces the allow-lists with the explicit
 * whitelist and disables the shell when `run_command` is not whitelisted.
 */
export function narrowPolicyForMode(
  base: SandboxPolicy,
  mode: PermissionMode,
  restricted: RestrictedAllowlist,
): SandboxPolicy {
  if (mode === 'read-only') {
    return {
      ...base,
      filesystem: { ...base.filesystem, write: [] },
    };
  }
  if (mode !== 'restricted') return base;

  const read = intersectPrefixes(base.filesystem.read, restricted.filesystem.read);
  const write = intersectPrefixes(base.filesystem.write, restricted.filesystem.write);
  const allowedShell = restricted.allowedTools.includes('run_command') && base.process.allowShell;
  return {
    ...base,
    filesystem: {
      read,
      write,
      deny: [...base.filesystem.deny],
    },
    network: {
      mode: base.network.mode === 'none' ? 'none' : restricted.network.mode,
      allowedDomains: intersectStrings(base.network.allowedDomains, restricted.network.allowedDomains),
      allowedPorts: intersectNumbers(base.network.allowedPorts, restricted.network.allowedPorts),
    },
    process: { ...base.process, allowShell: allowedShell },
    tools: {
      allowedTools: [...restricted.allowedTools],
      deniedTools: [...base.tools.deniedTools],
    },
  };
}

/**
 * The narrower of two path-prefix sets.
 *
 * `/workspace` ∩ `/workspace/src` is `/workspace/src`: keeping the wider entry
 * would let a restricted policy read the whole workspace.
 */
export function intersectPrefixes(wide: readonly string[], narrow: readonly string[]): string[] {
  const result: string[] = [];
  for (const candidate of narrow) {
    for (const base of wide) {
      if (underAny(candidate, base)) result.push(candidate);
      else if (underAny(base, candidate)) result.push(base);
    }
  }
  return [...new Set(result)];
}

function intersectStrings(a: readonly string[], b: readonly string[]): string[] {
  if (a.length === 0 || b.length === 0) return [];
  return a.filter((entry) => b.includes(entry));
}

function intersectNumbers(a: readonly number[], b: readonly number[]): number[] {
  if (a.length === 0 || b.length === 0) return [];
  return a.filter((entry) => b.includes(entry));
}

function underAny(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix.replace(/\/+$/, '')}/`);
}

function policyDigest(deployment: PermissionPolicyRecord, policy: SandboxPolicy): string {
  const material = JSON.stringify({
    mode: deployment.mode,
    allowedModes: deployment.allowedModes,
    autoReview: deployment.autoReview,
    approval: deployment.approval,
    restricted: deployment.restricted,
    rules: deployment.rules,
    filesystem: policy.filesystem,
    network: policy.network,
    process: policy.process,
    tools: policy.tools,
  });
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

// ------------------------------------------------------------------- rules ---

export interface RuleEvaluation {
  readonly effect: 'allow' | 'deny' | 'approval_required' | 'none';
  readonly ruleId: string | null;
  readonly reason: string;
}

/**
 * Deterministic rule matching (ADR 020 §11.2).
 *
 * No model interprets the policy: a rule either matches by action, resource and
 * conditions, or it does not. `deny` is sticky across all layers; then
 * `approval_required`; then `allow`.
 */
export function evaluatePermissionRules(
  rules: readonly PermissionRule[],
  request: PermissionEvaluationRequest,
): RuleEvaluation {
  let approval: RuleEvaluation | null = null;
  let allow: RuleEvaluation | null = null;
  for (const rule of rules) {
    if (!matchesRule(rule, request)) continue;
    if (rule.effect === 'deny') {
      return {
        effect: 'deny',
        ruleId: rule.ruleId,
        reason: `rule ${rule.ruleId} denies ${request.action.operation}`,
      };
    }
    if (rule.effect === 'approval_required' && approval === null) {
      approval = {
        effect: 'approval_required',
        ruleId: rule.ruleId,
        reason: `rule ${rule.ruleId} requires approval for ${request.action.operation}`,
      };
    }
    if (rule.effect === 'allow' && allow === null) {
      allow = {
        effect: 'allow',
        ruleId: rule.ruleId,
        reason: `rule ${rule.ruleId} allows ${request.action.operation}`,
      };
    }
  }
  return approval ?? allow ?? { effect: 'none', ruleId: null, reason: 'no rule matched' };
}

function matchesRule(rule: PermissionRule, request: PermissionEvaluationRequest): boolean {
  if (rule.action.length > 0 && !rule.action.includes(request.action.operation)) return false;
  if (!matchesResource(rule, request)) return false;
  const conditions = rule.conditions;
  if (conditions?.riskLevel && conditions.riskLevel.length > 0) {
    const risk = request.context?.riskLevel;
    if (!risk || !conditions.riskLevel.includes(risk)) return false;
  }
  return true;
}

function matchesResource(rule: PermissionRule, request: PermissionEvaluationRequest): boolean {
  const patterns = rule.resource.patterns;
  if (patterns.length === 0 || patterns.includes('*')) return true;
  if (rule.resource.type === 'any') return true;
  const identifier = request.resource.identifier;
  return patterns.some((pattern) => {
    if (pattern === '*') return true;
    switch (rule.resource.type) {
      case 'tool':
        return identifier === pattern || request.action.tool === pattern;
      case 'domain':
        return identifier === pattern || identifier.endsWith(`.${pattern.replace(/^\*\./, '')}`);
      case 'path':
      case 'command':
      case 'any':
      default:
        return identifier === pattern || identifier.startsWith(`${pattern.replace(/\/+$/, '')}/`);
    }
  });
}

// ---------------------------------------------------------- scope policies ---

export type ScopePolicyOverrides = {
  readonly mode?: PermissionMode;
  readonly rules?: readonly PermissionRule[];
  readonly autoReview?: Partial<AutoReviewSettings>;
  readonly approval?: Partial<ApprovalSettings>;
  readonly restricted?: Partial<RestrictedAllowlist>;
  readonly expiresAt?: string | null;
};

/**
 * Build the next version of a scope's policy.
 *
 * A trusted control-plane command calls this; the agent cannot. The previous
 * version is copied so an unset field means "keep the current policy", not
 * "reset to the deployment default".
 */
export function nextScopePolicy(input: {
  readonly previous: PermissionPolicyRecord | null;
  readonly deployment: PermissionPolicyRecord;
  readonly scopeType: PermissionScopeLevel;
  readonly scopeId: string;
  readonly overrides: ScopePolicyOverrides;
  readonly now: Date;
}): PermissionPolicyRecord {
  const base = input.previous ?? {
    ...input.deployment,
    policyId: `policy_${input.scopeType}_${input.scopeId}`,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    version: 0,
    expiresAt: null,
  };
  const restricted = {
    ...base.restricted,
    ...input.overrides.restricted,
    filesystem: {
      ...base.restricted.filesystem,
      ...input.overrides.restricted?.filesystem,
    },
    network: {
      ...base.restricted.network,
      ...input.overrides.restricted?.network,
    },
  };
  const at = input.now.toISOString();
  const mode = input.overrides.mode ?? base.mode;
  const allowedModes = input.deployment.allowedModes ?? [input.deployment.mode];
  if (!allowedModes.includes(mode)) {
    throw new Error(
      `mode ${mode} is not allowed by the deployment (allowed: ${allowedModes.join(', ')})`,
    );
  }
  return {
    policyId: `policy_${input.scopeType}_${input.scopeId}_v${base.version + 1}`,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    version: base.version + 1,
    mode,
    rules: [...(input.overrides.rules ?? base.rules)],
    autoReview: { ...base.autoReview, ...input.overrides.autoReview },
    approval: { ...base.approval, ...input.overrides.approval },
    restricted,
    expiresAt:
      input.overrides.expiresAt === undefined ? base.expiresAt : input.overrides.expiresAt,
    createdAt: input.previous?.createdAt ?? at,
    updatedAt: at,
  };
}

/** True when a mode requires the restricted allow-list to include a tool. */
export function toolAllowedByMode(
  mode: PermissionMode,
  restricted: RestrictedAllowlist,
  tool: string,
): boolean {
  if (mode !== 'restricted') return true;
  return restricted.allowedTools.includes(tool);
}
