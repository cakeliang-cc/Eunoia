/**
 * The Team HTTP surface.
 *
 * Every route resolves the owner first and then asks a service method that takes
 * the owner as an argument; no handler loads a row and decides authorization by
 * itself. That is what makes "guess an id" return 404 rather than somebody
 * else's member, task or artifact.
 *
 * Event streaming is a cursor over persisted events, not a live-only feed:
 * `Last-Event-ID` (or `?after=`) replays what was missed, and a client that
 * arrives after the events were pruned receives a full snapshot plus a fresh
 * cursor. Disconnecting never stops a run.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TeamService } from './service.ts';
import { isTeamError, TeamError } from './types.ts';
import type { TeamConfig } from './types.ts';
import { SSE_HEADERS } from '../api/sse.ts';

export interface TeamApiAdapters {
  sendJson(res: ServerResponse, status: number, body: unknown): void;
  readJson(req: IncomingMessage): Promise<unknown>;
  identify(req: IncomingMessage, res: ServerResponse): Promise<string>;
  guardWrite(req: IncomingMessage, res: ServerResponse): boolean;
}

export interface TeamApi {
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
}

export function createTeamApi(deps: { service: TeamService; adapters: TeamApiAdapters }): TeamApi {
  const { service, adapters } = deps;

  return {
    async handle(req, res, url): Promise<boolean> {
      const { pathname } = url;
      if (!pathname.startsWith('/api/teams')) return false;

      try {
        // Reads are loopback-only like the rest of the local surface; writes
        // additionally require the per-process token and JSON content type.
        const write = req.method !== 'GET' && req.method !== 'HEAD';
        if (write && !adapters.guardWrite(req, res)) return true;
        const ownerId = await adapters.identify(req, res);

        return await route(req, res, url, ownerId);
      } catch (error) {
        if (isTeamError(error)) {
          adapters.sendJson(res, error.status, {
            error: error.message,
            code: error.code,
            ...(error.detail ? { detail: error.detail } : {}),
            retryable: error.retryable,
          });
          return true;
        }
        throw error;
      }
    },
  };

  async function route(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    ownerId: string,
  ): Promise<boolean> {
    const { pathname, searchParams } = url;
    const method = req.method ?? 'GET';

    if (pathname === '/api/teams' && method === 'GET') {
      const conversationId = searchParams.get('conversationId');
      if (!conversationId) {
        adapters.sendJson(res, 200, { teams: await service.listTeams(ownerId) });
        return true;
      }
      const team = await service.ensureTeam(ownerId, conversationId);
      const runs = await service.listRuns(ownerId, team.id, 10);
      const active = runs.find((run) =>
        ['queued', 'running', 'pausing', 'paused', 'waiting_user', 'stopping', 'needs_reconciliation'].includes(
          run.status,
        ),
      );
      adapters.sendJson(res, 200, {
        team,
        runs,
        activeRunId: active?.id ?? null,
        mode: team.config.mode,
      });
      return true;
    }

    if (pathname === '/api/teams/config' && method === 'POST') {
      const body = asObject(await adapters.readJson(req));
      const conversationId = requiredString(body, 'conversationId');
      const team = await service.ensureTeam(ownerId, conversationId);
      const expectedRevision =
        typeof body.expectedRevision === 'number' ? body.expectedRevision : team.configRevision;
      const updated = await service.updateTeamConfig({
        ownerId,
        teamId: team.id,
        expectedRevision,
        config: (body.config ?? {}) as Partial<TeamConfig>,
        ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      });
      adapters.sendJson(res, 200, { team: updated });
      return true;
    }

    if (pathname === '/api/teams/runs' && method === 'POST') {
      const body = asObject(await adapters.readJson(req));
      const conversationId = requiredString(body, 'conversationId');
      const requestId = requiredString(body, 'requestId');
      const message = requiredString(body, 'message');
      const result = await service.createRun({
        ownerId,
        conversationId,
        requestId,
        message,
        ...(body.config ? { config: body.config as Partial<TeamConfig> } : {}),
      });
      adapters.sendJson(res, result.created ? 201 : 200, {
        team: result.team,
        run: result.run,
        rootMemberId: result.rootMember?.id ?? null,
        activationId: result.activation?.id ?? null,
        created: result.created,
        snapshot: await service.snapshot(ownerId, result.run.id),
      });
      return true;
    }

    const runMatch = /^\/api\/teams\/runs\/([^/]+)(?:\/(.+))?$/.exec(pathname);
    if (runMatch) {
      const runId = decodeURIComponent(runMatch[1] ?? '');
      const suffix = runMatch[2] ?? '';
      const run = await service.getRun(ownerId, runId);

      if (suffix === '' && method === 'GET') {
        adapters.sendJson(res, 200, await service.snapshot(ownerId, runId));
        return true;
      }
      if (suffix === 'steering' && method === 'POST') {
        const body = asObject(await adapters.readJson(req));
        const steered = await service.steerRun({
          ownerId,
          runId,
          message: requiredString(body, 'message'),
          ...(typeof body.clientMessageId === 'string'
            ? { clientMessageId: body.clientMessageId }
            : {}),
        });
        adapters.sendJson(res, 201, steered);
        return true;
      }
      if (suffix === 'stop' && method === 'POST') {
        const body = asObject(await adapters.readJson(req).catch(() => ({})));
        const stopped = await service.stopRun(
          ownerId,
          runId,
          typeof body.reason === 'string' ? body.reason : undefined,
        );
        adapters.sendJson(res, 200, { run: stopped });
        return true;
      }
      if (suffix === 'pause' && method === 'POST') {
        const paused = await service.pauseRun(ownerId, runId);
        adapters.sendJson(res, 200, { run: paused });
        return true;
      }
      if (suffix === 'resume' && method === 'POST') {
        const resumed = await service.resumeRun(ownerId, runId);
        adapters.sendJson(res, 200, { run: resumed });
        return true;
      }
      if (suffix === 'events' && method === 'GET') {
        const after = Number.parseInt(searchParams.get('after') ?? '0', 10) || 0;
        const page = await service.listEvents(ownerId, runId, after, 200);
        adapters.sendJson(res, 200, {
          events: page.items,
          cursor: page.latest,
          run,
        });
        return true;
      }
      if (suffix === 'events/stream' && method === 'GET') {
        await streamEvents(req, res, ownerId, runId);
        return true;
      }
      if (suffix === 'members' && method === 'GET') {
        adapters.sendJson(res, 200, {
          members: await service.listMembers(ownerId, runId),
          run,
        });
        return true;
      }
      if (suffix === 'members' && method === 'POST') {
        const body = asObject(await adapters.readJson(req));
        const parentMemberId =
          typeof body.parentMemberId === 'string' && body.parentMemberId.length > 0
            ? body.parentMemberId
            : run.rootMemberId;
        if (!parentMemberId) {
          throw new TeamError('TEAM_MEMBER_NOT_FOUND', '这次运行还没有主成员。', 409);
        }
        const spawned = await service.spawnMember({
          ownerId,
          runId,
          parentMemberId,
          message: requiredString(body, 'message'),
          ...(typeof body.name === 'string' ? { name: body.name } : {}),
          ...(body.role === 'worker' || body.role === 'reviewer' ? { role: body.role } : {}),
          ...(body.context === 'fresh' || body.context === 'fork' ? { contextMode: body.context } : {}),
          ...(typeof body.forkSeq === 'number' ? { forkSeq: body.forkSeq } : {}),
          ...(typeof body.modelId === 'string' ? { modelId: body.modelId } : {}),
          ...(body.workspaceMode === 'copy' || body.workspaceMode === 'readonly'
            ? { workspaceMode: body.workspaceMode }
            : {}),
        });
        adapters.sendJson(res, 201, {
          member: spawned.member,
          activationId: spawned.activation?.id ?? null,
        });
        return true;
      }
      if (suffix === 'tasks' && method === 'GET') {
        const items = await service.taskView(runId);
        adapters.sendJson(res, 200, { tasks: items, run });
        return true;
      }
      if (suffix === 'tasks' && method === 'POST') {
        const body = asObject(await adapters.readJson(req));
        const task = await service.createTask(
          { run, member: null, userId: ownerId },
          {
            title: requiredString(body, 'title'),
            specification: typeof body.specification === 'string' ? body.specification : '',
            acceptance: typeof body.acceptance === 'string' ? body.acceptance : '',
            required: body.required === true,
            dependencies: stringArray(body.dependencies),
            ownerId: typeof body.ownerId === 'string' ? body.ownerId : null,
            writeScopes: stringArray(body.writeScopes),
          },
        );
        adapters.sendJson(res, 201, { task });
        return true;
      }
      if (suffix === 'messages' && method === 'GET') {
        const after = Number.parseInt(searchParams.get('after') ?? '0', 10) || 0;
        const page = await service.listMessages(ownerId, runId, after, 200);
        adapters.sendJson(res, 200, page);
        return true;
      }
      if (suffix === 'messages' && method === 'POST') {
        const body = asObject(await adapters.readJson(req));
        const message = await service.sendMessage({
          ownerId,
          runId,
          senderId: ownerId,
          senderKind: 'user',
          recipientId: requiredString(body, 'recipientId'),
          clientMessageId: requiredString(body, 'clientMessageId'),
          body: requiredString(body, 'body'),
        });
        adapters.sendJson(res, message.duplicate ? 200 : 201, message);
        return true;
      }
      if (suffix === 'budget' && method === 'GET') {
        adapters.sendJson(res, 200, {
          budget: await service.teamStore.budgetSnapshot(runId),
          usage: await service.teamStore.runUsage(runId),
        });
        return true;
      }
      if (suffix === 'report' && method === 'GET') {
        adapters.sendJson(res, 200, await service.completionReport(runId));
        return true;
      }
      if (suffix === 'artifacts' && method === 'GET') {
        adapters.sendJson(res, 200, {
          artifacts: await service.listArtifacts(ownerId, runId),
        });
        return true;
      }
      if (suffix === 'approvals' && method === 'GET') {
        adapters.sendJson(res, 200, {
          approvals: await service.listApprovals(ownerId, runId),
        });
        return true;
      }
      const approvalMatch = /^approvals\/([^/]+)$/.exec(suffix);
      if (approvalMatch && method === 'POST') {
        const body = asObject(await adapters.readJson(req));
        if (body.decision !== 'approved' && body.decision !== 'denied') {
          throw new TeamError('TEAM_TASK_INVALID', 'decision 必须是 approved 或 denied。', 400);
        }
        const approval = await service.decideApproval({
          ownerId,
          runId,
          approvalRequestId: decodeURIComponent(approvalMatch[1] ?? ''),
          decision: body.decision,
          reason: typeof body.reason === 'string' ? body.reason : '',
        });
        adapters.sendJson(res, 200, { approval });
        return true;
      }
      if (suffix === 'integrations' && method === 'GET') {
        adapters.sendJson(res, 200, {
          integrations: await service.teamStore.listIntegrations(runId),
        });
        return true;
      }
      if (suffix === 'members/diff' && method === 'GET') {
        const memberId = searchParams.get('memberId');
        if (!memberId) throw new TeamError('TEAM_MEMBER_NOT_FOUND', '缺少 memberId。', 400);
        adapters.sendJson(res, 200, {
          manifest: await service.diffMemberWorkspace({ ownerId, runId, memberId }),
        });
        return true;
      }
      if (suffix === 'members/diff' && method === 'POST') {
        const body = asObject(await adapters.readJson(req));
        const artifact = await service.recordArtifact({
          ownerId,
          runId,
          memberId: requiredString(body, 'memberId'),
          ...(typeof body.taskId === 'string' ? { taskId: body.taskId } : {}),
          ...(typeof body.attemptId === 'string' ? { attemptId: body.attemptId } : {}),
          kind: body.kind === 'test' || body.kind === 'note' || body.kind === 'patch' ? body.kind : 'file',
          manifest: await service.diffMemberWorkspace({
            ownerId,
            runId,
            memberId: requiredString(body, 'memberId'),
          }),
          testEvidence: stringArray(body.testEvidence),
        });
        adapters.sendJson(res, 201, { artifact });
        return true;
      }
      return false;
    }

    const memberMatch = /^\/api\/teams\/members\/([^/]+)(?:\/([^/]+))?$/.exec(pathname);
    if (memberMatch) {
      const memberId = decodeURIComponent(memberMatch[1] ?? '');
      const suffix = memberMatch[2] ?? '';
      const member = await service.getMember(ownerId, memberId);
      if (suffix === '' && method === 'GET') {
        const run = await service.getRun(ownerId, searchParams.get('runId') ?? '');
        adapters.sendJson(res, 200, {
          member,
          activations: await service.teamStore.listActivations(run.id, memberId),
        });
        return true;
      }
      if (suffix === 'followup' && method === 'POST') {
        const body = asObject(await adapters.readJson(req));
        const activation = await service.followupAsOwner(
          ownerId,
          requiredString(body, 'runId'),
          memberId,
          requiredString(body, 'message'),
        );
        adapters.sendJson(res, 201, { activation });
        return true;
      }
      if (suffix === 'interrupt' && method === 'POST') {
        adapters.sendJson(res, 200, { member: await service.interruptMember(ownerId, memberId) });
        return true;
      }
      if (suffix === 'close' && method === 'POST') {
        adapters.sendJson(res, 200, { members: await service.closeMember(ownerId, memberId) });
        return true;
      }
      return false;
    }

    const taskMatch = /^\/api\/teams\/tasks\/([^/]+)(?:\/([^/]+))?$/.exec(pathname);
    if (taskMatch) {
      const taskId = decodeURIComponent(taskMatch[1] ?? '');
      const suffix = taskMatch[2] ?? '';
      const found = await service.taskForOwner(ownerId, taskId);
      if (suffix === '' && method === 'GET') {
        adapters.sendJson(res, 200, found);
        return true;
      }
      if (suffix === '' && method === 'PATCH') {
        const body = asObject(await adapters.readJson(req));
        const task = await service.updateTask(
          { run: found.run, member: null, userId: ownerId },
          taskId,
          {
            expectedRevision: requiredNumber(body, 'expectedRevision'),
            ...(typeof body.title === 'string' ? { title: body.title } : {}),
            ...(typeof body.specification === 'string' ? { specification: body.specification } : {}),
            ...(typeof body.acceptance === 'string' ? { acceptance: body.acceptance } : {}),
            ...(typeof body.required === 'boolean' ? { required: body.required } : {}),
            ...(Array.isArray(body.dependencies) ? { dependencies: stringArray(body.dependencies) } : {}),
            ...(body.ownerId === null || typeof body.ownerId === 'string' ? { ownerId: body.ownerId } : {}),
            ...(Array.isArray(body.writeScopes) ? { writeScopes: stringArray(body.writeScopes) } : {}),
          },
        );
        adapters.sendJson(res, 200, { task });
        return true;
      }
      if (suffix === 'review' && method === 'POST') {
        const body = asObject(await adapters.readJson(req));
        if (body.decision !== 'accepted' && body.decision !== 'rejected') {
          throw new TeamError('TEAM_TASK_INVALID', 'decision 必须是 accepted 或 rejected。', 400);
        }
        const result = await service.reviewTask(
          { run: found.run, member: null, userId: ownerId },
          {
            taskId,
            expectedRevision: requiredNumber(body, 'expectedRevision'),
            decision: body.decision,
            reason: requiredString(body, 'reason'),
            ...(typeof body.attemptId === 'string' ? { attemptId: body.attemptId } : {}),
            ...(Array.isArray(body.evidence) ? { evidence: stringArray(body.evidence) } : {}),
            ...(typeof body.candidateHash === 'string' ? { candidateHash: body.candidateHash } : {}),
          },
        );
        adapters.sendJson(res, 200, result);
        return true;
      }
      if (suffix === 'cancel' && method === 'POST') {
        const body = asObject(await adapters.readJson(req));
        const task = await service.cancelTask(
          { run: found.run, member: null, userId: ownerId },
          taskId,
          {
            expectedRevision: requiredNumber(body, 'expectedRevision'),
            reason: typeof body.reason === 'string' ? body.reason : '用户取消',
          },
        );
        adapters.sendJson(res, 200, { task });
        return true;
      }
      return false;
    }

    const integrationMatch = /^\/api\/teams\/integrations\/([^/]+)\/resolve$/.exec(pathname);
    if (integrationMatch && method === 'POST') {
      const integrationId = decodeURIComponent(integrationMatch[1] ?? '');
      const body = asObject(await adapters.readJson(req));
      const integration = await service.resolveIntegration(ownerId, integrationId, {
        resultHashes: (body.resultHashes ?? {}) as Record<string, string>,
        verification: (body.verification ?? null) as Record<string, unknown> | null,
        published: body.published === true,
      });
      adapters.sendJson(res, 200, { integration });
      return true;
    }

    return false;
  }

  async function streamEvents(
    req: IncomingMessage,
    res: ServerResponse,
    ownerId: string,
    runId: string,
  ): Promise<void> {
    const headerCursor = req.headers['last-event-id'];
    const url = new URL(req.url ?? '/', 'http://localhost');
    const after =
      Number.parseInt(
        (Array.isArray(headerCursor) ? headerCursor[0] : headerCursor) ??
          url.searchParams.get('after') ??
          '0',
        10,
      ) || 0;

    res.writeHead(200, SSE_HEADERS);
    res.write(': connected\n\n');
    const write = (event: import('./types.ts').TeamEvent): void => {
      res.write(frame('team', event, event.sequence));
    };

    // Replay from the cursor. If the client is too far behind to have a
    // meaningful replay, a snapshot is sent with a fresh cursor instead of
    // silently skipping events.
    const page = await service.listEvents(ownerId, runId, after, 500);
    const latest = page.items.at(-1)?.sequence ?? after;
    for (const event of page.items) write(event);
    if (page.items.length === 0) {
      const snapshot = await service.snapshot(ownerId, runId);
      res.write(frame('team_snapshot', snapshot, latest));
    }

    let closed = false;
    const unsubscribe = await service.subscribeRun(ownerId, runId, (event) => {
      if (!closed) write(event);
    });
    const heartbeat = setInterval(() => {
      if (!closed) res.write(': ping\n\n');
    }, 15_000);
    heartbeat.unref?.();

    const finish = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    };
    req.on('close', finish);
    res.on('close', finish);

    // Keep the connection until the client leaves or the run reaches a terminal
    // state. Reaching the terminal state is not a reason to lose the tail: one
    // final drain runs first.
    const terminal = setInterval(() => {
      void (async () => {
        const run = await service.teamStore.getRun(runId).catch(() => null);
        if (run && ['succeeded', 'failed', 'cancelled'].includes(run.status)) {
          const tail = await service.listEvents(ownerId, runId, latest + 1, 100).catch(() => null);
          for (const event of tail?.items ?? []) write(event);
          clearInterval(terminal);
          setTimeout(finish, 300);
        }
      })();
    }, 500);
    terminal.unref?.();
  }
}

function frame(event: string, data: unknown, id: number): string {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ------------------------------------------------------------------ helpers ---

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new TeamError('TEAM_TASK_INVALID', '请求体必须是 JSON 对象。', 400);
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TeamError('TEAM_TASK_INVALID', `字段 ${key} 必须是非空字符串。`, 400);
  }
  return value.trim();
}

function requiredNumber(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TeamError('TEAM_TASK_INVALID', `字段 ${key} 必须是数字。`, 400);
  }
  return value;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}
