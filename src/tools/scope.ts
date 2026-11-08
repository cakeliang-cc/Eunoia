/**
 * The execution identity and capability ceiling a tool call runs under.
 *
 * A tool name is not an authorization. The same `bash` or `browser_navigate`
 * means something different for the deployment, the person, a root run, a
 * parent member, the current member and one task attempt. This module is the
 * one place that answers "who is calling, under which ceiling", so builtin and
 * MCP tools cannot each invent a weaker check.
 *
 * The ceiling is *intersected*, never replaced: a member can ask for less than
 * its parent, never more. A call is revalidated against the current member
 * record immediately before execution, which is what makes "approve, then
 * tighten permissions, then reuse the old tool handle" fail closed.
 *
 * See docs/adr/033-mcp-host.md §8 and docs/plans/eunoia-联调缺口与受控网络整改清单.md R02.
 */

import { createHash } from 'node:crypto';
import { isAbsolute, posix, resolve } from 'node:path';
import type { ToolDefinition, ToolResult } from './types.ts';
import { toolError } from './types.ts';
import type { McpToolClassification } from '../mcp/types.ts';

export type ExecutionRole = 'root' | 'member';

export interface ExecutionIdentity {
  readonly userId: string;
  readonly conversationId: string;
  /** The user-facing conversation a member question/approval belongs to. */
  readonly rootConversationId?: string;
  readonly role: ExecutionRole;
  readonly teamId?: string;
  readonly runId?: string;
  readonly memberId?: string;
  readonly activationId?: string;
  readonly taskAttemptId?: string;
  /** Activation/approval generation. A stale generation may not act. */
  readonly generation?: number;
}

export type NetworkCeiling =
  | { readonly mode: 'any' }
  | { readonly mode: 'none' }
  | {
      readonly mode: 'allowlist';
      readonly domains: readonly string[];
      readonly ports: readonly number[];
    };

export interface McpCeiling {
  /** Null means "inherit the parent's servers"; an empty array means none. */
  readonly servers: readonly string[] | null;
  /** Null means "every tool on an allowed server"; an empty array means none. */
  readonly tools: readonly string[] | null;
  readonly externalWrite: boolean;
  readonly externalUnknown: boolean;
  /** Catalog identity (account/scope) allowed to be used; null means any. */
  readonly accounts: readonly string[] | null;
}

export interface ExecutionCapabilities {
  /** Null means every builtin tool; an empty array means none. */
  readonly tools: readonly string[] | null;
  /** Workspace-relative roots. A member cannot widen these. */
  readonly paths: {
    readonly read: readonly string[];
    readonly write: readonly string[];
  };
  readonly commands: boolean;
  readonly network: NetworkCeiling;
  readonly mcp: McpCeiling;
}

export interface ExecutionScope {
  readonly identity: ExecutionIdentity;
  readonly capabilities: ExecutionCapabilities;
}

/**
 * The deployment/root ceiling.
 *
 * `network: any` is the root's current network policy (the sandbox still
 * enforces `none`/`proxy_only`). A member starts from `none` unless a parent
 * explicitly passes an allowlist: absence of evidence is not permission.
 */
export function rootExecutionScope(input: {
  readonly userId: string;
  readonly conversationId: string;
}): ExecutionScope {
  return {
    identity: {
      userId: input.userId,
      conversationId: input.conversationId,
      rootConversationId: input.conversationId,
      role: 'root',
    },
    capabilities: {
      tools: null,
      paths: { read: ['/workspace'], write: ['/workspace'] },
      commands: true,
      network: { mode: 'any' },
      mcp: {
        servers: null,
        tools: null,
        externalWrite: true,
        externalUnknown: true,
        accounts: null,
      },
    },
  };
}

export interface MemberScopeInput {
  readonly userId: string;
  readonly teamId: string;
  readonly runId: string;
  readonly memberId: string;
  readonly conversationId: string;
  readonly rootConversationId?: string;
  readonly activationId?: string;
  readonly taskAttemptId?: string;
  readonly generation?: number;
  readonly permissions: {
    readonly allowWorkspaceWrites: boolean;
    readonly allowCommands: boolean;
    readonly allowedTools: readonly string[] | null;
    readonly mcp?: {
      readonly servers?: readonly string[] | null;
      readonly tools?: readonly string[] | null;
      readonly externalWrite?: boolean;
      readonly externalUnknown?: boolean;
      readonly accounts?: readonly string[] | null;
    };
  };
  /** The parent's ceiling. Absent means the root ceiling for this person. */
  readonly parent?: ExecutionCapabilities;
}

