/**
 * Preview orchestration: a job, a readiness probe, a durable lease and a route.
 *
 * These are four facts the tool must not conflate. A process can start and never
 * answer; a port can answer inside the container and still have no host route; a
 * route can be live after its job died. Each is checked and reported separately.
 *
 * The ingress is `PreviewGateway`; it forwards only to the container port named
 * by a live lease, over a stdio tunnel. Nothing is published on the host.
 */

import type { ExecutionScope } from '../tools/scope.ts';
import { randomUUID } from 'node:crypto';
import type { ToolSandboxSession } from '../tools/types.ts';
import type { ProcessRunContext, ProcessService } from '../processes/service.ts';
import type { DevJobRecord } from '../processes/types.ts';
import { PreviewError, type PreviewLease, type PreviewLimits } from './types.ts';
import { DEFAULT_PREVIEW_LIMITS } from './types.ts';
import type { PreviewLeaseStore } from './store.ts';
import type { PreviewGateway } from './gateway.ts';

export type PreviewSessionFactory = (input: {
  readonly userId: string;
  readonly conversationId: string;
  readonly memberId: string | null;
}) => Promise<ToolSandboxSession | null>;

export interface PreviewServiceDeps {
  readonly processes: ProcessService;
  readonly store: PreviewLeaseStore;
  readonly gateway: PreviewGateway;
  readonly baseDomain: string;
  readonly gatewayPort: number;
  readonly limits?: Partial<PreviewLimits>;
  readonly now?: () => Date;
  readonly sessionFor?: PreviewSessionFactory;
}

export interface PreviewStarted {
  readonly lease: PreviewLease;
  readonly job: DevJobRecord;
  readonly ready: boolean;
  readonly detail: string;
  readonly internalUrl: string;
  readonly logs: { readonly text: string; readonly stderrText: string };
}

export class PreviewService {
  readonly #processes: ProcessService;
  readonly #store: PreviewLeaseStore;
  readonly #gateway: PreviewGateway;
  readonly #baseDomain: string;
  readonly #gatewayPort: number;
  readonly #limits: PreviewLimits;
  readonly #now: () => Date;
  readonly #sessionFor: PreviewSessionFactory | null;

  constructor(deps: PreviewServiceDeps) {
    this.#processes = deps.processes;
    this.#store = deps.store;
    this.#gateway = deps.gateway;
    this.#baseDomain = deps.baseDomain;
    this.#gatewayPort = deps.gatewayPort;
    this.#limits = { ...DEFAULT_PREVIEW_LIMITS, ...deps.limits };
    this.#now = deps.now ?? (() => new Date());
    this.#sessionFor = deps.sessionFor ?? null;
  }

  /** A browser proxy may forward only this execution's exact live lease origin. */
  async browserRoute(scope: ExecutionScope, url: URL): Promise<{ address: string; port: number } | null> {
    if (url.protocol !== 'http:' || url.username || url.password) return null;
    const routeId = url.hostname.split('.')[0] ?? '';
    if (!/^[a-f0-9]{8,64}$/.test(routeId)) return null;
    const lease = await this.#store.findByRoute(routeId);
    const identity = scope.identity;
    if (!lease || lease.status !== 'ready' || !lease.browserUrl || lease.expiresAt <= this.#now().toISOString() || lease.userId !== identity.userId || lease.conversationId !== identity.conversationId || lease.memberId !== (identity.memberId ?? null)) return null;
    if (new URL(lease.browserUrl).origin !== url.origin) return null;
    const address = this.#gateway.address;
    return address ? { address: address.host, port: address.port } : null;
  }

  get limits(): PreviewLimits {
    return this.#limits;
  }

  async start(
    context: ProcessRunContext,
    input: {
      readonly command: string;
      readonly port: number;
      readonly cwd?: string;
      readonly readyTimeoutMs?: number;
    },
  ): Promise<PreviewStarted> {
    const active = (await this.#store.list()).filter(
      (lease) =>
        lease.conversationId === context.conversationId &&
        (lease.status === 'starting' || lease.status === 'ready'),
    );
    if (active.length >= this.#limits.maxPerConversation) {
      throw new PreviewError(
        'PREVIEW_LIMIT',
        `这个会话最多同时保留 ${this.#limits.maxPerConversation} 个预览；先停止一个。`,
        409,
      );
    }
    const job = await this.#processes.start(context, {
      command: input.command,
      ...(input.cwd ? { cwd: input.cwd } : {}),
    });
    const readyTimeout = Math.min(
      input.readyTimeoutMs ?? this.#limits.readyTimeoutMs,
      120_000,
    );
    const probe = await this.#waitReady(context, job, input.port, readyTimeout);
    const now = this.#now();
    const routeId = randomUUID().replace(/-/g, '');
    const ready = probe.ready && probe.running;
    const lease: PreviewLease = {
      id: `prv_${randomUUID()}`,
      routeId,
      jobId: job.id,
      userId: context.userId,
      conversationId: context.conversationId,
      memberId: context.memberId ?? null,
      runId: null,
      taskId: context.taskId,
      sandboxId: null,
      workspaceId: null,
      containerPort: input.port,
      status: ready ? 'ready' : 'failed',
      generation: now.getTime(),
      userUrl: ready ? this.#url(routeId) : null,
      browserUrl: ready ? this.#url(routeId) : null,
      createdAt: now.toISOString(),
      readyAt: ready ? now.toISOString() : null,
      expiresAt: new Date(now.getTime() + this.#limits.ttlMs).toISOString(),
      lastOpenedAt: null,
      error: ready ? null : probe.detail,
    };
    await this.#store.put(lease);
    if (ready) this.#register(lease, context);
    const logs = await this.#readLogs(context, job.id);
    return {
      lease,
      job: await this.#processes.status(context, job.id).catch(() => job),
      ready,
      detail: probe.detail,
      internalUrl: `http://127.0.0.1:${input.port}/`,
      logs,
    };
  }

