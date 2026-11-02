/**
 * The sandbox platform's composition root.
 *
 * One function builds the whole control plane from a store and the operator's
 * settings, and returns the Gateway plus the tool provider. The product's HTTP
 * server uses this; so do the tests, with a fake runtime and an in-memory store.
 *
 * The startup order matters:
 *
 *   1. probe the runtime **before** promising anything;
 *   2. refuse to start when the requested isolation (gVisor) is unavailable;
 *   3. recover persisted sandboxes in the background;
 *   4. only then accept executions.
 *
 * A probe failure for a non-gVisor development runtime is logged and the platform
 * still constructs: the Gateway will refuse every execution with a clear error,
 * which is fail-closed. What never happens is a fallback to host execution.
 */

import type { SandboxStore } from './store.ts';
import type { SandboxRuntime } from './types.ts';
import type { SandboxSettings } from './config.ts';
import { createRuntime } from './runtime/index.ts';
import { FakeRuntime } from './runtime/fake.ts';
import { SandboxMetrics, AuditLog } from './audit.ts';
import { Redactor } from './redact.ts';
import { CredentialBroker } from './credentials.ts';
import { WorkspaceManager } from './workspace-manager.ts';
import { SandboxController } from './controller.ts';
import { SandboxGateway } from './gateway.ts';
import { RecoveryManager } from './recovery.ts';
import { GrantManager } from './permissions/grant-manager.ts';
import { PermissionRequestService } from './permissions/request-service.ts';
import { PermissionRecovery } from './permissions/recovery.ts';
import { createSandboxToolProvider, type SandboxToolProvider } from './tool-adapter.ts';
import { SandboxRuntimeUnavailableError } from './errors.ts';
import { describeSandboxSettings } from './config.ts';
import { log } from '../observability/logging.ts';

export interface SandboxPlatform {
  readonly gateway: SandboxGateway;
  readonly provider: SandboxToolProvider;
  readonly recovery: RecoveryManager;
  readonly permissionRecovery: PermissionRecovery;
  readonly metrics: SandboxMetrics;
  readonly credentials: CredentialBroker;
  readonly settings: SandboxSettings;
  readonly runtimeType: string;
  readonly runtimeProbe: { readonly ok: boolean; readonly detail: string };
  /** Probe, recover, and begin heartbeats. Safe to call once. */
  start(): Promise<void>;
  stop(): void;
  health(): Record<string, unknown>;
}

export interface CreateSandboxPlatformInput {
  readonly store: SandboxStore;
  readonly settings: SandboxSettings;
  /** Injected by tests; the composition root uses the configured CLI runtime. */
  readonly runtime?: SandboxRuntime;
  readonly now?: () => Date;
}

