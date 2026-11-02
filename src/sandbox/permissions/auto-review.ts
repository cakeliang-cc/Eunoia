/**
 * Auto-review: a bounded, deterministic risk assessment.
 *
 * ADR 020 §6 makes auto-review a *risk assessor*, not an executor and not a
 * policy author. This implementation is deliberately not a model call:
 *
 *   - it answers a closed set of questions about a request;
 *   - it never parses free text into a decision;
 *   - the same request always gets the same answer.
 *
 * A deployment may inject a model-backed `AutoReviewer` (the port is in
 * `types.ts`), but `AutoReviewService` re-checks whatever it returns against the
 * policy, so a hallucinated "approve critical" is downgraded rather than
 * honoured. That second check is the reason a custom reviewer cannot become a
 * new security boundary.
 *
 * Untrusted text (the agent's reason, command text, file/web/MCP content) is
 * kept in `AutoReviewRequest.untrusted` and only *scanned* for obvious
 * instruction-like patterns. A hit escalates; it never approves.
 */

import type {
  AutoReviewDecision,
  AutoReviewRequest,
  AutoReviewer,
  EffectivePermissionPolicy,
  PermissionEvaluationRequest,
  PermissionScope,
  RiskLevel,
} from './types.ts';

export interface RiskAssessment {
  readonly level: RiskLevel;
  readonly reasons: readonly string[];
  /** A system-level or host-level red flag: never auto-approvable. */
  readonly forbidden: boolean;
  /** Instruction-like text was found in an untrusted field. */
  readonly injectionSuspected: boolean;
}

const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
  /disregard\s+(the\s+)?(policy|rules?|system)/i,
  /you\s+are\s+now\s+(an?\s+)?(admin|root|operator|system)/i,
  /(approve|grant)\s+(this|the)\s+(request|permission)\s+(immediately|without)/i,
  /^\s*(system|assistant|developer)\s*:/im,
  /<\/?(system|instructions?)>/i,
  /\bBEGIN\s+SYSTEM\b/i,
];

const FORBIDDEN_COMMAND_PATTERNS: readonly RegExp[] = [
  /(^|[\s;&|])(sudo|doas)\s/i,
  /(^|[\s;&|])(mount|umount|nsenter|unshare|chroot|pivot_root)\s/i,
  /(^|[\s;&|])(docker|podman|nerdctl|ctr|crictl)\s/i,
  /\/var\/run\/(docker|containerd)\.sock/,
  /\/proc\/(self|\d+)\/(root|ns)/,
  /(^|[\s;&|])(insmod|modprobe|kexec|bpf|setcap)\s/i,
  /\brm\s+-[a-z]*[rf][a-z]*\s+\/(\s|$)/i,
  /\/etc\/(shadow|gshadow|sudoers)/,
];

const HIGH_RISK_COMMAND_PATTERNS: readonly RegExp[] = [
  /(^|[\s;&|])(curl|wget|nc|netcat|ssh|scp|socat)\s/i,
  /(^|[\s;&|])(pip|pip3|npm|pnpm|yarn|gem|cargo|go)\s+(install|add|get)\b/i,
  /(^|[\s;&|])git\s+push\b/i,
  /(^|[\s;&|])(chmod|chown)\s+(-R\s+)?[0-7]{3,4}\s/i,
  /(^|[\s;&|])eval\s/i,
  /\|\s*(sh|bash|zsh)\b/,
  /\bbase64\s+-d\b/i,
  /\b(openssl|gpg)\s+enc\b/i,
];