  async status(
    context: ProcessRunContext,
    previewId: string,
  ): Promise<{ lease: PreviewLease; job: DevJobRecord | null; ready: boolean; detail: string }> {
    const lease = await this.#ownedLease(context.userId, context.conversationId, previewId);
    if (lease.status === 'stopped' || lease.status === 'expired') {
      return { lease, job: null, ready: false, detail: `预览已${lease.status === 'stopped' ? '停止' : '过期'}` };
    }
    const job = await this.#processes.get(context, lease.jobId);
    const running = job !== null && (job.status === 'running' || job.status === 'starting');
    const expired = lease.expiresAt <= this.#now().toISOString();
    if (expired) {
      const next = { ...lease, status: 'expired' as const, userUrl: null, browserUrl: null };
      await this.#store.put(next);
      this.#gateway.removeRoute(lease.routeId);
      return { lease: next, job, ready: false, detail: '预览租约已过期' };
    }
    if (!running && lease.status === 'ready') {
      const next = { ...lease, status: 'expired' as const, userUrl: null, browserUrl: null };
      await this.#store.put(next);
      this.#gateway.removeRoute(lease.routeId);
      return { lease: next, job, ready: false, detail: '预览进程已退出，旧地址不再路由' };
    }
    return {
      lease,
      job,
      ready: lease.status === 'ready' && running,
      detail: running ? '进程运行中' : job ? `进程状态 ${job.status}` : '进程记录不存在',
    };
  }

  async stop(context: ProcessRunContext, previewId: string): Promise<PreviewLease> {
    const lease = await this.#ownedLease(context.userId, context.conversationId, previewId);
    this.#gateway.removeRoute(lease.routeId);
    if (lease.jobId) {
      await this.#processes.stop(context, lease.jobId).catch(() => undefined);
    }
    const next: PreviewLease = {
      ...lease,
      status: 'stopped',
      userUrl: null,
      browserUrl: null,
      error: lease.error,
    };
    await this.#store.put(next);
    return next;
  }