export async function createSandboxPlatform(
  input: CreateSandboxPlatformInput,
): Promise<SandboxPlatform> {
  const now = input.now ?? (() => new Date());
  const metrics = new SandboxMetrics();
  // One redactor for the whole platform: a credential registered with the broker
  // after construction must be redacted by audit, events and execution output
  // too, which only works if they share the value list.
  const redactor = new Redactor();
  const audit = new AuditLog({ store: input.store, now }, redactor);
  const credentials = new CredentialBroker({ audit, now, redactor });
  const workspaces = new WorkspaceManager(
    { store: input.store },
    {
      storageRoot: input.settings.workspace.storageRoot,
      sourceRoot: input.settings.workspace.sourceRoot,
      mode: input.settings.workspace.mode,
      ignore: input.settings.workspace.ignore,
      allowSensitive: input.settings.workspace.allowSensitive,
      maxFileBytes: input.settings.workspace.maxFileBytes,
      now,
    },
  );
  const runtime =
    input.runtime ??
    createRuntime({
      kind: input.settings.runtime.kind,
      binary: input.settings.runtime.binary,
      globalArgs: input.settings.runtime.globalArgs,
      seccompProfile: input.settings.runtime.seccompProfile,
      apparmorProfile: input.settings.runtime.apparmorProfile,
      egressNetwork: input.settings.runtime.egressNetwork,
    });
  const controller = new SandboxController({
    store: input.store,
    runtime,
    workspaces,
    metrics,
    audit,
    now,
  });
  const gateway = new SandboxGateway({
    store: input.store,
    controller,
    workspaces,
    audit,
    metrics,
    credentials,
    settings: input.settings,
    now,
    redactor,
  });
  // The recovery sweep needs the same store-facing services the Gateway uses;
  // they are stateless wrappers, so constructing them here keeps the Gateway's
  // permission manager private.
  const permissionGrants = new GrantManager({ store: input.store, audit, now });
  const permissionRequests = new PermissionRequestService({
    store: input.store,
    audit,
    now,
    requestTtlMs: input.settings.permission.requestTtlMs,
    approvalTtlMs: input.settings.permission.approvalTtlMs,
  });
  const permissionRecovery = new PermissionRecovery({
    store: input.store,
    audit,
    metrics,
    requests: permissionRequests,
    grants: permissionGrants,
    now,
    effectiveFor: ({ taskId, sessionId, sandboxId }) =>
      gateway.effectivePermissionPolicy(taskId, sessionId, sandboxId),
  });
  const recovery = new RecoveryManager({
    store: input.store,
    controller,
    workspaces,
    audit,
    metrics,
    configFor: (sandbox, workspace) => gateway.recoveryConfig(sandbox, workspace),
    reconcileExecution: (sandboxId, executionId) => gateway.reconcileExecution(sandboxId, executionId),
  });

  const probe = await runtime.probe().catch((error: unknown) => ({
    ok: false,
    detail: error instanceof Error ? error.message : String(error),
  }));
  if (input.settings.runtime.requireGvisor && !(probe.ok && probe.detail.includes('gvisor=present'))) {
    throw new SandboxRuntimeUnavailableError(
      `gVisor is required but the runtime probe did not confirm it: ${probe.detail}`,
    );
  }
  if (input.runtime instanceof FakeRuntime) {
    log.warn('sandbox.fake_runtime', {
      note: 'a test runtime is injected; do not run this composition in production',
    });
  }

  log.info('sandbox.platform', {
    ...describeSandboxSettings(input.settings),
    runtime: runtime.type,
    runtime_probe: probe.detail,
    runtime_ok: probe.ok,
  });

  let heartbeat: NodeJS.Timeout | null = null;
  let started = false;

  return {
    gateway,
    provider: createSandboxToolProvider(gateway),
    recovery,
    permissionRecovery,
    metrics,
    credentials,
    settings: input.settings,
    runtimeType: runtime.type,
    runtimeProbe: probe,
    async start(): Promise<void> {
      if (started) return;
      started = true;
      const report = await recovery.recoverAll().catch((error: unknown) => {
        log.error('sandbox.recovery_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
      const permissionReport = await permissionRecovery.recoverAll().catch((error: unknown) => {
        log.error('sandbox.permission_recovery_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
      if (permissionReport) {
        log.info('sandbox.permission_recovered', {
          approvals: permissionReport.approvalsChecked,
          denied: permissionReport.requestsDenied,
          restored: permissionReport.requestsRestored,
          expired_grants: permissionReport.grantsExpired,
          stale_grants: permissionReport.grantsStale,
        });
      }
      if (report) {
        log.info('sandbox.recovered', {
          sandboxes: report.sandboxesChecked,
          recovered: report.sandboxesRecovered,
          failed: report.sandboxesFailed,
          executions: report.executionsChecked,
          unknown: report.executionsUnknown,
        });
      }
      heartbeat = setInterval(() => {
        void controller
          .heartbeat()
          .then((result) => {
            if (result.interrupted > 0) {
              log.warn('sandbox.heartbeat_interrupted', {
                checked: result.checked,
                interrupted: result.interrupted,
              });
            }
          })
          .catch((error: unknown) => {
            log.warn('sandbox.heartbeat_failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }, input.settings.heartbeatMs);
      heartbeat.unref();
    },
    stop(): void {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
    },
    health(): Record<string, unknown> {
      return {
        enabled: input.settings.enabled,
        runtime: runtime.type,
        runtime_class: input.settings.runtime.runtimeClass,
        gvisor_required: input.settings.runtime.requireGvisor,
        non_gvisor_acknowledged: input.settings.nonGvisorAcknowledged,
        runtime_ok: probe.ok,
        runtime_detail: probe.detail,
        image: input.settings.imageDigest,
        workspace_mode: input.settings.workspace.mode,
        network_mode: input.settings.network.mode,
        writes: input.settings.allowWrites,
        commands: input.settings.allowCommands,
        permission_mode: input.settings.permission.mode,
        permission_allowed_modes: input.settings.permission.allowedModes,
        auto_review: input.settings.permission.autoReview.enabled,
        metrics: metrics.snapshot(),
      };
    },
  };
}

export * from './types.ts';
export * from './errors.ts';
export {
  compileRuntimeConfig,
  evaluatePolicy,
  taskPolicy,
  tenantPolicy,
  systemPolicy,
  intersectPolicies,
  normalizeContainerPath,
} from './policy.ts';
export { PermissionManager } from './permissions/permission-manager.ts';
export { PermissionRecovery } from './permissions/recovery.ts';
export { GrantManager, validateGrant, covers } from './permissions/grant-manager.ts';
export { PermissionRequestService } from './permissions/request-service.ts';
export { HumanApprovalService } from './permissions/approval-service.ts';
export { AutoReviewService, DeterministicAutoReviewer, assessPermissionRequest } from './permissions/auto-review.ts';
export {
  deploymentPermissionPolicy,
  resolveEffectivePermissionPolicy,
  evaluatePermissionRules,
  narrowPolicyForMode,
  nextScopePolicy,
} from './permissions/policy.ts';
export type {
  ApprovalScopeLevel,
  AutoReviewDecision,
  AutoReviewer,
  EffectivePermissionPolicy,
  HumanApprovalRecord,
  PermissionDecision,
  PermissionEvaluationRequest,
  PermissionGrant,
  PermissionMode,
  PermissionPolicyRecord,
  PermissionRequestRecord,
  PermissionRequestStatus,
  PermissionScope,
  PermissionScopeLevel,
  RiskLevel,
} from './permissions/types.ts';
export { SandboxGateway } from './gateway.ts';
export type { SandboxContext, ExecuteOptions } from './gateway.ts';
export { SandboxController } from './controller.ts';
export { RecoveryManager } from './recovery.ts';
export { WorkspaceManager } from './workspace-manager.ts';
export { WorkspaceFiles } from './workspace-files.ts';
export { createSandboxToolProvider } from './tool-adapter.ts';
export type { SandboxToolProvider, SandboxToolTarget } from './tool-adapter.ts';
export { AuditLog, SandboxMetrics } from './audit.ts';
export { CredentialBroker } from './credentials.ts';
export { Redactor } from './redact.ts';
export { EgressPolicy, blockedAddress } from './network/egress-policy.ts';
export { createEgressProxy } from './network/egress-proxy.ts';
export { MemorySandboxStore } from './store-memory.ts';
export { SqliteSandboxStore } from './store-sqlite.ts';
export { sandboxSettings } from './config.ts';
export type { SandboxSettings } from './config.ts';
