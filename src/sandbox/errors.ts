/**
 * Sandbox error taxonomy.
 *
 * The loop turns a thrown error into a model-visible tool error, so the message
 * has to say what kind of refusal it was. "Sandbox unavailable" and "the policy
 * denied this path" call for different next actions from the model: the first is
 * "stop and tell the user", the second is "choose a path inside the workspace".
 *
 * Errors also carry a stable `code` because the Gateway maps them to audit
 * outcomes and the tests assert on the kind, not on prose.
 */

export type SandboxErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'forbidden'
  | 'approval_required'
  | 'conflict'
  | 'idempotent_replay'
  | 'runtime_unavailable'
  | 'runtime_failed'
  | 'timeout'
  | 'output_limit'
  | 'quota_exceeded'
  | 'unknown_execution';

export class SandboxError extends Error {
  override readonly name: string = 'SandboxError';
  readonly code: SandboxErrorCode;
  /** Whether the model may fix this by changing its request. */
  readonly retryable: boolean;

  constructor(code: SandboxErrorCode, message: string, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

export class SandboxPolicyError extends SandboxError {
  override readonly name: string = 'SandboxPolicyError';

  constructor(message: string) {
    super('forbidden', message, false);
  }
}

/**
 * The path/file layer's error.
 *
 * It is a `SandboxPolicyError` so callers can catch the whole family, and a
 * distinct class so a tool can tell "I refused this path" from "the sandbox was
 * unavailable" if it ever needs to.
 */
export class WorkspaceError extends SandboxPolicyError {
  override readonly name: string = 'WorkspaceError';
}

export class SandboxApprovalRequiredError extends SandboxError {
  override readonly name: string = 'SandboxApprovalRequiredError';
  /** The persisted permission request, so an operator can find it. */
  readonly requestId: string | null;
  /** The human approval queue entry, when one was opened. */
  readonly approvalRequestId: string | null;

  constructor(
    message: string,
    details: { readonly requestId?: string | null; readonly approvalRequestId?: string | null } = {},
  ) {
    super(
      'approval_required',
      details.approvalRequestId
        ? `${message} (approval ${details.approvalRequestId})`
        : message,
      false,
    );
    this.requestId = details.requestId ?? null;
    this.approvalRequestId = details.approvalRequestId ?? null;
  }
}

export class SandboxRuntimeUnavailableError extends SandboxError {
  override readonly name: string = 'SandboxRuntimeUnavailableError';

  constructor(message: string) {
    super('runtime_unavailable', message, false);
  }
}

export class SandboxNotFoundError extends SandboxError {
  override readonly name: string = 'SandboxNotFoundError';

  constructor(message: string) {
    super('not_found', message, false);
  }
}

export class SandboxConflictError extends SandboxError {
  override readonly name: string = 'SandboxConflictError';

  constructor(message: string) {
    super('conflict', message, false);
  }
}

export class SandboxQuotaError extends SandboxError {
  override readonly name: string = 'SandboxQuotaError';

  constructor(message: string) {
    super('quota_exceeded', message, false);
  }
}

/** A model-facing rendering; never a stack trace, never a secret. */
export function sandboxErrorMessage(error: unknown): string {
  if (error instanceof SandboxError) return `${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}