/**
 * Derive a member scope from its permissions and the parent ceiling.
 *
 * Defaults are deliberately narrow: a member that did not ask for MCP gets no
 * external tools, and a member without command permission cannot approve its
 * way into one.
 */
export function memberExecutionScope(input: MemberScopeInput): ExecutionScope {
  const parent = input.parent ?? rootCapabilities();
  const parentMcp = parent.mcp;
  const requested = input.permissions.mcp;
  const tools = intersectNullable(parent.tools, input.permissions.allowedTools);
  const mcpTools = intersectNullable(parentMcp.tools, requested?.tools ?? null);
  const mcpServers = intersectNullable(parentMcp.servers, requested?.servers ?? null);
  return {
    identity: {
      userId: input.userId,
      conversationId: input.conversationId,
      ...(input.rootConversationId ? { rootConversationId: input.rootConversationId } : {}),
      role: 'member',
      teamId: input.teamId,
      runId: input.runId,
      memberId: input.memberId,
      ...(input.activationId ? { activationId: input.activationId } : {}),
      ...(input.taskAttemptId ? { taskAttemptId: input.taskAttemptId } : {}),
      ...(input.generation !== undefined ? { generation: input.generation } : {}),
    },
    capabilities: {
      tools,
      paths: {
        read: intersectRoots(parent.paths.read, ['/workspace']),
        write: input.permissions.allowWorkspaceWrites
          ? intersectRoots(parent.paths.write, ['/workspace'])
          : [],
      },
      commands: input.permissions.allowCommands && parent.commands,
      network:
        parent.network.mode === 'none'
          ? { mode: 'none' }
          : parent.network.mode === 'allowlist'
            ? {
                mode: 'allowlist',
                domains: parent.network.domains,
                ports: parent.network.ports,
              }
            : { mode: 'any' },
      mcp: {
        // `null` inherits the parent's list, which for a root is "all servers".
        // A member still has to be granted an external write explicitly.
        servers: mcpServers,
        tools: mcpTools,
        externalWrite: (requested?.externalWrite ?? false) && parentMcp.externalWrite,
        externalUnknown: (requested?.externalUnknown ?? false) && parentMcp.externalUnknown,
        accounts: intersectNullable(parentMcp.accounts, requested?.accounts ?? null),
      },
    },
  };
}

export function rootCapabilities(): ExecutionCapabilities {
  return rootExecutionScope({ userId: '', conversationId: '' }).capabilities;
}

/** Stable digest of what a member was allowed at registration time. */
export function scopeFingerprint(scope: ExecutionScope): string {
  return createHash('sha256').update(stableJson(scope)).digest('hex');
}

/** True when `next` is at least as narrow as `previous` on every axis. */
export function scopeIsWithin(next: ExecutionScope, previous: ExecutionScope): boolean {
  const a = previous.capabilities;
  const b = next.capabilities;
  return (
    subset(b.tools, a.tools) &&
    subset(b.mcp.servers, a.mcp.servers) &&
    subset(b.mcp.tools, a.mcp.tools) &&
    (!b.commands || a.commands) &&
    b.paths.read.every((root) => a.paths.read.includes(root)) &&
    b.paths.write.every((root) => a.paths.write.includes(root)) &&
    (!b.mcp.externalWrite || a.mcp.externalWrite) &&
    (!b.mcp.externalUnknown || a.mcp.externalUnknown) &&
    networkWithin(b.network, a.network)
  );
}

export interface McpScopeCheck {
  readonly serverId: string;
  readonly toolName: string;
  readonly classification: McpToolClassification;
  readonly arguments: Record<string, unknown>;
  readonly account: string | null;
}

export type ScopeDecision = { readonly ok: true } | { readonly ok: false; readonly reason: string; readonly code: string };

