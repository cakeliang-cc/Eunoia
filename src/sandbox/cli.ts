/**
 * Operations CLI.
 *
 * The platform is not only used by the chat server: an operator has to inspect
 * what exists, recover after a crash, grant an approval, checkpoint a workspace,
 * reap idle runtimes and run the egress proxy. Each of those is a subcommand
 * here, and each one goes through the same Gateway/Recovery code the server uses
 * — a separate admin path would be a second implementation to keep correct.
 *
 * Usage:
 *
 *   npm run sandbox -- status
 *   npm run sandbox -- recover
 *   npm run sandbox -- approve --task <id> --action fs.write --scope /workspace --minutes 10
 *   npm run sandbox -- mode --task <id> --mode read-only
 *   npm run sandbox -- cwd --task <id>
 *   npm run sandbox -- cd --task <id> --path src
 *   npm run sandbox -- audit --task <id> --action task.cwd.change.succeeded
 *   npm run sandbox -- requests --task <id>
 *   npm run sandbox -- approve-request --approval <id> --by alice
 *   npm run sandbox -- checkpoint --task <id>
 *   npm run sandbox -- gc --idle-minutes 60
 *   npm run sandbox -- proxy --listen 0.0.0.0:8788
 */

import { sandboxSettings, describeSandboxSettings } from './config.ts';
import { minutesToMs } from './cli-args.ts';
import { createSandboxPlatform } from './index.ts';
import { selectStore } from '../db/select.ts';
import { EgressPolicy } from './network/egress-policy.ts';
import { createEgressProxy } from './network/egress-proxy.ts';
import { SandboxError } from './errors.ts';
import { PERMISSION_MODES, type PermissionMode } from './permissions/types.ts';
import { log } from '../observability/logging.ts';

interface Args {
  readonly command: string;
  readonly flags: Readonly<Record<string, string>>;
}

function parseArgs(argv: readonly string[]): Args {
  const [command = 'status', ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const entry = rest[index] as string;
    if (!entry.startsWith('--')) continue;
    const key = entry.slice(2);
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = 'true';
    }
  }
  return { command, flags };
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function requireFlag(flags: Readonly<Record<string, string>>, name: string): string {
  const value = flags[name]?.trim();
  if (!value) throw new SandboxError('invalid_input', `missing --${name}`);
  return value;
}

function parseMode(value: string): PermissionMode {
  const normalized = value.trim().toLowerCase();
  if (!(PERMISSION_MODES as readonly string[]).includes(normalized)) {
    throw new SandboxError(
      'invalid_input',
      `unknown mode ${value}; expected ${PERMISSION_MODES.join(', ')}`,
    );
  }
  return normalized as PermissionMode;
}

function parseApprovalScope(value: string): 'once' | 'task' | 'session' {
  const normalized = value.trim().toLowerCase();
  if (normalized !== 'once' && normalized !== 'task' && normalized !== 'session') {
    throw new SandboxError('invalid_input', `unknown approval scope ${value}; expected once|task|session`);
  }
  return normalized;
}