const PRIVATE_HOST_PATTERNS: readonly RegExp[] = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^\[?::1\]?$/,
  /^\[?fc[0-9a-f]{2}:/i,
  /^\[?fe80:/i,
  /^metadata\./i,
  /^169\.254\.169\.254$/,
];

/**
 * Classify one request.
 *
 * The mapping is intentionally conservative: `process.exec` is `medium` even for
 * a harmless command, because the command runs inside a workspace and can write
 * files. Anything that reaches the host, the container runtime or a private
 * network is `critical` and `forbidden`.
 */
export function assessPermissionRequest(
  request: PermissionEvaluationRequest,
  now: Date = new Date(),
): RiskAssessment {
  void now;
  const reasons: string[] = [];
  const text = untrustedText(request);
  const injectionSuspected = INJECTION_PATTERNS.some((pattern) => pattern.test(text));
  if (injectionSuspected) reasons.push('untrusted input contains instruction-like text');

  const operation = request.action.operation;
  const identifier = request.resource.identifier;

  if (operation === 'fs.read' || operation === 'fs.list') {
    return {
      level: injectionSuspected ? 'high' : 'low',
      reasons: [...reasons, 'read-only workspace access'],
      forbidden: false,
      injectionSuspected,
    };
  }

  if (operation === 'fs.write') {
    const forbidden = isSystemPath(identifier);
    return {
      level: forbidden ? 'critical' : injectionSuspected ? 'high' : 'low',
      reasons: [...reasons, forbidden ? 'write outside the workspace' : 'workspace write'],
      forbidden,
      injectionSuspected,
    };
  }

  if (operation === 'network.connect') {
    const host = hostOf(identifier);
    const forbidden = isSystemPath(identifier) || PRIVATE_HOST_PATTERNS.some((p) => p.test(host));
    return {
      level: forbidden ? 'critical' : 'medium',
      reasons: [
        ...reasons,
        forbidden ? `network target ${host} is private or metadata` : `network target ${host}`,
      ],
      forbidden,
      injectionSuspected,
    };
  }

  if (operation === 'process.exec') {
    const command = request.context?.command ?? '';
    const forbidden = FORBIDDEN_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
    const high = HIGH_RISK_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
    return {
      level: forbidden ? 'critical' : injectionSuspected ? 'high' : high ? 'high' : 'medium',
      reasons: [
        ...reasons,
        forbidden ? 'command matches a host-level denial' : high ? 'command has side effects' : 'workspace command',
      ],
      forbidden,
      injectionSuspected,
    };
  }

  return {
    level: injectionSuspected ? 'high' : 'medium',
    reasons: [...reasons, 'tool invocation'],
    forbidden: false,
    injectionSuspected,
  };
}

function untrustedText(request: PermissionEvaluationRequest): string {
  const pieces: string[] = [];
  if (request.context?.reason) pieces.push(request.context.reason);
  if (request.context?.command) pieces.push(request.context.command);
  if (request.context?.metadata) {
    try {
      pieces.push(JSON.stringify(request.context.metadata));
    } catch {
      // A circular metadata object is not evidence of anything; ignore it.
    }
  }
  return pieces.join('\n');
}

function isSystemPath(value: string): boolean {
  return (
    value.startsWith('/etc/') ||
    value === '/etc' ||
    value.startsWith('/proc') ||
    value.startsWith('/sys') ||
    value.startsWith('/dev') ||
    value.startsWith('/root') ||
    value.startsWith('/boot') ||
    value.includes('docker.sock') ||
    value.includes('containerd.sock')
  );
}

function hostOf(identifier: string): string {
  try {
    const withScheme = identifier.includes('://') ? identifier : `https://${identifier}`;
    return new URL(withScheme).hostname.toLowerCase();
  } catch {
    return identifier.toLowerCase();
  }
}

/**
 * The default reviewer.
 *
 * It approves only when every one of these holds:
 *
 *   1. the request is not a host/system-level red flag;
 *   2. no instruction-like text was found in an untrusted field;
 *   3. the mode is not `restricted` (ADR 020 §3.5 forbids auto-widening);
 *   4. the risk level is in the policy's allowed set;
 *   5. the risk level is not one the policy sends to a human;
 *   6. the requested duration fits the auto-review TTL.
 *
 * Otherwise it escalates. It never returns `deny` for an ordinary extension — a
 * human is the safer default — but it does deny a forbidden request outright.
 */
export class DeterministicAutoReviewer implements AutoReviewer {
  async review(request: AutoReviewRequest): Promise<AutoReviewDecision> {
    const assessment = assessAutoReviewRequest(request);
    if (assessment.forbidden) {
      return { result: 'deny', reason: assessment.reasons.join('; '), riskLevel: assessment.level };
    }
    if (assessment.injectionSuspected) {
      return {
        result: 'escalate',
        reason: 'untrusted input contains instruction-like text',
        riskLevel: assessment.level,
      };
    }
    if (request.policyConstraints.restricted) {
      return {
        result: 'escalate',
        reason: 'restricted mode never widens automatically',
        riskLevel: assessment.level,
      };
    }
    if (!request.policyConstraints.allowedRiskLevels.includes(assessment.level)) {
      return {
        result: 'escalate',
        reason: `risk ${assessment.level} is outside the auto-approved levels`,
        riskLevel: assessment.level,
      };
    }
    if (request.policyConstraints.humanRequiredRiskLevels.includes(assessment.level)) {
      return {
        result: 'escalate',
        reason: `risk ${assessment.level} requires a human decision`,
        riskLevel: assessment.level,
      };
    }
    if (request.requestedPermission.durationSeconds > request.policyConstraints.maxTtlSeconds) {
      return {
        result: 'escalate',
        reason: 'requested duration exceeds the auto-review TTL',
        riskLevel: assessment.level,
      };
    }
    return {
      result: 'approve',
      reason: assessment.reasons.join('; ') || 'low-risk extension within policy',
      riskLevel: assessment.level,
      approvedScope: {
        action: request.requestedPermission.action,
        resource: request.requestedPermission.resource,
        scope: [...request.requestedPermission.scope],
        durationSeconds: Math.min(
          request.requestedPermission.durationSeconds,
          request.policyConstraints.maxTtlSeconds,
        ),
      },
      expiresAt: new Date(
        Date.now() + Math.min(request.requestedPermission.durationSeconds, request.policyConstraints.maxTtlSeconds) * 1_000,
      ).toISOString(),
    };
  }
}

function assessAutoReviewRequest(request: AutoReviewRequest): RiskAssessment {
  const fake: PermissionEvaluationRequest = {
    requestId: request.permissionRequestId,
    sessionId: request.sessionId,
    taskId: request.taskId,
    principal: { type: 'agent', id: 'auto-review' },
    action: { tool: request.executionContext.toolName, operation: request.requestedPermission.action },
    resource: {
      type: request.requestedPermission.action === 'network.connect' ? 'domain' : 'path',
      identifier: request.requestedPermission.resource,
    },
    context: {
      ...(request.executionContext.command ? { command: request.executionContext.command } : {}),
    },
  };
  const base = assessPermissionRequest(fake);
  const injectionSuspected =
    base.injectionSuspected ||
    request.untrusted.some((text) => INJECTION_PATTERNS.some((pattern) => pattern.test(text)));
  return {
    ...base,
    injectionSuspected,
    reasons: injectionSuspected
      ? [...base.reasons, 'untrusted input contains instruction-like text']
      : base.reasons,
  };
}

export interface AutoReviewOutcome {
  readonly decision: AutoReviewDecision;
  readonly riskLevel: RiskLevel;
}

/**
 * The service the permission manager calls.
 *
 * `review()` builds the request, runs the reviewer and then re-validates the
 * answer. A reviewer that returns `approve` for a forbidden request, a wider
 * scope than requested, or a longer TTL is downgraded to `escalate`; the reason
 * is preserved for the audit trail.
 */
export class AutoReviewService {
  private readonly reviewer: AutoReviewer;

  constructor(reviewer: AutoReviewer = new DeterministicAutoReviewer()) {
    this.reviewer = reviewer;
  }

  async review(input: {
    readonly request: PermissionEvaluationRequest;
    readonly effective: EffectivePermissionPolicy;
    readonly permissionRequestId: string;
    readonly grantIds: readonly string[];
    readonly durationSeconds?: number;
    readonly now: Date;
  }): Promise<AutoReviewOutcome> {
    const assessment = assessPermissionRequest(input.request, input.now);
    const durationSeconds = Math.min(
      input.durationSeconds ?? 10 * 60,
      Math.floor(input.effective.autoReview.maxTtlMs / 1_000),
    );
    const scope = input.request.resource.scope ?? [input.request.resource.identifier];
    const autoReviewRequest: AutoReviewRequest = {
      permissionRequestId: input.permissionRequestId,
      taskId: input.request.taskId,
      sessionId: input.request.sessionId,
      taskDescription: `task ${input.request.taskId}`,
      requestedPermission: {
        action: input.request.action.operation,
        resource: input.request.resource.identifier,
        scope,
        durationSeconds,
      },
      currentPermissions: {
        mode: input.effective.mode,
        permissionPolicyVersion: input.effective.version,
        grantIds: [...input.grantIds],
      },
      executionContext: {
        toolName: input.request.action.tool,
        ...(input.request.context?.command ? { command: input.request.context.command } : {}),
        ...(input.request.context?.cwd ? { workingDirectory: input.request.context.cwd } : {}),
        ...(input.request.action.operation === 'network.connect'
          ? { networkTargets: [input.request.resource.identifier] }
          : {}),
      },
      policyConstraints: {
        allowedRiskLevels: input.effective.autoReview.allowedRiskLevels,
        maxTtlSeconds: Math.floor(input.effective.autoReview.maxTtlMs / 1_000),
        humanRequiredRiskLevels: input.effective.approval.requireHumanForRiskLevels,
        restricted: input.effective.mode === 'restricted',
      },
      untrusted: [
        input.request.context?.reason ?? '',
        input.request.context?.command ?? '',
        JSON.stringify(input.request.context?.metadata ?? {}),
      ].filter((entry) => entry.length > 0),
    };

    const raw = await this.reviewer.review(autoReviewRequest);
    const decision = this.revalidate(raw, autoReviewRequest, assessment);
    if (decision.result === 'approve') {
      // The caller's clock is authoritative; a reviewer does not get to choose
      // a wall-clock expiry that ignores the test/operator clock.
      return {
        decision: {
          ...decision,
          expiresAt: new Date(
            input.now.getTime() + decision.approvedScope.durationSeconds * 1_000,
          ).toISOString(),
        },
        riskLevel: decision.riskLevel,
      };
    }
    return { decision, riskLevel: decision.riskLevel ?? assessment.level };
  }

  private revalidate(
    decision: AutoReviewDecision,
    request: AutoReviewRequest,
    assessment: RiskAssessment,
  ): AutoReviewDecision {
    if (decision.result !== 'approve') {
      return { ...decision, riskLevel: decision.riskLevel ?? assessment.level };
    }
    if (assessment.forbidden) {
      return {
        result: 'escalate',
        reason: 'auto-review approved a forbidden request; escalated instead',
        riskLevel: assessment.level,
      };
    }
    if (assessment.injectionSuspected) {
      return {
        result: 'escalate',
        reason: 'auto-review ran on instruction-like text; escalated instead',
        riskLevel: assessment.level,
      };
    }
    if (request.policyConstraints.restricted) {
      return {
        result: 'escalate',
        reason: 'restricted mode never widens automatically',
        riskLevel: decision.riskLevel ?? assessment.level,
      };
    }
    if (!request.policyConstraints.allowedRiskLevels.includes(decision.riskLevel)) {
      return {
        result: 'escalate',
        reason: 'auto-review approved a risk level outside the policy',
        riskLevel: decision.riskLevel,
      };
    }
    if (request.policyConstraints.humanRequiredRiskLevels.includes(decision.riskLevel)) {
      return {
        result: 'escalate',
        reason: 'auto-review approved a risk level reserved for a human',
        riskLevel: decision.riskLevel,
      };
    }
    if (decision.approvedScope.durationSeconds > request.policyConstraints.maxTtlSeconds) {
      return {
        result: 'escalate',
        reason: 'auto-review approved a longer TTL than the policy allows',
        riskLevel: decision.riskLevel,
      };
    }
    if (!scopeIsSubset(decision.approvedScope.scope, request.requestedPermission.scope)) {
      return {
        result: 'escalate',
        reason: 'auto-review approved a wider scope than requested',
        riskLevel: decision.riskLevel,
      };
    }
    return { ...decision, riskLevel: decision.riskLevel ?? assessment.level };
  }
}

function scopeIsSubset(approved: readonly string[], requested: readonly string[]): boolean {
  return approved.every((entry) =>
    requested.some((allowed) => entry === allowed || entry.startsWith(`${allowed.replace(/\/+$/, '')}/`)),
  );
}

export function permissionScopeOf(
  request: PermissionEvaluationRequest,
  durationSeconds: number,
): PermissionScope {
  return {
    action: request.action.operation,
    resource: request.resource.identifier,
    scope: request.resource.scope ?? [request.resource.identifier],
    durationSeconds,
  };
}
