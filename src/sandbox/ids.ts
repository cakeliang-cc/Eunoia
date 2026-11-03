/**
 * Identifier checks shared by the Gateway and its collaborators.
 *
 * A task id is the conversation id, so it arrives from the server rather than
 * from a tool argument; that is an ownership property, not just validation. The
 * length bound keeps an oversized id out of log lines and audit rows.
 */

import { SandboxPolicyError } from './errors.ts';

export const MAX_TASK_ID = 200;

export function assertId(label: string, value: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TASK_ID) {
    throw new SandboxPolicyError(`${label} must be a non-empty string`);
  }
}