function permissionScope(
  flags: Readonly<Record<string, string>>,
  task: { readonly taskId: string; readonly sessionId: string; readonly sandboxId: string | null },
): { scopeType: 'session' | 'task' | 'sandbox'; scopeId: string } {
  if (flags.sandbox) return { scopeType: 'sandbox', scopeId: flags.sandbox };
  if (flags.session) return { scopeType: 'session', scopeId: flags.session };
  return { scopeType: 'task', scopeId: task.taskId };
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (command === 'help' || command === '--help') {
    process.stdout.write(
      'usage: sandbox <status|recover|mode|cwd|cd|audit|permissions|requests|approvals|grants|approve|approve-request|deny-request|revoke|sweep|checkpoint|gc|proxy> [--flags]\n',
    );
    return;
  }

  const settings = sandboxSettings();
  if (!settings) {
    throw new SandboxError(
      'invalid_input',
      'the sandbox is not enabled: set WORKSPACE_ROOT and SANDBOX_IMAGE_DIGEST',
    );
  }

  // The proxy command does not need the database; everything else does.
  if (command === 'proxy') {
    await runProxy(settings, flags);
    return;
  }

  const selection = await selectStore();
  const platform = await createSandboxPlatform({ store: selection.sandboxStore, settings });
  try {
    switch (command) {
      case 'status': {
        const sandboxes = await selection.sandboxStore.listSandboxes();
        output({
          settings: describeSandboxSettings(settings),
          runtime: platform.health(),
          sandboxes,
        });
        return;
      }
      case 'recover': {
        const report = await platform.recovery.recoverAll();
        output(report);
        return;
      }
      case 'revoke': {
        const taskId = requireFlag(flags, 'task');
        const approvalId = requireFlag(flags, 'approval');
        const task = await selection.sandboxStore.getTask(taskId);
        if (!task) throw new SandboxError('not_found', `task ${taskId} does not exist`);
        const revoked = await platform.gateway.revokeApproval(
          { taskId, userId: task.userId, sessionId: task.sessionId },
          approvalId,
        );
        output({ approvalId, revoked });
        return;
      }
      case 'approve': {
        const taskId = requireFlag(flags, 'task');
        const task = await selection.sandboxStore.getTask(taskId);
        if (!task) throw new SandboxError('not_found', `task ${taskId} does not exist`);
        const action = (flags.action ?? 'fs.write') as
          | 'fs.read'
          | 'fs.write'
          | 'fs.list'
          | 'fs.chdir'
          | 'process.exec'
          | 'network.connect';
        const scope = (flags.scope ?? '/workspace')
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean);
        const grant = await platform.gateway.approve(
          { taskId, userId: task.userId, sessionId: task.sessionId },
          {
            action,
            resourceScope: scope,
            ttlMs: minutesToMs(flags.minutes, 10),
            ...(flags.by ? { approvedBy: flags.by } : {}),
          },
        );
        output(grant);
        return;
      }
      case 'cwd': {
        // ADR 021: the operator view of one task's execution context. It is the
        // same state the Gateway injects into a command, not a copy.
        const taskId = requireFlag(flags, 'task');
        const task = await selection.sandboxStore.getTask(taskId);
        if (!task) throw new SandboxError('not_found', `task ${taskId} does not exist`);
        const context = { taskId, userId: task.userId, sessionId: task.sessionId };
        output({
          current: await platform.gateway.currentDirectory(context),
          context: await platform.gateway.taskContext(context),
        });
        return;
      }
      case 'cd': {
        // A trusted control-plane change. It goes through the same CwdManager as
        // the tool, so the boundary, permission and CAS checks are identical.
        const taskId = requireFlag(flags, 'task');
        const task = await selection.sandboxStore.getTask(taskId);
        if (!task) throw new SandboxError('not_found', `task ${taskId} does not exist`);
        const result = await platform.gateway.changeDirectory(
          { taskId, userId: task.userId, sessionId: task.sessionId },
          { path: requireFlag(flags, 'path') },
        );
        output(result);
        if (!result.ok) throw new SandboxError('invalid_input', result.message);
        return;
      }
      case 'audit': {
        // ADR 021 §14: the cwd trail is queryable by task, sandbox or execution.
        output(
          await selection.sandboxStore.listAudit({
            ...(flags.task ? { taskId: flags.task } : {}),
            ...(flags.sandbox ? { sandboxId: flags.sandbox } : {}),
            ...(flags.execution ? { executionId: flags.execution } : {}),
            ...(flags.action ? { action: flags.action } : {}),
            limit: Number(flags.limit ?? 50),
          }),
        );
        return;
      }
      case 'permissions': {
        const taskId = requireFlag(flags, 'task');
        const task = await selection.sandboxStore.getTask(taskId);
        if (!task) throw new SandboxError('not_found', `task ${taskId} does not exist`);
        output(
          await platform.gateway.permissionStatus({
            taskId,
            userId: task.userId,
            sessionId: task.sessionId,
          }),
        );
        return;
      }
      case 'mode': {
        const taskId = requireFlag(flags, 'task');
        const task = await selection.sandboxStore.getTask(taskId);
        if (!task) throw new SandboxError('not_found', `task ${taskId} does not exist`);
        const context = { taskId, userId: task.userId, sessionId: task.sessionId };
        if (!flags.mode) {
          output(await platform.gateway.permissionStatus(context));
          return;
        }
        const mode = parseMode(flags.mode);
        const scope = permissionScope(flags, task);
        const policy = await platform.gateway.setPermissionPolicy({
          scopeType: scope.scopeType,
          scopeId: scope.scopeId,
          mode,
          ...(flags.minutes ? { ttlMs: minutesToMs(flags.minutes, 0) } : {}),
          actor: flags.by?.trim() || settings.permission.operatorId,
        });
        output(policy);
        return;
      }
      case 'requests': {
        const taskId = requireFlag(flags, 'task');
        const task = await selection.sandboxStore.getTask(taskId);
        if (!task) throw new SandboxError('not_found', `task ${taskId} does not exist`);
        output(
          await platform.gateway.listPermissionRequests({
            taskId,
            userId: task.userId,
            sessionId: task.sessionId,
          }),
        );
        return;
      }
      case 'approvals': {
        const taskId = requireFlag(flags, 'task');
        const task = await selection.sandboxStore.getTask(taskId);
        if (!task) throw new SandboxError('not_found', `task ${taskId} does not exist`);
        output(
          await platform.gateway.listPermissionApprovals({
            taskId,
            userId: task.userId,
            sessionId: task.sessionId,
          }),
        );
        return;
      }
      case 'grants': {
        const taskId = requireFlag(flags, 'task');
        const task = await selection.sandboxStore.getTask(taskId);
        if (!task) throw new SandboxError('not_found', `task ${taskId} does not exist`);
        output(
          await platform.gateway.listPermissionGrants({
            taskId,
            userId: task.userId,
            sessionId: task.sessionId,
          }),
        );
        return;
      }
      case 'approve-request': {
        const approvalId = requireFlag(flags, 'approval');
        const approval = await selection.sandboxStore.getHumanApproval(approvalId);
        if (!approval) throw new SandboxError('not_found', `approval ${approvalId} does not exist`);
        const task = await selection.sandboxStore.getTask(approval.taskId);
        if (!task) throw new SandboxError('not_found', `task ${approval.taskId} does not exist`);
        const result = await platform.gateway.approvePermissionRequest(
          { taskId: task.taskId, userId: task.userId, sessionId: task.sessionId },
          {
            approvalRequestId: approvalId,
            decidedBy: requireFlag(flags, 'by'),
            ...(flags.scope ? { scope: parseApprovalScope(flags.scope) } : {}),
            ...(flags.minutes ? { ttlSeconds: Math.floor(minutesToMs(flags.minutes, 0) / 1_000) } : {}),
            ...(flags.reason ? { reason: flags.reason } : {}),
          },
        );
        output(result);
        return;
      }
      case 'deny-request': {
        const approvalId = requireFlag(flags, 'approval');
        const approval = await selection.sandboxStore.getHumanApproval(approvalId);
        if (!approval) throw new SandboxError('not_found', `approval ${approvalId} does not exist`);
        const task = await selection.sandboxStore.getTask(approval.taskId);
        if (!task) throw new SandboxError('not_found', `task ${approval.taskId} does not exist`);
        const result = await platform.gateway.denyPermissionRequest(
          { taskId: task.taskId, userId: task.userId, sessionId: task.sessionId },
          {
            approvalRequestId: approvalId,
            decidedBy: requireFlag(flags, 'by'),
            ...(flags.reason ? { reason: flags.reason } : {}),
          },
        );
        output(result);
        return;
      }
      case 'sweep': {
        output(await platform.gateway.sweepPermissions());
        return;
      }
      case 'checkpoint': {
        const taskId = requireFlag(flags, 'task');
        const task = await selection.sandboxStore.getTask(taskId);
        if (!task) throw new SandboxError('not_found', `task ${taskId} does not exist`);
        const checkpoint = await platform.gateway.checkpoint(
          { taskId, userId: task.userId, sessionId: task.sessionId },
          flags.execution ?? null,
        );
        output(checkpoint);
        return;
      }
      case 'gc': {
        const checkpointDays = Number(flags['checkpoint-days'] ?? '7');
        const result = await platform.gateway.gc({
          idleMs: minutesToMs(flags['idle-minutes'], 60),
          checkpointRetentionMs:
            (Number.isFinite(checkpointDays) && checkpointDays > 0 ? checkpointDays : 7) *
            24 *
            60 *
            60_000,
        });
        output(result);
        return;
      }
      default:
        throw new SandboxError('invalid_input', `unknown command ${command}`);
    }
  } finally {
    platform.stop();
    await selection.store.close();
  }
}