  async list(userId: string, conversationId: string): Promise<PreviewLease[]> {
    return (await this.#store.list())
      .filter((lease) => lease.userId === userId && lease.conversationId === conversationId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async listByUser(userId: string): Promise<PreviewLease[]> {
    return (await this.#store.list())
      .filter((lease) => lease.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Re-register live leases after a restart and expire the rest.
   *
   * A lease is only "live" if a fresh process lookup says its job still runs. A
   * database row saying `ready` is not evidence.
   */
  async resume(): Promise<{ live: number; expired: number }> {
    let live = 0;
    let expired = 0;
    for (const lease of await this.#store.list()) {
      if (lease.status !== 'ready' && lease.status !== 'starting') continue;
      const context = await this.#contextFor(lease);
      if (!context) {
        await this.#store.put({ ...lease, status: 'expired', userUrl: null, browserUrl: null, error: '重启后找不到可恢复的沙箱会话' });
        expired += 1;
        continue;
      }
      const job = await this.#processes.get(context, lease.jobId).catch(() => null);
      const running = job !== null && (job.status === 'running' || job.status === 'starting');
      if (!running || lease.expiresAt <= this.#now().toISOString()) {
        this.#gateway.removeRoute(lease.routeId);
        await this.#store.put({ ...lease, status: 'expired', userUrl: null, browserUrl: null, error: '重启核对发现进程不再运行' });
        expired += 1;
        continue;
      }
      this.#register(lease, context);
      live += 1;
    }
    return { live, expired };
  }

  /** TTL sweep: revoke routes first, then stop their jobs. */
  async expireDue(): Promise<number> {
    let count = 0;
    for (const lease of await this.#store.list()) {
      if (lease.status !== 'ready' && lease.status !== 'starting') continue;
      if (lease.expiresAt > this.#now().toISOString()) continue;
      this.#gateway.removeRoute(lease.routeId);
      const context = await this.#contextFor(lease);
      if (context) {
        await this.#processes.stop(context, lease.jobId).catch(() => undefined);
      }
      await this.#store.put({
        ...lease,
        status: 'expired',
        userUrl: null,
        browserUrl: null,
        error: '预览租约到期',
      });
      count += 1;
    }
    return count;
  }

  /** Stop every lease owned by a conversation; used on root stop. */
  async stopConversation(userId: string, conversationId: string): Promise<number> {
    let count = 0;
    for (const lease of await this.#store.list()) {
      if (lease.userId !== userId || lease.conversationId !== conversationId) continue;
      if (lease.status !== 'ready' && lease.status !== 'starting') continue;
      this.#gateway.removeRoute(lease.routeId);
      const context = await this.#contextFor(lease);
      if (context) await this.#processes.stop(context, lease.jobId).catch(() => undefined);
      await this.#store.put({ ...lease, status: 'stopped', userUrl: null, browserUrl: null });
      count += 1;
    }
    return count;
  }

  async #waitReady(
    context: ProcessRunContext,
    job: DevJobRecord,
    port: number,
    timeoutMs: number,
  ): Promise<{ ready: boolean; running: boolean; detail: string }> {
    const deadline = this.#now().getTime() + timeoutMs;
    for (;;) {
      const current = await this.#processes.status(context, job.id).catch(() => null);
      const running = current !== null && (current.status === 'running' || current.status === 'starting');
      if (!running) {
        const logs = await this.#readLogs(context, job.id).catch(() => ({ text: '', stderrText: '' }));
        return {
          ready: false,
          running: false,
          detail: `预览进程已退出（${current?.status ?? 'unknown'}）${logs.stderrText ? `：${logs.stderrText.slice(-300)}` : ''}`,
        };
      }
      const probe = await this.#processes
        .probeHttp(context, port, Math.min(3_000, Math.max(1_000, deadline - Date.now())))
        .catch(() => ({ ready: false, status: null, detail: '探测失败' }));
      if (probe.ready) return { ready: true, running: true, detail: probe.detail };
      if (Date.now() >= deadline) {
        const logs = await this.#readLogs(context, job.id).catch(() => ({ text: '', stderrText: '' }));
        return {
          ready: false,
          running,
          detail: `${probe.detail}（${timeoutMs}ms 内未就绪）${logs.stderrText ? `：${logs.stderrText.slice(-300)}` : ''}`,
        };
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500);
        timer.unref();
      });
      if (context.signal?.aborted) return { ready: false, running, detail: '已取消' };
    }
  }

  #register(lease: PreviewLease, context: ProcessRunContext): void {
    this.#gateway.setRoute({
      lease,
      openTunnel: (port, signal) => {
        if (!context.executor.tunnel) {
          return Promise.reject(new Error('当前执行器不支持预览隧道'));
        }
        return context.executor.tunnel({ port, ...(signal ? { signal } : {}) });
      },
      isActive: async () => {
        const job = await this.#processes.get(context, lease.jobId).catch(() => null);
        return job !== null && (job.status === 'running' || job.status === 'starting');
      },
    });
  }

  #url(routeId: string): string {
    const port = this.#gatewayPort === 80 ? '' : `:${this.#gatewayPort}`;
    return `http://${routeId}.${this.#baseDomain}${port}/`;
  }

  async #ownedLease(userId: string, conversationId: string, previewId: string): Promise<PreviewLease> {
    const lease = await this.#store.get(previewId);
    if (!lease || lease.userId !== userId || lease.conversationId !== conversationId) {
      throw new PreviewError('PREVIEW_NOT_FOUND', '没有这个预览。', 404);
    }
    return lease;
  }

  async #readLogs(
    context: ProcessRunContext,
    jobId: string,
  ): Promise<{ text: string; stderrText: string }> {
    try {
      const read = await this.#processes.read(context, { jobId, stream: 'both', cursor: 0 });
      return { text: read.text, stderrText: read.stderrText };
    } catch {
      return { text: '', stderrText: '' };
    }
  }

  async #contextFor(lease: PreviewLease): Promise<ProcessRunContext | null> {
    if (!this.#sessionFor) return null;
    const session = await this.#sessionFor({
      userId: lease.userId,
      conversationId: lease.conversationId,
      memberId: lease.memberId,
    });
    if (!session) return null;
    return {
      executor: session.executor,
      userId: lease.userId,
      conversationId: lease.conversationId,
      ...(lease.memberId ? { memberId: lease.memberId } : {}),
      taskId: lease.taskId,
      toolCallId: `preview_${lease.id}`,
    };
  }
}
