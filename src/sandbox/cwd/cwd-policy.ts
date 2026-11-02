/**
 * Which directories a task may sit in (ADR 021 §9).
 *
 * Two properties are load-bearing:
 *
 *   - **A directory change is not a permission grant.** Standing in
 *     `/workspace/secrets` must not make a write there allowed; the file tools
 *     re-ask the permission layer per path. This module therefore only answers
 *     "is this directory inside the readable workspace the current mode allows",
 *     never "so may I write here".
 *   - **The mode narrows, it never widens.** `read-only` and `restricted` already
 *     intersected the readable prefixes in `narrowPolicyForMode`; this check reads
 *     that narrowed policy, so it cannot reintroduce a directory the mode removed.
 */

import { WORKSPACE_MOUNT_PATH, type SandboxPolicy } from '../types.ts';
import type { PermissionMode, RestrictedAllowlist } from '../permissions/types.ts';
import { isWithinRoot } from './cwd-path.ts';

export interface CwdPolicyDecision {
  readonly allowed: boolean;
  readonly reason: string;
  /** Set when the refusal has a stable error code of its own. */
  readonly code?: 'PATH_OUTSIDE_WORKSPACE' | 'PERMISSION_DENIED';
}

export interface CwdPolicyInput {
  readonly mode: PermissionMode;
  readonly sandboxPolicy: SandboxPolicy;
  readonly restricted?: RestrictedAllowlist;
  /** Container path the agent asked for. */
  readonly cwd: string;
  readonly workspaceRoot?: string;
}

/**
 * Decide whether the task may move into `cwd`.
 *
 * The mode is passed for the audit trail and for the read-only message; the
 * effective decision comes from the narrowed structural policy, which is the same
 * policy the runtime was compiled from.
 */
export function authorizeCwdChange(input: CwdPolicyInput): CwdPolicyDecision {
  const root = input.workspaceRoot ?? WORKSPACE_MOUNT_PATH;
  if (!isWithinRoot(root, input.cwd)) {
    return {
      allowed: false,
      reason: 'the requested directory is outside the task workspace',
      code: 'PATH_OUTSIDE_WORKSPACE',
    };
  }

  const denied = input.sandboxPolicy.filesystem.deny.some(
    (prefix) => input.cwd === prefix || input.cwd.startsWith(`${prefix.replace(/\/+$/, '')}/`),
  );
  if (denied) {
    return {
      allowed: false,
      reason: 'the requested directory is on the system deny list',
      code: 'PERMISSION_DENIED',
    };
  }

  const readable = input.sandboxPolicy.filesystem.read;
  const covered = readable.some(
    (prefix) => input.cwd === prefix || input.cwd.startsWith(`${prefix.replace(/\/+$/, '')}/`),
  );
  if (!covered) {
    return {
      allowed: false,
      code: 'PERMISSION_DENIED',
      reason:
        input.mode === 'restricted'
          ? 'restricted mode allows only directories on its read allow-list'
          : `the requested directory is outside the ${input.mode} read scope`,
    };
  }

  if (input.mode === 'restricted' && input.restricted) {
    const restrictedRead = input.restricted.filesystem.read;
    if (restrictedRead.length === 0) {
      return {
        allowed: false,
        reason: 'restricted mode has no readable directories',
        code: 'PERMISSION_DENIED',
      };
    }
  }

  return { allowed: true, reason: `${input.mode} mode permits this directory` };
}
