/**
 * Request shapes for the local permission control surface.
 *
 * The routes themselves live in `server.ts`; everything here is pure so the
 * rules can be tested without a socket, a store or a container.
 *
 * Two decisions shape this file:
 *
 *   - **The only writable setting is `mode`** (plus how long it lasts). The
 *     auto-review risk levels and the human-approval ceiling are deployment
 *     decisions. Letting a request set them would make "a narrower scope may
 *     only tighten" unenforceable from the outside, and a stale scope policy
 *     could then survive a deployment that was made stricter afterwards.
 *   - **The conversation id is the task id** (ADR 021), so one uuid validator
 *     covers both and there is no separate task lookup to get wrong.
 */

import {
  PERMISSION_MODES,
  type ApprovalScopeLevel,
  type PermissionMode,
} from '../sandbox/permissions/types.ts';

/** Preference key: the mode a newly created conversation starts in. */
export const PERMISSION_MODE_DEFAULT_KEY = 'permission.mode.default';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const APPROVAL_SCOPES: readonly ApprovalScopeLevel[] = ['once', 'task', 'session'];

const MAX_TTL_MINUTES = 24 * 60;
const MAX_REASON_CHARS = 500;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}

export interface PermissionModeOption {
  readonly id: PermissionMode;
  readonly label: string;
  readonly description: string;
}

/**
 * What each mode means *for this product*, in the person's words.
 *
 * The text says what will actually happen rather than naming the mechanism:
 * "the mount is read-only" is something a person can predict, "read-only mode"
 * is a label they have to remember. `on-request` is honest about auto-review
 * being off, because that is the only difference a person can observe.
 */
const MODE_COPY: Readonly<Record<PermissionMode, { label: string; description: string }>> = {
  'read-only': {
    label: '只读',
    description: '写文件会被拒绝，工作区以只读方式挂载。',
  },
  auto: {
    label: '自动',
    description: '工作区内的写入和命令直接执行；需要扩展时先过自动审核。',
  },
  'on-request': {
    label: '逐次确认',
    description: '需要扩展时停下来等人批准，自动审核不参与。',
  },
  restricted: {
    label: '白名单',
    description: '只有白名单里的工具和路径可用，自动审核不能扩大。',
  },
};

/** The menu, limited to what this deployment said a control plane may choose. */
export function permissionModeOptions(
  allowed: readonly PermissionMode[],
): readonly PermissionModeOption[] {
  return PERMISSION_MODES.filter((mode) => allowed.includes(mode)).map((mode) => ({
    id: mode,
    label: MODE_COPY[mode].label,
    description: MODE_COPY[mode].description,
  }));
}

export interface PermissionModeChange {
  readonly conversationId: string;
  readonly mode: PermissionMode;
  /** `null` means "until changed again"; a number is a duration in ms. */
  readonly ttlMs: number | null;
  readonly remember: boolean;
}

/**
 * Parse a mode change.
 *
 * A TTL of 30 minutes is an operator convenience, not a security control: the
 * deployment's `allowedModes` is what limits which modes exist at all.
 */
export function parsePermissionModeChange(raw: unknown): PermissionModeChange | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return 'body must be a JSON object';
  }
  const body = raw as Record<string, unknown>;

  if (!isUuid(body.conversationId)) {
    return 'field "conversationId" must be a uuid';
  }
  if (!isPermissionMode(body.mode)) {
    return `field "mode" must be one of ${PERMISSION_MODES.join(', ')}`;
  }

  let ttlMs: number | null = null;
  if (body.minutes !== undefined && body.minutes !== null) {
    if (
      typeof body.minutes !== 'number' ||
      !Number.isInteger(body.minutes) ||
      body.minutes < 1 ||
      body.minutes > MAX_TTL_MINUTES
    ) {
      return `field "minutes" must be an integer between 1 and ${MAX_TTL_MINUTES}`;
    }
    ttlMs = body.minutes * 60_000;
  }

  if (body.remember !== undefined && typeof body.remember !== 'boolean') {
    return 'field "remember" must be a boolean';
  }

  return {
    conversationId: body.conversationId,
    mode: body.mode,
    ttlMs,
    remember: body.remember === true,
  };
}

export interface ApprovalDecision {
  readonly scope: ApprovalScopeLevel;
  /** `null` keeps the grant manager's default for the chosen scope. */
  readonly ttlSeconds: number | null;
  readonly reason: string | null;
}

/** Parse an approve/deny body. An empty body is valid: "approve once". */
export function parseApprovalDecision(raw: unknown): ApprovalDecision | string {
  if (raw === undefined || raw === null) {
    return { scope: 'once', ttlSeconds: null, reason: null };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return 'body must be a JSON object';
  }
  const body = raw as Record<string, unknown>;

  const scope = body.scope ?? 'once';
  if (typeof scope !== 'string' || !(APPROVAL_SCOPES as readonly string[]).includes(scope)) {
    return `field "scope" must be one of ${APPROVAL_SCOPES.join(', ')}`;
  }

  let ttlSeconds: number | null = null;
  if (body.ttlSeconds !== undefined && body.ttlSeconds !== null) {
    if (
      typeof body.ttlSeconds !== 'number' ||
      !Number.isInteger(body.ttlSeconds) ||
      body.ttlSeconds < 1 ||
      body.ttlSeconds > MAX_TTL_MINUTES * 60
    ) {
      return 'field "ttlSeconds" must be a positive integer';
    }
    ttlSeconds = body.ttlSeconds;
  }

  let reason: string | null = null;
  if (body.reason !== undefined && body.reason !== null) {
    if (typeof body.reason !== 'string') return 'field "reason" must be a string';
    const trimmed = body.reason.trim();
    if (trimmed.length > MAX_REASON_CHARS) {
      return `field "reason" exceeds ${MAX_REASON_CHARS} characters`;
    }
    reason = trimmed.length > 0 ? trimmed : null;
  }

  return {
    scope: scope as ApprovalScopeLevel,
    ttlSeconds,
    reason,
  };
}