/** Whether the scope may use one particular external tool with these args. */
export function checkMcpScope(scope: ExecutionScope, input: McpScopeCheck): ScopeDecision {
  const mcp = scope.capabilities.mcp;
  if (mcp.servers !== null && !mcp.servers.includes(input.serverId)) {
    return deny('MCP_SCOPE_SERVER', '这个成员没有被授予该外部服务，调用已拒绝。');
  }
  if (mcp.tools !== null && !mcp.tools.includes(input.toolName)) {
    return deny('MCP_SCOPE_TOOL', `这个成员没有被授予外部工具 ${input.toolName}，调用已拒绝。`);
  }
  if (mcp.accounts !== null && input.account !== null && !mcp.accounts.includes(input.account)) {
    return deny('MCP_SCOPE_ACCOUNT', '外部服务账号不在这个成员允许的范围内，调用已拒绝。');
  }
  if (input.classification === 'external_write' && !mcp.externalWrite) {
    return deny('MCP_SCOPE_WRITE', '这个成员没有外部写入权限，调用已拒绝。');
  }
  if (input.classification === 'external_unknown' && !mcp.externalUnknown) {
    return deny(
      'MCP_SCOPE_UNKNOWN',
      '这个外部工具的副作用无法被本地约束，受限成员不能调用；请由根执行或显式授权。',
    );
  }
  const targets = networkTargets(input.arguments);
  const network = scope.capabilities.network;
  if (targets.length > 0) {
    if (network.mode === 'none') {
      return deny('MCP_SCOPE_NETWORK', '这个成员没有网络权限，带网络目标的调用已拒绝。');
    }
    if (network.mode === 'allowlist') {
      for (const target of targets) {
        if (!domainAllowed(target.host, network.domains) || !portAllowed(target.port, network.ports)) {
          return deny(
            'MCP_SCOPE_NETWORK',
            `目标 ${target.host}${target.port ? `:${target.port}` : ''} 不在这个成员的授权网络范围内，调用已拒绝。`,
          );
        }
      }
    }
  }
  // Generic MCP has no way to enforce arbitrary path arguments. A path-bearing
  // call is only allowed when the tool was explicitly granted *and* every
  // absolute path lies inside the member's read roots. Otherwise the honest
  // answer is refusal, not a comment claiming a check that does not exist.
  const paths = pathArguments(input.arguments);
  if (paths.length > 0) {
    const roots = scope.capabilities.paths.read;
    for (const path of paths) {
      if (!withinRoots(path, roots)) {
        return deny(
          'MCP_SCOPE_PATH',
          `外部工具参数中的路径 ${path} 超出这个成员的工作区范围，调用已拒绝。`,
        );
      }
    }
  }
  return { ok: true };
}

function deny(code: string, reason: string): ScopeDecision {
  return { ok: false, code, reason };
}

/**
 * Wrap one tool so the scope is checked immediately before execution.
 *
 * Registration-time filtering is not enough: a member's permissions can be
 * tightened, a server can reconnect with a wider catalog, and an old handle can
 * outlive the decision that created it. `revalidate` returns the *current*
 * scope; a fingerprint change fails closed.
 */
export function guardToolForScope(
  tool: ToolDefinition,
  scope: ExecutionScope,
  revalidate?: () => Promise<ExecutionScope>,
): ToolDefinition {
  const fingerprint = scopeFingerprint(scope);
  return {
    ...tool,
    async execute(args, context): Promise<ToolResult> {
      if (!toolAllowed(scope, tool.name)) {
        return toolError(`工具 ${tool.name} 不在这个执行身份的授权范围内，调用已拒绝。`, {
          code: 'EXECUTION_SCOPE_TOOL',
        });
      }
      if (revalidate) {
        let current: ExecutionScope;
        try {
          current = await revalidate();
        } catch (error) {
          return toolError(
            `执行身份已经失效，调用已拒绝：${error instanceof Error ? error.message : String(error)}`,
            { code: 'EXECUTION_SCOPE_STALE' },
          );
        }
        if (scopeFingerprint(current) !== fingerprint) {
          return toolError(
            '执行身份或权限在这次调用前发生了变化；旧工具句柄不能再使用，请重新发起。',
            { code: 'EXECUTION_SCOPE_CHANGED' },
          );
        }
      }
      const contract = tool.contract;
      if (contract?.source === 'mcp' && contract.origin?.kind === 'mcp') {
        const check = checkMcpScope(scope, {
          serverId: contract.origin.serverId,
          toolName: contract.origin.originalName,
          classification: contract.origin.classification,
          arguments: (args ?? {}) as Record<string, unknown>,
          account: null,
        });
        if (!check.ok) {
          return toolError(check.reason, { code: check.code });
        }
      }
      return tool.execute(args, context);
    },
  };
}