async function runProxy(
  settings: NonNullable<ReturnType<typeof sandboxSettings>>,
  flags: Readonly<Record<string, string>>,
): Promise<void> {
  if (settings.network.mode !== 'proxy_only') {
    throw new SandboxError('invalid_input', 'the egress proxy only runs when SANDBOX_NETWORK_MODE=proxy_only');
  }
  const policy = new EgressPolicy({
    allowedDomains: settings.network.allowedDomains,
    allowedPorts: settings.network.allowedPorts,
  });
  const server = createEgressProxy({
    policy,
    audit: (event) => {
      log[event.allowed ? 'info' : 'warn']('sandbox.egress', {
        host: event.host,
        port: event.port,
        allowed: event.allowed,
        reason: event.reason,
        bytes: event.bytes,
      });
    },
  });
  const listen = flags.listen ?? '127.0.0.1:8788';
  const index = listen.lastIndexOf(':');
  const host = listen.slice(0, index) || '127.0.0.1';
  const port = Number.parseInt(listen.slice(index + 1), 10);
  if (!Number.isFinite(port)) throw new SandboxError('invalid_input', `invalid --listen ${listen}`);

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  process.stdout.write(
    `egress proxy listening on ${host}:${port} · domains=${settings.network.allowedDomains.join(',') || '(none)'}\n`,
  );
  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Keep the process alive until a signal arrives.
  await new Promise<void>(() => undefined);
}


main().catch((error: unknown) => {
  log.error('sandbox.cli_failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.stderr.write(`sandbox: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