export function toolAllowed(scope: ExecutionScope, name: string): boolean {
  const tools = scope.capabilities.tools;
  return tools === null || tools.includes(name);
}

// ----------------------------------------------------------------- helpers ---

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
}

function intersectNullable(
  parent: readonly string[] | null,
  requested: readonly string[] | null,
): readonly string[] | null {
  if (parent === null) return requested === null ? null : [...requested];
  if (requested === null) return [...parent];
  return requested.filter((entry) => parent.includes(entry));
}

function intersectRoots(parent: readonly string[], requested: readonly string[]): readonly string[] {
  const roots = requested.filter((root) => parent.some((allowed) => rootWithin(root, allowed)));
  return roots.length > 0 ? roots : parent;
}

function subset(next: readonly string[] | null, previous: readonly string[] | null): boolean {
  if (previous === null) return true;
  if (next === null) return false;
  return next.every((entry) => previous.includes(entry));
}

function networkWithin(next: NetworkCeiling, previous: NetworkCeiling): boolean {
  if (previous.mode === 'any') return true;
  if (previous.mode === 'none') return next.mode === 'none';
  if (next.mode !== 'allowlist') return false;
  return (
    next.domains.every((domain) => previous.domains.includes(domain)) &&
    next.ports.every((port) => previous.ports.includes(port))
  );
}

function rootWithin(root: string, allowed: string): boolean {
  const a = posix.normalize(root.replace(/\\/g, '/'));
  const b = posix.normalize(allowed.replace(/\\/g, '/'));
  return a === b || a.startsWith(`${b.replace(/\/$/, '')}/`);
}

export function withinRoots(path: string, roots: readonly string[]): boolean {
  const normalized = posix.normalize(path.replace(/\\/g, '/'));
  return roots.some((root) => {
    const base = posix.normalize(root.replace(/\\/g, '/'));
    if (base === '.') return !normalized.startsWith('../') && !normalized.startsWith('/');
    if (isAbsolute(normalized)) return normalized === base || normalized.startsWith(`${base}/`);
    return normalized === '.' || normalized.startsWith(`${base}/`);
  });
}

export interface NetworkTarget {
  readonly host: string;
  readonly port: number | null;
}

/** Extract URL/host-like values from tool arguments, without guessing types. */
export function networkTargets(value: unknown, depth = 0): NetworkTarget[] {
  if (depth > 4) return [];
  const targets: NetworkTarget[] = [];
  if (Array.isArray(value)) {
    for (const entry of value) targets.push(...networkTargets(entry, depth + 1));
    return targets;
  }
  if (value === null || typeof value !== 'object') return [];
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string' && /url|uri|href|endpoint|host|domain/i.test(key)) {
      const target = parseTarget(entry);
      if (target) targets.push(target);
      continue;
    }
    targets.push(...networkTargets(entry, depth + 1));
  }
  return targets;
}

function parseTarget(raw: string): NetworkTarget | null {
  const value = raw.trim();
  if (value.length === 0) return null;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
    const url = new URL(withScheme);
    if (!url.hostname) return null;
    const port = url.port
      ? Number(url.port)
      : url.protocol === 'https:'
        ? 443
        : url.protocol === 'http:'
          ? 80
          : null;
    return { host: url.hostname.toLowerCase(), port };
  } catch {
    return null;
  }
}

function domainAllowed(host: string, domains: readonly string[]): boolean {
  return domains.some((entry) => {
    const domain = entry.toLowerCase().trim();
    return host === domain || (domain.startsWith('*.') && host.endsWith(domain.slice(1))) ||
      (domain.startsWith('.') && host.endsWith(domain));
  });
}

function portAllowed(port: number | null, ports: readonly number[]): boolean {
  return port === null || ports.length === 0 || ports.includes(port);
}

/** Absolute path-like argument values, for the generic MCP path check. */
export function pathArguments(value: unknown, depth = 0): string[] {
  if (depth > 4) return [];
  const paths: string[] = [];
  if (Array.isArray(value)) {
    for (const entry of value) paths.push(...pathArguments(entry, depth + 1));
    return paths;
  }
  if (value === null || typeof value !== 'object') return [];
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string' && /^(path|file|filename|dir|directory|cwd|root)$/i.test(key)) {
      if (isAbsolute(entry)) paths.push(resolve(entry));
      continue;
    }
    paths.push(...pathArguments(entry, depth + 1));
  }
  return paths;
}
