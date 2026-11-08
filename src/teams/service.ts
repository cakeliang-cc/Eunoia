/**
 * The Team domain service: runs, the shared task board, dispatch, mail and the
 * whole-team budget.
 *
 * Boundaries kept deliberately separate:
 *
 *   - **Member execution** lives in `src/agents/members.ts`. This module never
 *     runs a model; it asks the runtime to.
 *   - **Tasks and runs** live here. A task is not "done" because an activation
 *     ended; only a reviewed submission changes it to `accepted`.
 *   - **Storage** is the `TeamStore` port. Every state change is a CAS or a
 *     guarded transition, so two workers cannot both win.
 *
 * The service is the `ActivationHost` the runtime calls back into: it supplies
 * tools, the member workspace, mailbox delivery, budget reservations and the
 * model-slot semaphore. That direction of dependency is what keeps `agents/`
 * free of task-board policy.
 */

import { contentFingerprint } from '../observability/logging.ts';
import { log } from '../observability/logging.ts';
import { providerFor } from '../provider/index.ts';
import { createModelTurnResolver } from '../agent/model-turn.ts';
import { modelProfile } from '../models/registry.ts';
import type { ModelTurn } from '../agent/model-port.ts';
import type { ToolDefinition, ToolPolicy } from '../tools/types.ts';
import { createTeamTools, type TeamToolCaller, type TeamToolHost } from '../tools/team.ts';
import type { ToolSandboxSession } from '../tools/types.ts';
import { DEFAULT_TOOL_POLICY } from '../tools/types.ts';
import type { Store } from '../store.ts';
import { SessionService } from '../session/service.ts';
import { TeamError } from './types.ts';
import type {
  Activation,
  Artifact,
  ArtifactManifest,
  BudgetSnapshot,
  BudgetReservation,
  Member,
  MemberPermissions,
  Task,
  TaskReview,
  Team,
  TeamConfig,
  TeamMessage,
  TeamRun,
  UsageTotals,
} from './types.ts';
import { clampTeamConfig, isTaskReady, isTerminalRunStatus } from './types.ts';
import type {
  TeamStore,
  TaskPage,
  IntegrationJournalEntry,
  Integration,
} from './store.ts';
import { ACTIVE_RUN_STATUSES } from './store.ts';
import { SubagentRuntime } from '../agents/members.ts';
import type { ActivationHost, AuthorizeModelCallInput, MailboxDelivery, ModelCallGrant } from '../agents/members.ts';
import { renderCollaborationMessage, renderMemberContext } from '../agents/prompt.ts';
import { newId } from '../agents/members.ts';
import { transcriptMode } from '../session/model-transcript.ts';
import type { TeamApprovalPort, TeamApprovalView } from './approvals.ts';
import { integrateManifests, publishCandidate } from './integration.ts';
import type { McpInteractionRecord } from '../mcp/types.ts';

// ----------------------------------------------------------- workspace port ---

export interface ProvisionedWorkspaceLike {
  readonly workspaceId: string;
  readonly workspaceTaskId: string;
  readonly workspacePath: string;
  readonly baselineId: string;
  readonly sourceVersion: string;
  readonly baselineHashes: Readonly<Record<string, string>>;
}

/** The workspace module's surface, kept structural so tests can substitute it. */
export interface TeamWorkspacePort {
  provision(input: {
    readonly teamId: string;
    readonly runId: string;
    readonly ownerId: string;
    readonly memberId: string;
    readonly name: string;
    readonly mode: Member['workspaceMode'];
  }): Promise<ProvisionedWorkspaceLike>;
  session(input: {
    readonly userId: string;
    readonly workspaceTaskId: string;
    readonly sessionId: string;
  }): Promise<ToolSandboxSession | null>;
  diff(input: {
    readonly workspaceTaskId: string;
    readonly baselineId: string;
  }): Promise<ArtifactManifest>;
  currentHashes(workspaceTaskId: string): Promise<Record<string, string>>;
  /** The user's source root, for candidate integration. */
  sourceRootPath?(): string | null;
  /** Absolute member copy path, for publishing file contents. */
  workspacePathFor?(workspaceTaskId: string): Promise<string | null>;
  /** Baseline written when the member workspace was provisioned. */
  baselineForWorkspace?(workspaceTaskId: string): Promise<{
    readonly baselineId: string;
    readonly hashes: Readonly<Record<string, string>>;
  } | null>;
  /** Read a workspace file for conflict review. */
  readWorkspaceFile?(workspaceTaskId: string, path: string): Promise<{
    readonly path: string;
    readonly content: string;
    readonly hash: string;
  } | null>;
  /** Write a resolved file into the member copy (never the source). */
  writeWorkspaceFile?(
    workspaceTaskId: string,
    path: string,
    content: string,
  ): Promise<{ readonly path: string; readonly hash: string }>;
  /** Read a source file for conflict review. */
  readSourceFile?(path: string): Promise<{
    readonly path: string;
    readonly content: string;
    readonly hash: string;
  } | null>;
  /** Delete a member workspace only when the caller proved it is unreferenced. */
  cleanup?(input: {
    readonly workspaceTaskId: string;
    readonly referenced: boolean;
  }): Promise<boolean>;
}

// -------------------------------------------------------------------- deps ---

export interface TeamServiceDeps {
  readonly teamStore: TeamStore;
  readonly store: Store;
  readonly sessions: SessionService;
  readonly workspace: TeamWorkspacePort;
  /** Deployment ceiling; a client can only lower it. */
  readonly ceiling: TeamConfig;
  readonly toolPolicy?: ToolPolicy;
  readonly now?: () => Date;
  readonly maxSteps?: number;
  readonly transcriptMode?: 'durable' | 'legacy';
  /** Test seam. Production resolves through the provider registry. */
  readonly resolveModelTurn?: (member: Member) => Promise<ModelTurn>;
  readonly modelProfileFor?: (id: string) => import('../models/types.ts').ModelProfile;
  /** Sandbox approval binding, when a sandbox is configured. */
  readonly approvals?: TeamApprovalPort;
  /** Private media, for explicitly granted member images. */
  readonly media?: import('../media/service.ts').MediaService | null;
  readonly imagePolicies?: import('../provider/image-policy.ts').ImagePolicyRegistry;
  readonly mediaLimits?: import('../media/types.ts').MediaLimits;
  readonly sessionConfig?: import('../session/config.ts').SessionConfig;
  readonly availableImageModels?: readonly string[];
  /** MCP host, forwarded to member executions. */
  readonly mcp?: import('../mcp/service.ts').McpService | null;
  /** Typed questions, used to cancel a closed member's pending cards. */
  readonly questions?: import('../questions/service.ts').QuestionService | null;
}

export interface CreateRunInput {
  readonly ownerId: string;
  readonly conversationId: string;
  readonly requestId: string;
  readonly message: string;
  readonly requestHash?: string;
  readonly config?: Partial<TeamConfig>;
}

export interface CreateRunResult {
  readonly team: Team;
  readonly run: TeamRun;
  readonly rootMember: Member | null;
  readonly activation: Activation | null;
  readonly created: boolean;
}

export interface TaskInput {
  readonly title: string;
  readonly specification: string;
  readonly acceptance: string;
  readonly required?: boolean;
  readonly dependencies?: readonly string[];
  readonly ownerId?: string | null;
  readonly writeScopes?: readonly string[];
}

export interface TaskPatchInput extends Partial<TaskInput> {
  readonly expectedRevision: number;
  readonly status?: Task['status'];
  readonly failureReason?: string | null;
}

// ----------------------------------------------------------------- service ---

export class TeamService implements ActivationHost, TeamToolHost {
  readonly teamStore: TeamStore;
  readonly runtime: SubagentRuntime;
  readonly #deps: TeamServiceDeps;
  readonly #now: () => Date;
  readonly #slots = new Map<string, { active: number; waiters: SlotWaiter[] }>();
  readonly #modelTurns = new Map<string, Promise<ModelTurn>>();
  readonly #timers = new Set<NodeJS.Timeout>();

  constructor(deps: TeamServiceDeps) {
    this.#deps = deps;
    this.teamStore = deps.teamStore;
    this.#now = deps.now ?? (() => new Date());
    this.runtime = new SubagentRuntime({
      teamStore: deps.teamStore,
      store: deps.store,
      sessions: deps.sessions,
      host: this,
      now: this.#now,
      resolveModelTurn:
        deps.resolveModelTurn ??
        ((member) => {
          const key = `${member.profile.providerId}/${member.profile.modelId}`;
          const existing = this.#modelTurns.get(key);
          if (existing) return existing;
          const provider = providerFor(member.profile.providerId);
          const resolved = createModelTurnResolver(provider.createModelProvider())(member.profile.modelId);
          this.#modelTurns.set(key, resolved);
          return resolved;
        }),
      transcriptMode: deps.transcriptMode ?? transcriptMode(),
      ...(deps.media !== undefined ? { media: deps.media } : {}),
      ...(deps.imagePolicies ? { imagePolicies: deps.imagePolicies } : {}),
      ...(deps.mediaLimits ? { mediaLimits: deps.mediaLimits } : {}),
      ...(deps.sessionConfig ? { sessionConfig: deps.sessionConfig } : {}),
      ...(deps.availableImageModels ? { availableImageModels: deps.availableImageModels } : {}),
      ...(deps.mcp !== undefined ? { mcp: deps.mcp } : {}),
    });
  }

  // ---------------------------------------------------------------- teams ---

  async ensureTeam(
    ownerId: string,
    conversationId: string,
    requested?: Partial<TeamConfig>,
  ): Promise<Team> {
    const existing = await this.teamStore.getTeamForRoot(ownerId, conversationId);
    if (existing) return existing;
    const config = clampTeamConfig(requested ?? {}, this.#deps.ceiling, this.#deps.ceiling.defaultModelId);
    const team: Team = {
      id: newId('team'),
      ownerId,
      rootConversationId: conversationId,
      enabled: config.mode === 'team',
      configRevision: 1,
      config,
      createdAt: this.#now().toISOString(),
      updatedAt: this.#now().toISOString(),
    };
    const created = await this.teamStore.createTeam({
      id: team.id,
      ownerId,
      rootConversationId: conversationId,
      enabled: team.enabled,
      config,
      now: team.createdAt,
    });
    await this.teamStore.appendEvent(team.id, 'team', {
      kind: 'team.created',
      payload: { teamId: created.id, configRevision: created.configRevision },
    });
    return created;
  }

  async getTeam(ownerId: string, teamId: string): Promise<Team> {
    const team = await this.teamStore.getTeam(teamId);
    if (!team || team.ownerId !== ownerId) {
      throw new TeamError('TEAM_NOT_FOUND', '没有这个 Team。', 404);
    }
    return team;
  }

  async listTeams(ownerId: string): Promise<Team[]> {
    return this.teamStore.listTeams(ownerId);
  }

  /**
   * Conversations that belong to members, so the normal list can exclude them.
   * A member's chat is an execution trace, not a conversation the person had.
   */
  async hiddenConversationIds(ownerId: string): Promise<ReadonlySet<string>> {
    const teams = await this.teamStore.listTeams(ownerId);
    const ids = new Set<string>();
    for (const team of teams) {
      for (const member of await this.teamStore.listMembers(team.id)) {
        ids.add(member.internalConversationId);
      }
    }
    return ids;
  }

  async updateTeamConfig(input: {
    readonly ownerId: string;
    readonly teamId: string;
    readonly expectedRevision: number;
    readonly config: Partial<TeamConfig>;
    readonly enabled?: boolean;
  }): Promise<Team> {
    const existing = await this.getTeam(input.ownerId, input.teamId);
    if (existing.configRevision !== input.expectedRevision) {
      throw new TeamError('TEAM_CONFIG_CONFLICT', 'Team 配置已被修改，请刷新后重试。', 409, {
        expectedRevision: input.expectedRevision,
        currentRevision: existing.configRevision,
      });
    }
    const merged = clampTeamConfig(
      {
        ...existing.config,
        ...input.config,
        limits: { ...existing.config.limits, ...(input.config.limits ?? {}) },
        budget: { ...existing.config.budget, ...(input.config.budget ?? {}) },
      },
      this.#deps.ceiling,
      existing.config.defaultModelId,
    );
    // Turning Team off keeps history; it only changes whether task tools are
    // available and whether new dispatch happens.
    const enabled = input.enabled ?? (merged.mode === 'team');
    const updated = await this.teamStore.updateTeam({
      id: existing.id,
      expectedRevision: input.expectedRevision,
      enabled,
      config: { ...merged, mode: enabled ? 'team' : 'delegation' },
      now: this.#now().toISOString(),
    });
    if (!updated) {
      throw new TeamError('TEAM_CONFIG_CONFLICT', 'Team 配置已被修改，请刷新后重试。', 409);
    }
    await this.teamStore.appendEvent(updated.id, 'team', {
      kind: 'team.config',
      payload: { configRevision: updated.configRevision, enabled: updated.enabled },
    });
    return updated;
  }

  // ----------------------------------------------------------------- runs ---

  async createRun(input: CreateRunInput): Promise<CreateRunResult> {
    await this.#deps.store.ensureUser(input.ownerId);
    // A team run is scoped to a real conversation this owner has. Trusting a
    // posted conversation id would let any caller attach a run to somebody
    // else's history.
    const conversation = await this.#deps.store.getConversation(input.ownerId, input.conversationId);
    if (!conversation) {
      throw new TeamError('TEAM_NOT_FOUND', '找不到这个会话，或者它不属于当前用户。', 404);
    }
    const team = await this.ensureTeam(input.ownerId, input.conversationId, input.config);
    const active = await this.teamStore.activeRunForRoot(input.ownerId, input.conversationId);
    const inputHash =
      input.requestHash ??
      contentFingerprint(`${input.ownerId}\u0000${input.conversationId}\u0000${input.message}`);
    if (active && active.inputHash !== inputHash) {
      throw new TeamError(
        'TEAM_RUN_BUSY',
        '这个会话已经有一次 Team 运行在进行中；请先停止或等待它结束。',
        409,
        { runId: active.id, status: active.status },
      );
    }
    const budget = {
      maxInputTokens: team.config.budget.maxInputTokens,
      maxOutputTokens: team.config.budget.maxOutputTokens,
      maxRequests: team.config.budget.maxRequests,
      maxEstimatedCostUsd: team.config.budget.maxEstimatedCostUsd,
    };
    const created = await this.teamStore.createRun({
      id: newId('run'),
      teamId: team.id,
      ownerId: input.ownerId,
      rootConversationId: input.conversationId,
      rootTurnId: input.requestId,
      rootRequestId: input.requestId,
      inputHash,
      budget,
      now: this.#now().toISOString(),
    });
    if (!created.created) {
      const existingMembers = await this.teamStore.listMembers(team.id);
      const root = existingMembers.find((member) => member.role === 'root') ?? null;
      return {
        team,
        run: created.run,
        rootMember: root,
        activation: null,
        created: false,
      };
    }

    const run = await this.teamStore.transitionRun(
      created.run.id,
      ['queued'],
      { status: 'running' },
      { kind: 'run.status', payload: { status: 'running' } },
    );
    if (!run) throw new TeamError('TEAM_RUN_CONFLICT', '运行状态竞争失败。', 409);

    const rootPermissions: MemberPermissions = {
      allowWorkspaceWrites: this.#rootWritesAllowed(),
      allowCommands: this.#deps.toolPolicy?.allowCommands ?? false,
      allowedTools: null,
      canSpawn: true,
      canWriteMemory: false,
      maxOutputChars: this.#deps.toolPolicy?.maxOutputChars ?? DEFAULT_TOOL_POLICY.maxOutputChars,
      imageAssetIds: [],
    };
    try {
      const spawned = await this.runtime.spawn({
        team,
        run,
        parent: null,
        rootPermissions,
        name: '主成员',
        role: 'root',
        contextMode: 'fresh',
        workspaceMode: 'bind',
        input: { kind: 'spawn', text: input.message },
        requestId: `${input.requestId}:root`,
        defer: true,
      });
      const rootMember = spawned.member;
      await this.teamStore.transitionRun(
        run.id,
        ['running'],
        { rootMemberId: rootMember.id },
        { kind: 'run.created', payload: { runId: run.id, rootMemberId: rootMember.id } },
      );
      const activation = await this.runtime.followup(rootMember.id, {
        kind: 'spawn',
        text: input.message,
      });
      void this.runtime.pump(rootMember.id);
      return { team, run: { ...run, rootMemberId: rootMember.id }, rootMember, activation, created: true };
    } catch (error) {
      await this.teamStore.transitionRun(run.id, ['running'], {
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
        finishedAt: this.#now().toISOString(),
      });
      throw error;
    }
  }

  async getRun(ownerId: string, runId: string): Promise<TeamRun> {
    const run = await this.teamStore.getRun(runId);
    if (!run || run.ownerId !== ownerId) {
      throw new TeamError('TEAM_RUN_NOT_FOUND', '没有这次 Team 运行。', 404);
    }
    return run;
  }

  async listRuns(ownerId: string, teamId: string, limit = 20): Promise<TeamRun[]> {
    await this.getTeam(ownerId, teamId);
    return this.teamStore.listRuns(teamId, limit);
  }

  /** A complete snapshot for a reconnecting client; events are a cursor over it. */
  async snapshot(ownerId: string, runId: string): Promise<Record<string, unknown>> {
    const run = await this.getRun(ownerId, runId);
    const team = await this.getTeam(ownerId, run.teamId);
    const [members, tasks, messages, artifacts, budget, events] = await Promise.all([
      this.teamStore.listMembers(team.id),
      this.teamStore.listTasks(run.id, { limit: 200 }),
      this.teamStore.listMessages(run.id, 0, 200),
      this.teamStore.listArtifacts({ runId, limit: 200 }),
      this.teamStore.budgetSnapshot(run.id),
      this.teamStore.listEvents(run.id, 0, 200),
    ]);
    const approvals = await this.listApprovals(ownerId, runId).catch(() => []);
    const mcpInteractions = await this.listMcpInteractions(ownerId, runId).catch(() => []);
    return {
      team,
      run,
      members,
      approvals,
      mcpInteractions,
      tasks: tasks.items,
      taskTotal: tasks.total,
      messages: messages.items,
      artifacts,
      budget,
      events,
      eventCursor: events.at(-1)?.sequence ?? 0,
      mode: team.config.mode,
    };
  }

  async stopRun(ownerId: string, runId: string, reason = '用户停止整队'): Promise<TeamRun> {
    const run = await this.getRun(ownerId, runId);
    if (isTerminalRunStatus(run.status)) return run;
    const stopping = await this.teamStore.transitionRun(
      run.id,
      ACTIVE_RUN_STATUSES.filter((status) => status !== 'stopping'),
      { status: 'stopping' },
      { kind: 'run.stopped', payload: { reason, phase: 'stopping' } },
    );
    const activations = await this.teamStore.listActivations(run.id);
    for (const activation of activations) {
      if (activation.status === 'running' || activation.status === 'waiting') {
        await this.runtime.interrupt(activation.memberId, reason);
      } else if (activation.status === 'queued') {
        await this.teamStore.updateActivation(activation.id, ['queued'], {
          status: 'interrupted',
          error: reason,
          finishedAt: this.#now().toISOString(),
        });
      }
    }
    const cancelled = await this.teamStore.transitionRun(
      run.id,
      ['stopping'],
      {
        status: 'cancelled',
        reason,
        finishedAt: this.#now().toISOString(),
      },
      { kind: 'run.status', payload: { status: 'cancelled', reason } },
    );
    return cancelled ?? stopping ?? run;
  }

  async pauseRun(ownerId: string, runId: string): Promise<TeamRun> {
    const run = await this.getRun(ownerId, runId);
    if (run.status !== 'running' && run.status !== 'waiting_user') return run;
    const pausing = await this.teamStore.transitionRun(
      run.id,
      ['running', 'waiting_user'],
      { status: 'pausing' },
      { kind: 'run.paused', payload: { phase: 'pausing' } },
    );
    if (!pausing) return run;
    void this.#settlePause(pausing);
    return pausing;
  }

  async #settlePause(run: TeamRun): Promise<void> {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const running = (await this.teamStore.listActivations(run.id)).filter(
        (activation) => activation.status === 'running' || activation.status === 'waiting',
      );
      if (running.length === 0) {
        await this.teamStore.transitionRun(run.id, ['pausing'], {
          status: 'paused',
        }, { kind: 'run.paused', payload: { phase: 'paused' } });
        return;
      }
      if (Date.now() > deadline) {
        // The model request did not settle. `pausing` is the honest state: it
        // says "no new work is dispatched" without claiming the old work stopped.
        return;
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 100);
        timer.unref?.();
        this.#timers.add(timer);
      });
    }
  }

  async resumeRun(ownerId: string, runId: string): Promise<TeamRun> {
    const run = await this.getRun(ownerId, runId);
    if (run.status !== 'paused' && run.status !== 'waiting_user') return run;
    const team = await this.getTeam(ownerId, run.teamId);
    const budget = await this.teamStore.budgetSnapshot(run.id);
    if (budget.exhausted) {
      throw new TeamError('TEAM_BUDGET_EXHAUSTED', '团队预算已经用尽，不能恢复派发。', 409);
    }
    const resumed = await this.teamStore.transitionRun(
      run.id,
      ['paused', 'waiting_user'],
      { status: 'running', reason: null },
      { kind: 'run.resumed', payload: { configRevision: team.configRevision } },
    );
    if (resumed) await this.dispatchReady(resumed.id);
    return resumed ?? run;
  }

  async #evaluateRun(runId: string, reason: string | null): Promise<TeamRun | null> {
    const run = await this.teamStore.getRun(runId);
    if (!run || isTerminalRunStatus(run.status)) return run;
    const team = await this.teamStore.getTeam(run.teamId);
    if (!team) return run;
    const tasks = await this.teamStore.listTasks(runId, { limit: 1_000 });
    const required = tasks.items.filter((task) => task.required);
    const outstanding = tasks.items.filter((task) =>
      ['pending', 'running', 'submitted'].includes(task.status),
    );
    const conflicts = await this.teamStore.listIntegrations(runId);
    const openConflict = conflicts.filter(
      (integration) => integration.status === 'conflict',
    );
    const activations = await this.teamStore.listActivations(runId);
    const running = activations.filter(
      (activation) => activation.status === 'running' || activation.status === 'queued',
    );
    if (
      required.every((task) => task.status === 'accepted') &&
      outstanding.length === 0 &&
      openConflict.length === 0 &&
      running.length === 0
    ) {
      const rootSummary = run.rootMemberId
        ? ((await this.teamStore.listActivations(runId, run.rootMemberId)).at(-1)?.result?.summary ??
          null)
        : null;
      const succeeded = await this.teamStore.transitionRun(runId, ['running', 'waiting_user', 'paused'], {
        status: 'succeeded',
        reason: reason ?? rootSummary,
        finishedAt: this.#now().toISOString(),
      }, { kind: 'run.status', payload: { status: 'succeeded' } });
      return succeeded ?? run;
    }
    // While the root member is still executing, the run is still running: a
    // task review by the root must not flip the run to waiting_user mid-turn.
    const rootActive = run.rootMemberId
      ? activations.some(
          (activation) =>
            activation.memberId === run.rootMemberId &&
            ['queued', 'running', 'waiting'].includes(activation.status),
        )
      : false;
    // A root that produced an answer with unfinished work is not a success. It
    // waits with the answer preserved, and a later review can finish the run.
    if (run.status === 'running' && !rootActive) {
      const waiting = await this.teamStore.transitionRun(runId, ['running'], {
        status: 'waiting_user',
        reason:
          required.some((task) => task.status !== 'accepted')
            ? '仍有必需任务未验收'
            : openConflict.length > 0
              ? '仍有未解决的集成冲突'
              : '仍有未完成的任务',
      }, {
        kind: 'run.summary',
        payload: {
          status: 'waiting_user',
          required: required.map((task) => ({ id: task.id, status: task.status })),
          outstanding: outstanding.map((task) => task.id),
          runningActivations: running.length,
        },
      });
      return waiting ?? run;
    }
    return run;
  }

  // --------------------------------------------------------------- members ---

  async listMembers(ownerId: string, runId: string): Promise<Member[]> {
    const run = await this.getRun(ownerId, runId);
    return this.teamStore.listMembers(run.teamId);
  }

  async getMember(ownerId: string, memberId: string): Promise<Member> {
    const member = await this.teamStore.getMember(memberId);
    if (!member) throw new TeamError('TEAM_MEMBER_NOT_FOUND', '没有这个成员。', 404);
    const team = await this.teamStore.getTeam(member.teamId);
    if (!team || team.ownerId !== ownerId) {
      throw new TeamError('TEAM_MEMBER_NOT_FOUND', '没有这个成员。', 404);
    }
    return member;
  }

  async spawnMember(input: {
    readonly ownerId: string;
    readonly runId: string;
    readonly parentMemberId: string;
    readonly name?: string;
    readonly role?: Member['role'];
    readonly contextMode?: 'fresh' | 'fork';
    readonly forkSeq?: number | null;
    readonly modelId?: string;
    readonly workspaceMode?: Member['workspaceMode'];
    readonly message: string;
    readonly requestId?: string;
    readonly images?: readonly string[];
    readonly permissions?: Partial<MemberPermissions>;
  }): Promise<{ member: Member; activation: Activation | null }> {
    const run = await this.getRun(input.ownerId, input.runId);
    const team = await this.getTeam(input.ownerId, run.teamId);
    if (team.config.mode !== 'team' && input.role === 'reviewer') {
      throw new TeamError('TEAM_MODE_DISABLED', 'Team 任务板已关闭。', 409);
    }
    const parent = await this.getMember(input.ownerId, input.parentMemberId);
    const images = input.images ?? [];
    const permissions: Partial<MemberPermissions> | undefined =
      images.length > 0
        ? { ...input.permissions, imageAssetIds: images }
        : input.permissions;
    const spawned = await this.runtime.spawn({
      team,
      run,
      parent,
      ...(input.name ? { name: input.name } : {}),
      ...(input.role ? { role: input.role } : {}),
      ...(input.contextMode ? { contextMode: input.contextMode } : {}),
      ...(input.forkSeq !== undefined ? { forkSeq: input.forkSeq } : {}),
      ...(input.modelId ? { profile: { modelId: input.modelId } } : {}),
      ...(permissions ? { permissions } : {}),
      ...(input.workspaceMode ? { workspaceMode: input.workspaceMode } : {}),
      input: {
        kind: 'spawn',
        text: input.message,
        ...(images.length > 0 ? { images } : {}),
      },
      ...(input.requestId ? { requestId: input.requestId } : {}),
    });
    // Grants are recorded against the child's stable id, after creation but
    // before any later activation can use them.
    for (const assetId of images) {
      await this.grantImage({
        ownerId: input.ownerId,
        runId: run.id,
        memberId: spawned.member.id,
        assetId,
        purpose: 'spawn-input',
        ttlSeconds: 900,
      });
    }
    return spawned;
  }

  async followupMember(input: {
    readonly ownerId: string;
    readonly runId: string;
    readonly memberId: string;
    readonly message: string;
    readonly requestId?: string;
  }): Promise<Activation> {
    await this.getRun(input.ownerId, input.runId);
    await this.getMember(input.ownerId, input.memberId);
    return this.runtime.followup(input.memberId, {
      kind: 'followup',
      text: input.message,
    });
  }

  async followupAsOwner(
    ownerId: string,
    runId: string,
    memberId: string,
    message: string,
    images: readonly string[] = [],
  ): Promise<Activation> {
    await this.getRun(ownerId, runId);
    const member = await this.getMember(ownerId, memberId);
    if (member.status === 'closed' || member.status === 'closing') {
      throw new TeamError('TEAM_MEMBER_CLOSED', '成员已关闭。', 409);
    }
    if (images.length > 0) await this.#requireImageGrants(runId, memberId, images);
    return this.runtime.followup(memberId, {
      kind: 'followup',
      text: message,
      ...(images.length > 0 ? { images } : {}),
    });
  }

  async followupFromTool(
    caller: TeamToolCaller,
    memberId: string,
    message: string,
    requestId?: string,
  ): Promise<Activation> {
    const member = await this.teamStore.getMember(memberId);
    if (!member || member.teamId !== caller.team.id) {
      throw new TeamError('TEAM_MEMBER_NOT_FOUND', '没有这个成员。', 404);
    }
    return this.runtime.followup(memberId, {
      kind: 'followup',
      text: message,
      ...(requestId ? { requestId } : {}),
    });
  }

  async interruptMember(ownerId: string, memberId: string): Promise<Member> {
    await this.getMember(ownerId, memberId);
    return this.runtime.interrupt(memberId);
  }

  async closeMember(ownerId: string, memberId: string): Promise<Member[]> {
    await this.getMember(ownerId, memberId);
    const closed = await this.runtime.close(memberId);
    // A closed member's pending questions must not stay answerable: the wait
    // that would receive the answer no longer exists.
    await this.#deps.questions
      ?.cancelForMember(ownerId, memberId, '成员已关闭，等待中的问题已取消。')
      .catch(() => undefined);
    return closed;
  }

  // ----------------------------------------------------------------- tasks ---

  async createTask(
    caller: TeamToolCaller | { readonly userId: string; readonly run: TeamRun; readonly member: Member | null },
    input: TaskInput,
  ): Promise<Task> {
    const run = caller.run;
    const team = await this.teamStore.getTeam(run.teamId);
    if (!team) throw new TeamError('TEAM_NOT_FOUND', '没有这个 Team。', 404);
    if (team.config.mode !== 'team') {
      throw new TeamError('TEAM_MODE_DISABLED', 'Team 任务板已关闭，不能创建任务。', 409);
    }
    const creator = caller.member?.id ?? callerUserId(caller);
    const title = input.title?.trim() ?? '';
    const specification = input.specification?.trim() ?? '';
    const acceptance = input.acceptance?.trim() ?? '';
    if (title.length === 0 || title.length > 200) {
      throw new TeamError('TEAM_TASK_INVALID', '任务标题必须在 1–200 字之间。', 400);
    }
    if (specification.length > 8_000 || acceptance.length > 8_000) {
      throw new TeamError('TEAM_TASK_INVALID', '任务说明和验收条件各自不能超过 8000 字。', 400);
    }
    if ((input.required ?? false) && acceptance.length === 0) {
      throw new TeamError('TEAM_TASK_INVALID', '必需任务必须填写可检查的验收条件。', 400);
    }
    const dependencies = unique(input.dependencies ?? []);
    if (dependencies.includes('') || dependencies.length > 32) {
      throw new TeamError('TEAM_TASK_INVALID', '依赖列表不合法。', 400);
    }
    if (input.ownerId) await this.#assertMemberOfTeam(team.id, input.ownerId);
    const existing = await this.teamStore.listTasks(run.id, { limit: 1_000 });
    const byId = new Map(existing.items.map((task) => [task.id, task]));
    for (const dependency of dependencies) {
      if (dependency === undefined || !byId.has(dependency)) {
        throw new TeamError('TEAM_TASK_INVALID', `依赖的任务不存在：${dependency}`, 400);
      }
    }
    const nowIso = this.#now().toISOString();
    const task: Task = {
      id: newId('task'),
      teamId: team.id,
      runId: run.id,
      revision: 1,
      title,
      specification,
      acceptance,
      required: input.required ?? false,
      dependencies,
      ownerId: input.ownerId ?? null,
      status: 'pending',
      writeScopes: unique(input.writeScopes ?? []),
      createdBy: creator,
      createdAt: nowIso,
      updatedAt: nowIso,
      submittedAt: null,
      acceptedAt: null,
      failureReason: null,
      currentAttemptId: null,
    };
    const created = await this.teamStore.createTask({
      task,
      maxTasks: team.config.limits.maxTasks,
      event: {
        kind: 'task.created',
        payload: { taskId: task.id, title, required: task.required, dependencies },
      },
    });
    if (created.required && created.ownerId && created.dependencies.every((id) => byId.get(id)?.status === 'accepted')) {
      await this.#maybeAutoDispatch(created).catch(() => undefined);
    }
    return created;
  }

  async taskForOwner(
    ownerId: string,
    taskId: string,
  ): Promise<{ task: Task; run: TeamRun; attempts: import('./types.ts').TaskAttempt[] }> {
    const task = await this.teamStore.getTask(taskId);
    if (!task) throw new TeamError('TEAM_TASK_NOT_FOUND', '没有这个任务。', 404);
    const run = await this.getRun(ownerId, task.runId);
    return { task, run, attempts: await this.teamStore.listAttempts(taskId) };
  }

  async listTasks(
    caller: TeamToolCaller | { readonly run: TeamRun },
    options: { readonly limit?: number; readonly offset?: number; readonly status?: Task['status'] } = {},
  ): Promise<TaskPage> {
    return this.teamStore.listTasks(caller.run.id, {
      limit: Math.min(100, Math.max(1, options.limit ?? 50)),
      offset: Math.max(0, options.offset ?? 0),
      ...(options.status ? { status: options.status } : {}),
    });
  }

  async getTask(
    caller: TeamToolCaller | { readonly run: TeamRun },
    taskId: string,
  ): Promise<{ task: Task; attempts: import('./types.ts').TaskAttempt[] }> {
    const task = await this.teamStore.getTask(taskId);
    if (!task || task.runId !== caller.run.id) {
      throw new TeamError('TEAM_TASK_NOT_FOUND', '没有这个任务。', 404);
    }
    return { task, attempts: await this.teamStore.listAttempts(taskId) };
  }

  async updateTask(
    caller: TeamToolCaller | { readonly run: TeamRun; readonly member: Member | null; readonly userId?: string },
    taskId: string,
    patch: TaskPatchInput,
  ): Promise<Task> {
    const { task } = await this.getTask(caller, taskId);
    const member = caller.member;
    const isRoot = !member || member.role === 'root';
    const isReviewer = member?.role === 'reviewer';
    const owns = member?.id === task.ownerId;
    if (!isRoot && !isReviewer && !owns) {
      throw new TeamError('TEAM_FORBIDDEN', '成员只能修改自己负责的任务。', 403);
    }
    if (!isRoot) {
      if (patch.acceptance !== undefined || patch.required !== undefined) {
        throw new TeamError('TEAM_FORBIDDEN', '只有主成员或用户可以修改验收条件和必需标记。', 403);
      }
      if (patch.dependencies !== undefined || patch.ownerId !== undefined) {
        throw new TeamError('TEAM_FORBIDDEN', '只有主成员或用户可以重新分配依赖和负责人。', 403);
      }
    }
    if (patch.status !== undefined && patch.status !== 'cancelled' && patch.status !== 'failed') {
      throw new TeamError('TEAM_FORBIDDEN', '任务状态只能通过领取、提交和验收改变。', 403);
    }
    if (patch.dependencies) {
      const tasks = await this.teamStore.listTasks(caller.run.id, { limit: 1_000 });
      this.#validateDependencies(task.id, patch.dependencies, tasks.items);
    }
    if (patch.ownerId) await this.#assertMemberOfTeam(task.teamId, patch.ownerId);
    const nowIso = this.#now().toISOString();
    const result = await this.teamStore.updateTask({
      taskId,
      expectedRevision: patch.expectedRevision,
      patch: {
        ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
        ...(patch.specification !== undefined ? { specification: patch.specification.trim() } : {}),
        ...(patch.acceptance !== undefined ? { acceptance: patch.acceptance.trim() } : {}),
        ...(patch.required !== undefined ? { required: patch.required } : {}),
        ...(patch.dependencies !== undefined ? { dependencies: unique(patch.dependencies) } : {}),
        ...(patch.ownerId !== undefined ? { ownerId: patch.ownerId } : {}),
        ...(patch.writeScopes !== undefined ? { writeScopes: unique(patch.writeScopes) } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.failureReason !== undefined ? { failureReason: patch.failureReason } : {}),
      },
      now: nowIso,
      event: { kind: 'task.updated', payload: { taskId, revision: task.revision + 1 } },
    });
    if (!result.ok) {
      throw new TeamError('TEAM_TASK_CONFLICT', '任务已被修改，请刷新后重试。', 409, {
        current: result.current,
      });
    }
    return result.value;
  }

  async claimTask(
    caller: TeamToolCaller,
    taskId: string,
    expectedRevision: number,
  ): Promise<{ task: Task; attempt: import('./types.ts').TaskAttempt }> {
    const member = caller.member!;
    const freshMember = await this.teamStore.getMember(member.id);
    if (!freshMember || freshMember.teamId !== caller.team.id) {
      throw new TeamError('TEAM_FORBIDDEN', '这不是当前 Team 的成员。', 403);
    }
    if (['closed', 'closing', 'failed', 'provisioning'].includes(freshMember.status)) {
      throw new TeamError('TEAM_MEMBER_CLOSED', '关闭或失败的成员不能认领任务。', 409);
    }
    const { task } = await this.getTask(caller, taskId);
    if (task.ownerId !== null && task.ownerId !== member.id) {
      throw new TeamError('TEAM_TASK_NOT_ELIGIBLE', '这个任务已经分配给其他成员。', 409);
    }
    if (task.status !== 'pending') {
      throw new TeamError('TEAM_TASK_NOT_READY', '只有 pending 任务可以领取。', 409);
    }
    const tasks = await this.teamStore.listTasks(caller.run.id, { limit: 1_000 });
    if (!isTaskReady(task, new Map(tasks.items.map((entry) => [entry.id, entry])))) {
      throw new TeamError('TEAM_TASK_NOT_READY', '任务的依赖还没有全部验收。', 409);
    }
    const nowIso = this.#now().toISOString();
    const result = await this.teamStore.claimTask({
      taskId,
      expectedRevision,
      memberId: member.id,
      activationId: caller.activation.id,
      generation: caller.activation.generation,
      leaseExpiresAt: new Date(this.#now().getTime() + 10 * 60_000).toISOString(),
      baselineId: null,
      now: nowIso,
      event: { kind: 'task.claimed', payload: { taskId, memberId: member.id } },
    });
    if (!result.ok) {
      throw new TeamError('TEAM_TASK_CONFLICT', '领取失败：任务版本已变化。', 409, {
        current: result.current,
      });
    }
    return result.value;
  }

  async submitTask(
    caller: TeamToolCaller,
    input: {
      readonly taskId: string;
      readonly expectedRevision: number;
      readonly summary: string;
      readonly artifactIds?: readonly string[];
      readonly testEvidence?: readonly string[];
      readonly candidateHash?: string | null;
    },
  ): Promise<{ task: Task; attempt: import('./types.ts').TaskAttempt }> {
    const member = caller.member!;
    const { task } = await this.getTask(caller, input.taskId);
    if (task.ownerId !== member.id) {
      throw new TeamError('TEAM_FORBIDDEN', '只有任务负责人可以提交。', 403);
    }
    if (!task.currentAttemptId) {
      throw new TeamError('TEAM_TASK_NOT_READY', '任务还没有被领取。', 409);
    }
    const summary = input.summary?.trim() ?? '';
    if (summary.length === 0) {
      throw new TeamError('TEAM_TASK_INVALID', '提交必须包含总结。', 400);
    }
    const evidence = (input.testEvidence ?? []).map((entry) => entry.trim()).filter(Boolean);
    if (task.required && evidence.length === 0) {
      throw new TeamError('TEAM_TASK_INVALID', '必需任务的提交必须附可核查的证据。', 400);
    }
    for (const artifactId of input.artifactIds ?? []) {
      const artifact = await this.teamStore.getArtifact(artifactId);
      if (!artifact || artifact.runId !== caller.run.id || artifact.memberId !== member.id) {
        throw new TeamError('TEAM_TASK_INVALID', '提交引用了不属于你的产物。', 403);
      }
    }
    const nowIso = this.#now().toISOString();
    const result = await this.teamStore.submitTask({
      taskId: task.id,
      expectedRevision: input.expectedRevision,
      attemptId: task.currentAttemptId,
      submission: {
        summary,
        artifactIds: input.artifactIds ?? [],
        testEvidence: evidence,
        candidateHash: input.candidateHash ?? null,
        submittedAt: nowIso,
        submittedBy: member.id,
      },
      now: nowIso,
      event: { kind: 'task.submitted', payload: { taskId: task.id, memberId: member.id } },
    });
    if (!result.ok) {
      throw new TeamError('TEAM_TASK_CONFLICT', '提交失败：任务版本已变化。', 409, {
        current: result.current,
      });
    }
    return result.value;
  }

  async reviewTask(
    caller: TeamToolCaller | { readonly run: TeamRun; readonly member: Member | null; readonly userId: string },
    input: {
      readonly taskId: string;
      readonly expectedRevision: number;
      readonly attemptId?: string;
      readonly decision: 'accepted' | 'rejected';
      readonly reason: string;
      readonly evidence?: readonly string[];
      readonly candidateHash?: string | null;
    },
  ): Promise<{ task: Task; attempt: import('./types.ts').TaskAttempt }> {
    const { task, attempts } = await this.getTask(caller, input.taskId);
    const reviewer = caller.member;
    if (reviewer && reviewer.role !== 'root' && reviewer.role !== 'reviewer') {
      throw new TeamError('TEAM_FORBIDDEN', '普通成员不能验收任务。', 403);
    }
    const attempt = input.attemptId
      ? attempts.find((entry) => entry.id === input.attemptId)
      : attempts.find((entry) => entry.id === task.currentAttemptId);
    if (!attempt || !attempt.submission) {
      throw new TeamError('TEAM_TASK_INVALID', '这个任务没有可验收的提交。', 409);
    }
    if (attempt.submission.submittedBy === (reviewer?.id ?? callerUserId(caller))) {
      throw new TeamError('TEAM_FORBIDDEN', '不能验收自己提交的任务。', 403);
    }
    if (input.decision === 'accepted') {
      if (task.acceptance.trim().length === 0) {
        throw new TeamError('TEAM_TASK_INVALID', '任务没有验收条件，不能通过。', 409);
      }
      if ((input.evidence ?? []).length === 0 && (attempt.submission.testEvidence ?? []).length === 0) {
        throw new TeamError('TEAM_TASK_INVALID', '验收必须引用证据。', 409);
      }
      if (attempt.submission.candidateHash && input.candidateHash && attempt.submission.candidateHash !== input.candidateHash) {
        throw new TeamError('TEAM_TASK_INVALID', '候选哈希已变化，旧的验证证据不能用于验收。', 409);
      }
    }
    const review: TaskReview = {
      decision: input.decision,
      reviewerId: reviewer?.id ?? callerUserId(caller),
      reason: input.reason.trim(),
      evidence: (input.evidence ?? attempt.submission.testEvidence).map((entry) => entry.trim()).filter(Boolean),
      candidateHash: input.candidateHash ?? attempt.submission.candidateHash,
      reviewedAt: this.#now().toISOString(),
    };
    const result = await this.teamStore.reviewTask({
      taskId: task.id,
      expectedRevision: input.expectedRevision,
      attemptId: attempt.id,
      review,
      now: this.#now().toISOString(),
      event: {
        kind: 'task.reviewed',
        payload: { taskId: task.id, decision: review.decision, reviewerId: review.reviewerId },
      },
    });
    if (!result.ok) {
      throw new TeamError('TEAM_TASK_CONFLICT', '验收失败：任务版本已变化。', 409, {
        current: result.current,
      });
    }
    if (result.value.task.status === 'accepted') {
      await this.dispatchReady(caller.run.id).catch(() => undefined);
      await this.#evaluateRun(caller.run.id, null).catch(() => undefined);
    } else {
      // A rejected submission returns the task to pending; the member can claim
      // again, and the old attempt stays as history.
    }
    return result.value;
  }

  /** Convenience for tests and the API: all tasks with derived readiness. */
  async taskView(runId: string): Promise<Array<Task & { readonly ready: boolean }>> {
    const page = await this.teamStore.listTasks(runId, { limit: 1_000 });
    const byId = new Map(page.items.map((task) => [task.id, task]));
    return page.items.map((task) => ({ ...task, ready: isTaskReady(task, byId) }));
  }

  async dispatchReady(runId: string): Promise<number> {
    const run = await this.teamStore.getRun(runId);
    // A waiting run can still receive new assigned work; "waiting_user" means no
    // terminal outcome yet, not "dispatch is closed".
    if (!run || (run.status !== 'running' && run.status !== 'waiting_user')) return 0;
    const team = await this.teamStore.getTeam(run.teamId);
    if (!team || !team.config.autoDispatch || team.config.dispatchPaused || team.config.mode !== 'team') {
      return 0;
    }
    const page = await this.teamStore.listTasks(runId, { limit: 1_000 });
    const byId = new Map(page.items.map((task) => [task.id, task]));
    let started = 0;
    for (const task of page.items) {
      if (!task.ownerId || !isTaskReady(task, byId)) continue;
      const member = await this.teamStore.getMember(task.ownerId);
      // A busy member still gets the work queued: its current activation is
      // not interrupted, and the task runs immediately after it. Skipping the
      // task because the member happened to be busy would leave assigned work
      // pending until something else wakes the scheduler.
      if (!member || ['closed', 'closing', 'failed', 'provisioning'].includes(member.status)) {
        continue;
      }
      const derived = await this.#claimForDispatch(task, member, run);
      if (!derived) continue;
      await this.runtime.followup(member.id, {
        kind: 'task',
        taskId: derived.task.id,
        text: taskInstruction(derived.task),
      });
      started += 1;
    }
    return started;
  }

  async #claimForDispatch(task: Task, member: Member, run: TeamRun): Promise<{ task: Task } | null> {
    const nowIso = this.#now().toISOString();
    const result = await this.teamStore.claimTask({
      taskId: task.id,
      expectedRevision: task.revision,
      memberId: member.id,
      activationId: null,
      generation: 0,
      leaseExpiresAt: new Date(this.#now().getTime() + 10 * 60_000).toISOString(),
      baselineId: null,
      now: nowIso,
      event: { kind: 'task.claimed', payload: { taskId: task.id, memberId: member.id, dispatched: true } },
    });
    void run;
    return result.ok ? { task: result.value.task } : null;
  }

  async #maybeAutoDispatch(task: Task): Promise<void> {
    const team = await this.teamStore.getTeam(task.teamId);
    if (!team?.config.autoDispatch || team.config.dispatchPaused) return;
    await this.dispatchReady(task.runId);
  }

  async cancelTask(
    caller: { readonly run: TeamRun; readonly member: Member | null; readonly userId: string },
    taskId: string,
    input: { readonly expectedRevision: number; readonly reason: string },
  ): Promise<Task> {
    const { task } = await this.getTask(caller, taskId);
    if (caller.member && caller.member.role !== 'root' && caller.member.role !== 'reviewer') {
      throw new TeamError('TEAM_FORBIDDEN', '只有主成员或用户可以取消任务。', 403);
    }
    if (task.required && input.reason.trim().length === 0) {
      throw new TeamError('TEAM_TASK_INVALID', '取消必需任务必须说明原因。', 400);
    }
    const result = await this.teamStore.updateTask({
      taskId,
      expectedRevision: input.expectedRevision,
      patch: { status: 'cancelled', failureReason: input.reason.trim() },
      now: this.#now().toISOString(),
      event: { kind: 'task.cancelled', payload: { taskId, reason: input.reason } },
    });
    if (!result.ok) {
      throw new TeamError('TEAM_TASK_CONFLICT', '任务已被修改，请刷新后重试。', 409, {
        current: result.current,
      });
    }
    return result.value;
  }

  // -------------------------------------------------------------- messages ---

  async sendMessage(input: {
    readonly ownerId: string;
    readonly runId: string;
    readonly senderId: string;
    readonly senderKind: 'member' | 'user' | 'root';
    readonly recipientId: string;
    readonly clientMessageId: string;
    readonly body: string;
  }): Promise<{ message: TeamMessage; duplicate: boolean }> {
    const run = await this.getRun(input.ownerId, input.runId);
    const team = await this.getTeam(input.ownerId, run.teamId);
    const recipient = await this.teamStore.getMember(input.recipientId);
    if (!recipient || recipient.teamId !== team.id) {
      throw new TeamError('TEAM_MEMBER_NOT_FOUND', '收件成员不属于这个 Team。', 404);
    }
    if (recipient.status === 'closed' || recipient.status === 'closing') {
      throw new TeamError('TEAM_MEMBER_CLOSED', '收件成员已关闭。', 409);
    }
    const sender = input.senderKind === 'user' ? null : await this.teamStore.getMember(input.senderId);
    if (input.senderKind !== 'user' && (!sender || sender.teamId !== team.id)) {
      throw new TeamError('TEAM_FORBIDDEN', '发件成员不属于这个 Team。', 403);
    }
    if (sender?.status === 'closed') {
      throw new TeamError('TEAM_MEMBER_CLOSED', '发件成员已关闭。', 409);
    }
    const body = input.body.trim();
    if (body.length === 0) {
      throw new TeamError('TEAM_MESSAGE_INVALID', '消息不能为空。', 400);
    }
    if (body.length > team.config.limits.maxMessageChars) {
      throw new TeamError('TEAM_MESSAGE_INVALID', `消息超过 ${team.config.limits.maxMessageChars} 字上限。`, 400);
    }
    if (input.clientMessageId.trim().length === 0 || input.clientMessageId.length > 200) {
      throw new TeamError('TEAM_MESSAGE_INVALID', 'clientMessageId 不合法。', 400);
    }
    const sequence = (await this.teamStore.listMessages(run.id, 0, 1)).total + 1;
    const message: TeamMessage = {
      id: newId('msg'),
      teamId: team.id,
      runId: run.id,
      senderId: input.senderId,
      senderKind: input.senderKind,
      recipientId: recipient.id,
      clientMessageId: input.clientMessageId,
      body,
      sequence,
      state: 'accepted',
      createdAt: this.#now().toISOString(),
      injectedAt: null,
      processedAt: null,
      activationId: null,
      error: null,
    };
    const appended = await this.teamStore.appendMessage({
      message,
      maxMessages: team.config.limits.maxMessages,
      maxQueuedPerMember: team.config.limits.maxQueuedMessagesPerMember,
      event: {
        kind: 'message.accepted',
        payload: { messageId: message.id, recipientId: recipient.id, senderKind: input.senderKind },
      },
    });
    if (appended.duplicate) return appended;
    // A message to an idle member may start an activation, bounded so two
    // members cannot wake each other forever.
    if (recipient.status === 'idle') {
      const activations = await this.teamStore.listActivations(run.id, recipient.id);
      const auto = activations.filter((activation) => activation.input.kind === 'message').length;
      if (auto < team.config.limits.maxAutoActivationsPerMember) {
        await this.runtime
          .followup(recipient.id, { kind: 'message', messageId: message.id, text: message.body })
          .catch(() => undefined);
      }
    }
    return appended;
  }

  /**
   * Deliver a mid-run instruction to the root member.
   *
   * If the root is busy it is queued and delivered at the next model-step
   * boundary (the same mailbox path as a peer message, with the user as the
   * source). If it is idle it starts a new activation. It never creates a
   * second concurrent root turn.
   */
  async steerRun(input: {
    readonly ownerId: string;
    readonly runId: string;
    readonly message: string;
    readonly clientMessageId?: string;
  }): Promise<{ message: TeamMessage; activation: Activation | null }> {
    const run = await this.getRun(input.ownerId, input.runId);
    if (isTerminalRunStatus(run.status) || run.status === 'stopping') {
      throw new TeamError('TEAM_RUN_TERMINAL', '这次运行已经结束，不能再追加指令。', 409);
    }
    if (!run.rootMemberId) {
      throw new TeamError('TEAM_MEMBER_NOT_FOUND', '这次运行还没有主成员。', 409);
    }
    const result = await this.sendMessage({
      ownerId: input.ownerId,
      runId: run.id,
      senderId: input.ownerId,
      senderKind: 'user',
      recipientId: run.rootMemberId,
      clientMessageId: input.clientMessageId?.trim() || newId('steer'),
      body: input.message,
    });
    const activations = await this.teamStore.listActivations(run.id, run.rootMemberId);
    return {
      message: result.message,
      activation: activations.find((entry) => entry.status === 'queued') ?? null,
    };
  }

  async listMessages(
    ownerId: string,
    runId: string,
    afterSequence = 0,
    limit = 100,
  ): Promise<{ items: TeamMessage[]; total: number }> {
    await this.getRun(ownerId, runId);
    const page = await this.teamStore.listMessages(
      runId,
      afterSequence,
      Math.min(200, Math.max(1, limit)),
    );
    return { items: [...page.items], total: page.total };
  }

  // -------------------------------------------------------------- artifacts ---

  async recordArtifact(input: {
    readonly ownerId: string;
    readonly runId: string;
    readonly memberId: string;
    readonly taskId?: string | null;
    readonly attemptId?: string | null;
    readonly kind: Artifact['kind'];
    readonly manifest: ArtifactManifest;
    readonly testEvidence?: readonly string[];
  }): Promise<Artifact> {
    const run = await this.getRun(input.ownerId, input.runId);
    const artifact: Artifact = {
      id: newId('art'),
      teamId: run.teamId,
      runId: run.id,
      taskId: input.taskId ?? null,
      attemptId: input.attemptId ?? null,
      memberId: input.memberId,
      kind: input.kind,
      manifest: input.manifest,
      testEvidence: input.testEvidence ?? [],
      createdAt: this.#now().toISOString(),
    };
    return this.teamStore.createArtifact({
      artifact,
      event: { kind: 'artifact.created', payload: { artifactId: artifact.id, memberId: artifact.memberId } },
    });
  }

  async diffMemberWorkspace(input: {
    readonly ownerId: string;
    readonly runId: string;
    readonly memberId: string;
  }): Promise<ArtifactManifest> {
    const run = await this.getRun(input.ownerId, input.runId);
    const member = await this.getMember(input.ownerId, input.memberId);
    if (!member.workspaceId) {
      throw new TeamError('TEAM_WORKSPACE', '这个成员没有隔离工作区。', 409);
    }
    const activations = await this.teamStore.listActivations(run.id, member.id);
    const baselineId =
      (activations.at(-1)?.checkpoint as { baselineId?: string } | undefined)?.baselineId ?? null;
    if (!baselineId) {
      throw new TeamError('TEAM_WORKSPACE', '这个成员没有基线快照。', 409);
    }
    return this.#deps.workspace.diff({ workspaceTaskId: member.workspaceId, baselineId });
  }

  async listArtifacts(ownerId: string, runId: string): Promise<Artifact[]> {
    await this.getRun(ownerId, runId);
    return this.teamStore.listArtifacts({ runId, limit: 200 });
  }

  // ---------------------------------------------------------------- cleanup ---

  /**
   * Remove a member workspace only when nothing still references it.
   *
   * Artifacts, non-terminal tasks and open integration candidates protect the
   * directory. Closing a member is explicitly not a reason to delete its output.
   */
  async cleanupMemberWorkspace(input: {
    readonly ownerId: string;
    readonly runId: string;
    readonly memberId: string;
  }): Promise<{ removed: boolean; reason: string }> {
    const run = await this.getRun(input.ownerId, input.runId);
    const member = await this.getMember(input.ownerId, input.memberId);
    if (!member.workspaceId || !this.#deps.workspace.cleanup) {
      return { removed: false, reason: 'no workspace' };
    }
    const artifacts = (await this.teamStore.listArtifacts({ runId: run.id, limit: 1_000 })).filter(
      (artifact) => artifact.memberId === member.id,
    );
    if (artifacts.length > 0) return { removed: false, reason: 'artifacts still referenced' };
    const tasks = await this.teamStore.listTasks(run.id, { limit: 1_000 });
    const active = tasks.items.filter(
      (task) =>
        task.ownerId === member.id && !['accepted', 'cancelled', 'failed'].includes(task.status),
    );
    if (active.length > 0) return { removed: false, reason: 'active task references member' };
    const integrations = await this.teamStore.listIntegrations(run.id);
    const open = integrations.filter(
      (integration) => !['published', 'failed'].includes(integration.status),
    );
    if (open.length > 0) return { removed: false, reason: 'open integration candidate' };
    const removed = await this.#deps.workspace.cleanup({
      workspaceTaskId: member.workspaceId,
      referenced: false,
    });
    return { removed, reason: removed ? 'removed' : 'workspace cleanup refused' };
  }

  // ------------------------------------------------------- mcp interactions ---

  /** Pending MCP approvals/elicitations owned by this run's members. */
  async listMcpInteractions(
    ownerId: string,
    runId: string,
  ): Promise<Array<McpInteractionRecord & { memberId: string; memberName: string }>> {
    if (!this.#deps.mcp) return [];
    const run = await this.getRun(ownerId, runId);
    const members = await this.teamStore.listMembers(run.teamId);
    const result: Array<McpInteractionRecord & { memberId: string; memberName: string }> = [];
    for (const member of members) {
      if (['closed', 'failed'].includes(member.status)) continue;
      const interactions = await this.#deps.mcp
        .listInteractions(ownerId, member.internalConversationId)
        .catch(() => []);
      for (const interaction of interactions) {
        if (interaction.status !== 'pending') continue;
        result.push({ ...interaction, memberId: member.id, memberName: member.name });
      }
    }
    return result;
  }

  /** Remote MCP tasks still open in this run's member conversations. */
  async listMcpTasks(
    ownerId: string,
    runId: string,
  ): Promise<Array<import('../mcp/types.ts').McpTaskRecord & { memberId: string; memberName: string }>> {
    if (!this.#deps.mcp) return [];
    const run = await this.getRun(ownerId, runId);
    const members = await this.teamStore.listMembers(run.teamId);
    const result: Array<import('../mcp/types.ts').McpTaskRecord & { memberId: string; memberName: string }> = [];
    for (const member of members) {
      if (['closed', 'failed'].includes(member.status)) continue;
      const tasks = await this.#deps.mcp
        .listTasks(ownerId, member.internalConversationId)
        .catch(() => []);
      for (const task of tasks) {
        if (['completed', 'failed', 'cancelled', 'expired'].includes(task.status)) continue;
        result.push({ ...task, memberId: member.id, memberName: member.name });
      }
    }
    return result;
  }

  async cancelMcpTask(input: {
    readonly ownerId: string;
    readonly runId: string;
    readonly taskId: string;
  }): Promise<import('../mcp/types.ts').McpTaskRecord> {
    if (!this.#deps.mcp) {
      throw new TeamError('TEAM_FORBIDDEN', '这个部署没有 MCP 宿主。', 409);
    }
    const tasks = await this.listMcpTasks(input.ownerId, input.runId);
    if (!tasks.some((task) => task.id === input.taskId)) {
      throw new TeamError('TEAM_TASK_NOT_FOUND', '这个 MCP 任务不属于当前运行，或已结束。', 404);
    }
    return this.#deps.mcp.cancelTask(input.ownerId, input.taskId);
  }

  async decideMcpInteraction(input: {
    readonly ownerId: string;
    readonly runId: string;
    readonly interactionId: string;
    readonly action: 'accept' | 'reject' | 'cancel';
    readonly response?: unknown;
  }): Promise<McpInteractionRecord | null> {
    if (!this.#deps.mcp) {
      throw new TeamError('TEAM_FORBIDDEN', '这个部署没有 MCP 宿主。', 409);
    }
    const pending = await this.listMcpInteractions(input.ownerId, input.runId);
    if (!pending.some((entry) => entry.id === input.interactionId)) {
      throw new TeamError('TEAM_TASK_NOT_FOUND', '这个交互不属于当前运行，或已失效。', 404);
    }
    return this.#deps.mcp.resolveInteraction({
      userId: input.ownerId,
      interactionId: input.interactionId,
      action: input.action,
      ...(input.response !== undefined ? { response: input.response } : {}),
    });
  }

  // --------------------------------------------------------------- resources ---

  /**
   * Explicit, expiring, revocable image grant for one member.
   *
   * The grant is journalled as an event (owner, asset, member, purpose, expiry)
   * so it can be audited and revoked; the bytes still come from private media
   * storage and never from a URL. The asset must belong to the owner.
   */
  async grantImage(input: {
    readonly ownerId: string;
    readonly runId: string;
    readonly memberId: string;
    readonly assetId: string;
    readonly purpose: string;
    readonly ttlSeconds?: number;
  }): Promise<Record<string, unknown>> {
    const run = await this.getRun(input.ownerId, input.runId);
    await this.getMember(input.ownerId, input.memberId);
    const asset = await this.#deps.store.getMediaAsset(input.ownerId, input.assetId);
    if (!asset || asset.status === 'released') {
      throw new TeamError('TEAM_CAPABILITY', '图片不存在或不属于当前用户。', 404);
    }
    const ttl = Math.min(3600, Math.max(30, input.ttlSeconds ?? 900));
    const grant = {
      grantId: newId('grant'),
      memberId: input.memberId,
      assetId: input.assetId,
      purpose: input.purpose,
      grantedBy: input.ownerId,
      expiresAt: new Date(this.#now().getTime() + ttl * 1_000).toISOString(),
    };
    await this.teamStore.appendEvent(run.teamId, run.id, {
      kind: 'resource.granted',
      payload: grant,
    });
    return { ...grant, runId: run.id };
  }

  async revokeImage(input: {
    readonly ownerId: string;
    readonly runId: string;
    readonly memberId: string;
    readonly assetId: string;
  }): Promise<void> {
    const run = await this.getRun(input.ownerId, input.runId);
    await this.getMember(input.ownerId, input.memberId);
    await this.teamStore.appendEvent(run.teamId, run.id, {
      kind: 'resource.revoked',
      payload: { memberId: input.memberId, assetId: input.assetId, revokedBy: input.ownerId },
    });
  }

  /** Active (unexpired, unrevoked) image asset ids for one member. */
  async activeImageGrants(runId: string, memberId: string): Promise<Record<string, unknown>[]> {
    const events = await this.teamStore.listEvents(runId, 0, 2_000);
    const granted = new Map<string, Record<string, unknown>>();
    for (const event of events) {
      if (event.kind === 'resource.granted' && event.payload['memberId'] === memberId) {
        const assetId = event.payload['assetId'];
        if (typeof assetId === 'string') granted.set(assetId, event.payload);
      } else if (event.kind === 'resource.revoked' && event.payload['memberId'] === memberId) {
        const assetId = event.payload['assetId'];
        if (typeof assetId === 'string') granted.delete(assetId);
      }
    }
    const now = this.#now().getTime();
    return [...granted.values()].filter((grant) => {
      const expiresAt = grant['expiresAt'];
      return typeof expiresAt === 'string' && Date.parse(expiresAt) > now;
    });
  }

  async #requireImageGrants(
    runId: string,
    memberId: string,
    assetIds: readonly string[],
  ): Promise<void> {
    const active = new Set(
      (await this.activeImageGrants(runId, memberId)).map((grant) => grant['assetId']),
    );
    const missing = assetIds.filter((assetId) => !active.has(assetId));
    if (missing.length > 0) {
      throw new TeamError(
        'TEAM_FORBIDDEN',
        '成员没有这些图片的有效授权（或授权已过期/撤销）。',
        403,
        { missing },
      );
    }
  }

  // -------------------------------------------------------------- approvals ---

  /**
   * Pending sandbox approvals bound to this run's members.
   *
   * The view carries the member, activation/generation, request digest and
   * policy version. It never carries credentials or raw tool parameters.
   */
  async listApprovals(ownerId: string, runId: string): Promise<TeamApprovalView[]> {
    if (!this.#deps.approvals) return [];
    const run = await this.getRun(ownerId, runId);
    const members = await this.teamStore.listMembers(run.teamId);
    const views: TeamApprovalView[] = [];
    for (const member of members) {
      if (member.status === 'closed' || member.status === 'failed') continue;
      const activations = await this.teamStore.listActivations(runId, member.id);
      const current = activations.at(-1) ?? null;
      const pending = await this.#deps.approvals.list({
        ownerId,
        runId,
        member,
        activationId: current?.id ?? null,
        generation: current?.generation ?? null,
      });
      views.push(...pending);
    }
    return views;
  }

  async decideApproval(input: {
    readonly ownerId: string;
    readonly runId: string;
    readonly approvalRequestId: string;
    readonly decision: 'approved' | 'denied';
    readonly reason: string;
  }): Promise<TeamApprovalView> {
    if (!this.#deps.approvals) {
      throw new TeamError('TEAM_FORBIDDEN', '这个部署没有配置沙箱审批。', 409);
    }
    const run = await this.getRun(input.ownerId, input.runId);
    const members = await this.teamStore.listMembers(run.teamId);
    for (const member of members) {
      const pending = await this.#deps.approvals
        .list({
          ownerId: input.ownerId,
          runId: run.id,
          member,
          activationId: null,
          generation: null,
        })
        .catch(() => []);
      if (!pending.some((entry) => entry.approvalRequestId === input.approvalRequestId)) {
        continue;
      }
      return this.#deps.approvals.decide({
        ownerId: input.ownerId,
        runId: run.id,
        member,
        approvalRequestId: input.approvalRequestId,
        decision: input.decision,
        reason: input.reason,
      });
    }
    throw new TeamError('TEAM_TASK_NOT_FOUND', '这个审批不属于当前运行，或已失效。', 404);
  }

  // ------------------------------------------------------------- activation ---

  async toolsFor(member: Member, activation: Activation): Promise<readonly ToolDefinition[]> {
    const run = await this.teamStore.getRun(activation.runId);
    const team = await this.teamStore.getTeam(member.teamId);
    if (!run || !team) return [];
    const caller: TeamToolCaller = { team, run, member, activation };
    const tools = createTeamTools(this, caller);
    const allowed = member.permissions.allowedTools;
    return allowed === null ? tools : tools.filter((tool) => allowed.includes(tool.name));
  }

  async workspaceFor(member: Member): Promise<ToolSandboxSession | null> {
    if (!member.workspaceId) return null;
    const team = await this.teamStore.getTeam(member.teamId);
    if (!team) return null;
    return this.#deps.workspace.session({
      userId: team.ownerId,
      workspaceTaskId: member.workspaceId,
      sessionId: member.internalConversationId,
    });
  }

  async provisionWorkspace(input: {
    team: Team;
    run: TeamRun;
    memberId: string;
    name: string;
    mode: Member['workspaceMode'];
    snapshotFrom: string | null;
  }): Promise<{ workspaceId: string; workspaceTaskId: string }> {
    void input.snapshotFrom;
    const provisioned = await this.#deps.workspace.provision({
      teamId: input.team.id,
      runId: input.run.id,
      ownerId: input.team.ownerId,
      memberId: input.memberId,
      name: input.name,
      mode: input.mode,
    });
    return {
      workspaceId: provisioned.workspaceTaskId,
      workspaceTaskId: provisioned.workspaceTaskId,
    };
  }

  async contextFor(input: {
    team: Team;
    run: TeamRun;
    member: Member;
    activation: Activation;
  }): Promise<{ block: string; workspacePath: string | null; budget: string }> {
    const page = await this.teamStore.listTasks(input.run.id, { limit: 200 });
    const budget = await this.teamStore.budgetSnapshot(input.run.id);
    const workspacePath = input.member.workspaceId
      ? (await this.#deps.workspace.currentHashes(input.member.workspaceId).catch(() => null)) !== null
        ? input.member.workspaceId
        : input.member.workspaceId
      : null;
    const involvedTasks = page.items.filter(
      (task) =>
        task.ownerId === input.member.id ||
        input.member.role === 'root' ||
        (input.activation.input.taskId && task.id === input.activation.input.taskId),
    );
    const block = renderMemberContext({
      member: input.member,
      activationId: input.activation.id,
      tasks: involvedTasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        required: task.required,
        dependencies: task.dependencies,
        acceptance: task.acceptance,
      })),
      writeScopes: unique(involvedTasks.flatMap((task) => task.writeScopes)),
      workspacePath,
      budget: `请求 ${budget.remainingRequests}｜输入 ${budget.remainingInputTokens}｜输出 ${budget.remainingOutputTokens}`,
      nowIso: this.#now().toISOString(),
    });
    return { block, workspacePath, budget: `${budget.remainingRequests} 次请求` };
  }

  async authorizeModelCall(input: AuthorizeModelCallInput): Promise<ModelCallGrant> {
    const snapshot = await this.teamStore.budgetSnapshot(input.runId);
    if (snapshot.exhausted) {
      throw new TeamError('TEAM_BUDGET_EXHAUSTED', '团队预算已用尽，停止新的模型请求。', 409, {
        snapshot,
      });
    }
    const output = Math.min(
      input.maxOutputTokens,
      Math.max(0, snapshot.remainingOutputTokens),
    );
    if (output <= 0) {
      throw new TeamError('TEAM_BUDGET_EXHAUSTED', '团队输出 Token 预算已用尽。', 409, {
        dimension: 'output',
        snapshot,
      });
    }
    let reservation: BudgetReservation;
    try {
      reservation = await this.teamStore.reserveBudget({
        id: newId('budget'),
        runId: input.runId,
        memberId: input.memberId,
        activationId: input.activationId,
        requestKey: input.requestKey,
        generation: input.generation,
        inputTokens: input.estimatedInputTokens,
        outputTokens: output,
        estimatedCostUsd: null,
        priceVersion: null,
        now: this.#now().toISOString(),
        event: { kind: 'budget.reserved', payload: { requestKey: input.requestKey, memberId: input.memberId } },
      });
    } catch (error) {
      if (error instanceof TeamError) throw error;
      throw new TeamError('TEAM_BUDGET_CONFLICT', '预算预留失败。', 409);
    }
    const entryId = reservation.entry.id;
    return {
      settle: async (usage) => {
        if (!usage) {
          await this.teamStore.settleBudget({
            entryId,
            usage: { inputTokens: null, outputTokens: null, cachedTokens: null },
            incomplete: true,
            now: this.#now().toISOString(),
            event: { kind: 'budget.settled', payload: { requestKey: input.requestKey, incomplete: true } },
          });
          return;
        }
        const inputTokens = usage.reported === false ? null : usage.inputTokens;
        const outputTokens = usage.reported === false ? null : usage.outputTokens;
        await this.teamStore.settleBudget({
          entryId,
          usage: {
            inputTokens,
            outputTokens,
            cachedTokens: usage.cacheReported === false ? null : usage.cachedTokens,
          },
          incomplete: inputTokens === null || outputTokens === null,
          now: this.#now().toISOString(),
          event: { kind: 'budget.settled', payload: { requestKey: input.requestKey } },
        });
      },
      release: async (reason) => {
        await this.teamStore
          .settleBudget({
            entryId,
            usage: { inputTokens: null, outputTokens: null, cachedTokens: null },
            incomplete: true,
            now: this.#now().toISOString(),
          })
          .catch(() => undefined);
        log.warn('team.budget_release', { request_key: input.requestKey, reason });
      },
    };
  }

  async acquireModelSlot(runId: string, signal?: AbortSignal): Promise<() => void> {
    const run = await this.teamStore.getRun(runId);
    const team = run ? await this.teamStore.getTeam(run.teamId) : null;
    const max = Math.max(1, team?.config.limits.maxConcurrentModelRequests ?? 1);
    const state = this.#slots.get(runId) ?? { active: 0, waiters: [] };
    this.#slots.set(runId, state);
    if (state.active < max) {
      state.active += 1;
      return this.#slotRelease(runId, state);
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: SlotWaiter = {
        resolve: () => {
          state.active += 1;
          resolve(this.#slotRelease(runId, state));
        },
        reject,
      };
      state.waiters.push(waiter);
      if (signal) {
        if (signal.aborted) {
          state.waiters.splice(state.waiters.indexOf(waiter), 1);
          reject(abortError());
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            const index = state.waiters.indexOf(waiter);
            if (index >= 0) {
              state.waiters.splice(index, 1);
              reject(abortError());
            }
          },
          { once: true },
        );
      }
    });
  }

  #slotRelease(runId: string, state: { active: number; waiters: SlotWaiter[] }): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = state.waiters.shift();
      if (next) next.resolve();
      else state.active = Math.max(0, state.active - 1);
      if (state.active === 0 && state.waiters.length === 0) this.#slots.delete(runId);
    };
  }

  async takeMailbox(member: Member, activation: Activation): Promise<MailboxDelivery> {
    const pending = await this.teamStore.pendingMessages(member.id, 8);
    const injected: TeamMessage[] = [];
    for (const message of pending) {
      const updated = await this.teamStore.markMessage(message.id, ['accepted'], {
        state: 'injected',
        injectedAt: this.#now().toISOString(),
        activationId: activation.id,
      }, {
        kind: 'message.injected',
        payload: { messageId: message.id, activationId: activation.id },
      });
      if (updated) injected.push(updated);
    }
    if (injected.length === 0) {
      return {
        items: [],
        markProcessed: async () => undefined,
        requeue: async () => undefined,
      };
    }
    const items = injected.map((message) => ({
      type: 'message' as const,
      role: 'user' as const,
      source: 'team_message' as const,
      content: renderCollaborationMessage({
        senderName: message.senderId,
        senderId: message.senderId,
        runId: message.runId,
        body: message.body,
      }),
    }));
    return {
      items,
      markProcessed: async () => {
        for (const message of injected) {
          await this.teamStore.markMessage(message.id, ['injected'], {
            state: 'processed',
            processedAt: this.#now().toISOString(),
          }, {
            kind: 'message.processed',
            payload: { messageId: message.id },
          });
        }
      },
      requeue: async () => {
        for (const message of injected) {
          await this.teamStore.markMessage(message.id, ['injected'], {
            state: 'accepted',
            injectedAt: null,
            activationId: null,
          }, {
            kind: 'message.accepted',
            payload: { messageId: message.id, requeued: true },
          });
        }
      },
    };
  }

  async onActivationFinished(input: {
    activation: Activation;
    member: Member;
    outcome: 'succeeded' | 'failed' | 'interrupted' | 'unknown';
    summary: string;
    error: string | null;
    taskId: string | null;
  }): Promise<void> {
    const run = await this.teamStore.getRun(input.activation.runId);
    if (!run || isTerminalRunStatus(run.status)) return;
    if (input.taskId) {
      const task = await this.teamStore.getTask(input.taskId);
      if (task && task.status === 'running') {
        if (input.outcome === 'succeeded') {
          // The member finished without submitting. Return the claim so another
          // activation (or the root) can act; the attempt stays as history.
          await this.teamStore.updateTask({
            taskId: task.id,
            expectedRevision: task.revision,
            patch: {
              status: 'pending',
              currentAttemptId: null,
              // Release the owner as well. Re-dispatching the same task
              // immediately would be an endless loop; the root reassigns it or
              // the member claims it again deliberately.
              ownerId: null,
              failureReason: '成员执行结束但没有提交',
            },
            now: this.#now().toISOString(),
            event: {
              kind: 'task.updated',
              payload: {
                taskId: task.id,
                status: 'pending',
                reason: 'activation-ended-without-submit',
              },
            },
          });
        } else if (input.outcome !== 'interrupted') {
          const updated = await this.teamStore.updateTask({
            taskId: task.id,
            expectedRevision: task.revision,
            patch: { status: 'failed', failureReason: input.error ?? '执行失败' },
            now: this.#now().toISOString(),
            event: {
              kind: 'task.updated',
              payload: { taskId: task.id, status: 'failed', error: input.error },
            },
          });
          void updated;
        }
      }
    }
    if (input.member.role === 'root') {
      await this.#evaluateRun(run.id, input.summary || null);
    } else {
      if (input.outcome === 'succeeded') {
        await this.dispatchReady(run.id).catch(() => undefined);
      }
      // Any member finishing can be the event that completes the run: the root
      // may already have answered while a worker was still running. The run
      // summary stays the root's, never a worker's.
      await this.#evaluateRun(run.id, null).catch(() => undefined);
    }
  }

  profileFor(member: Member): import('../models/types.ts').ModelProfile {
    const profileFor = this.#deps.modelProfileFor ?? modelProfile;
    return profileFor(member.profile.modelId);
  }

  maxStepsFor(member: Member): number {
    return member.profile.maxSteps || this.#deps.maxSteps || 12;
  }

  // ------------------------------------------------------------ tools host ---

  async spawnFromTool(
    caller: TeamToolCaller,
    args: {
      name?: string;
      task?: string;
      context?: 'fresh' | 'fork';
      forkSeq?: number;
      role?: Member['role'];
      modelId?: string;
    },
  ): Promise<{ member: Member; activation: Activation | null }> {
    return this.runtime.spawn({
      team: caller.team,
      run: caller.run,
      parent: caller.member,
      ...(args.name ? { name: args.name } : {}),
      ...(args.role ? { role: args.role } : {}),
      ...(args.context ? { contextMode: args.context } : {}),
      ...(args.forkSeq !== undefined ? { forkSeq: args.forkSeq } : {}),
      ...(args.modelId ? { profile: { modelId: args.modelId } } : {}),
      input: { kind: 'spawn', text: args.task?.trim() || '请开始工作。' },
    });
  }

  async sendFromTool(
    caller: TeamToolCaller,
    args: { recipientId: string; body: string; clientMessageId: string },
  ): Promise<{ message: TeamMessage; duplicate: boolean }> {
    return this.sendMessage({
      ownerId: caller.team.ownerId,
      runId: caller.run.id,
      senderId: caller.member.id,
      senderKind: caller.member.role === 'root' ? 'root' : 'member',
      recipientId: args.recipientId,
      clientMessageId: args.clientMessageId,
      body: args.body,
    });
  }

  async waitFromTool(
    caller: TeamToolCaller,
    args: {
      kind: 'activation' | 'message' | 'task' | 'member';
      activationId?: string;
      taskId?: string;
      memberId?: string;
      sinceSequence?: number;
      timeoutMs?: number;
    },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const timeoutMs = Math.min(120_000, Math.max(1_000, args.timeoutMs ?? 30_000));
    const deadline = Date.now() + timeoutMs;
    const since = args.sinceSequence ?? 0;
    for (;;) {
      if (signal?.aborted) return { reason: 'cancelled' };
      const latest = await this.teamStore.listEvents(caller.run.id, since, 50);
      const matched = latest.find((event) => {
        if (args.kind === 'activation' && args.activationId) {
          return event.payload['activationId'] === args.activationId && event.kind === 'activation.finished';
        }
        if (args.kind === 'task' && args.taskId) {
          return event.payload['taskId'] === args.taskId && ['task.reviewed', 'task.updated'].includes(event.kind);
        }
        if (args.kind === 'member' && args.memberId) {
          return event.payload['memberId'] === args.memberId && event.kind === 'member.status';
        }
        if (args.kind === 'message') return event.kind === 'message.accepted';
        return false;
      });
      if (matched) {
        return {
          reason: args.kind,
          sequence: matched.sequence,
          event: matched,
          cursor: matched.sequence,
        };
      }
      if (Date.now() >= deadline) {
        return {
          reason: 'timeout',
          cursor: latest.at(-1)?.sequence ?? since,
          note: '等待超时，没有满足条件的变更。',
        };
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 100);
        timer.unref?.();
      });
    }
  }

  async listFromTool(caller: TeamToolCaller): Promise<{
    members: Member[];
    run: TeamRun;
    team: Team;
  }> {
    return {
      members: await this.teamStore.listMembers(caller.team.id),
      run: caller.run,
      team: caller.team,
    };
  }

  async interruptFromTool(caller: TeamToolCaller, memberId: string): Promise<Member> {
    await this.getMember(caller.team.ownerId, memberId);
    return this.runtime.interrupt(memberId);
  }

  async closeFromTool(caller: TeamToolCaller, memberId: string): Promise<Member[]> {
    await this.getMember(caller.team.ownerId, memberId);
    return this.runtime.close(memberId);
  }

  // ---------------------------------------------------------------- events ---

  async listEvents(
    ownerId: string,
    runId: string,
    afterSequence: number,
    limit = 200,
  ): Promise<{ items: import('./types.ts').TeamEvent[]; latest: number }> {
    await this.getRun(ownerId, runId);
    const items = await this.teamStore.listEvents(runId, afterSequence, Math.min(500, Math.max(1, limit)));
    return { items, latest: items.at(-1)?.sequence ?? afterSequence };
  }

  async subscribeRun(
    ownerId: string,
    runId: string,
    listener: (event: import('./types.ts').TeamEvent) => void,
  ): Promise<() => void> {
    await this.getRun(ownerId, runId);
    let last = (await this.teamStore.latestEventSequence(runId));
    let stopped = false;
    const timer = setInterval(() => {
      void (async () => {
        if (stopped) return;
        const events = await this.teamStore.listEvents(runId, last, 100).catch(() => []);
        for (const event of events) {
          last = event.sequence;
          listener(event);
        }
      })();
    }, 150);
    timer.unref?.();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  // ---------------------------------------------------------------- repair ---

  async recover(): Promise<{ interrupted: number; unknown: number }> {
    return this.runtime.recover();
  }

  /** Verify a completed run's invariants; used by diagnostics and tests. */
  async completionReport(runId: string): Promise<{
    complete: boolean;
    required: Array<{ id: string; status: string }>;
    outstanding: string[];
    conflicts: number;
    usage: UsageTotals;
    budget: BudgetSnapshot;
    integrations: Integration[];
  }> {
    const tasks = await this.teamStore.listTasks(runId, { limit: 1_000 });
    const required = tasks.items.filter((task) => task.required);
    const outstanding = tasks.items
      .filter((task) => ['pending', 'running', 'submitted'].includes(task.status))
      .map((task) => task.id);
    const integrations = await this.teamStore.listIntegrations(runId);
    const conflicts = integrations.filter((integration) => integration.status === 'conflict').length;
    return {
      complete:
        required.every((task) => task.status === 'accepted') &&
        outstanding.length === 0 &&
        conflicts === 0,
      required: required.map((task) => ({ id: task.id, status: task.status })),
      outstanding,
      conflicts,
      usage: await this.teamStore.runUsage(runId),
      budget: await this.teamStore.budgetSnapshot(runId),
      integrations,
    };
  }

  /**
   * Build an integration candidate from a member's private workspace.
   *
   * The candidate is compared against the source root's current hashes, not
   * against an assumption that the member started from an empty tree. Conflicts
   * are stored with both sides' content hashes and keep the candidate in
   * `conflict`; publishing is refused until a human resolves it.
   */
  async createIntegrationCandidate(input: {
    readonly ownerId: string;
    readonly runId: string;
    readonly taskId: string;
    readonly memberId: string;
    readonly otherMemberId?: string | null;
  }): Promise<{ integration: Integration; manifest: ArtifactManifest }> {
    const run = await this.getRun(input.ownerId, input.runId);
    const task = await this.teamStore.getTask(input.taskId);
    if (!task || task.runId !== run.id) {
      throw new TeamError('TEAM_TASK_NOT_FOUND', '没有这个任务。', 404);
    }
    const member = await this.getMember(input.ownerId, input.memberId);
    if (!member.workspaceId) {
      throw new TeamError('TEAM_WORKSPACE', '这个成员没有隔离工作区。', 409);
    }
    const baseline = await this.#deps.workspace.baselineForWorkspace?.(
      member.workspaceId,
    );
    if (!baseline) {
      throw new TeamError('TEAM_WORKSPACE', '这个成员没有基线快照。', 409);
    }
    const manifest = await this.#deps.workspace.diff({
      workspaceTaskId: member.workspaceId,
      baselineId: baseline.baselineId,
    });
    const root = (await this.teamStore.listMembers(run.teamId)).find(
      (entry) => entry.role === 'root',
    );
    const sourceHashes = root?.workspaceId
      ? await this.#deps.workspace.currentHashes(root.workspaceId)
      : {};
    const baseHashes: Record<string, string> = {};
    for (const file of manifest.files) {
      if (file.baseHash) baseHashes[file.path] = file.baseHash;
    }
    let other: ArtifactManifest | null = null;
    if (input.otherMemberId) {
      const otherMember = await this.getMember(input.ownerId, input.otherMemberId);
      const otherBaseline = otherMember.workspaceId
        ? await this.#deps.workspace.baselineForWorkspace?.(otherMember.workspaceId)
        : null;
      if (otherMember.workspaceId && otherBaseline) {
        other = await this.#deps.workspace.diff({
          workspaceTaskId: otherMember.workspaceId,
          baselineId: otherBaseline.baselineId,
        });
      }
    }
    const merged = integrateManifests({
      targetRoot: this.#deps.workspace.sourceRootPath?.() ?? '',
      baseHashes,
      candidate: manifest,
      other,
      sourceHashes,
    });
    const resultHashes: Record<string, string> = {};
    for (const file of merged.files) {
      resultHashes[file.path] = file.contentHash ?? '';
    }
    await this.recordArtifact({
      ownerId: input.ownerId,
      runId: run.id,
      memberId: member.id,
      taskId: task.id,
      attemptId: task.currentAttemptId,
      kind: 'patch',
      manifest,
    });
    const integration = await this.recordIntegration({
      ownerId: input.ownerId,
      runId: run.id,
      taskId: task.id,
      baseVersion: baseline.baselineId,
      candidateHash: merged.candidateHash,
      conflicts: merged.conflicts.map((conflict) => conflict.path),
      baseHashes,
      resultHashes,
      verification: {
        memberId: member.id,
        ...(merged.conflictContent && Object.keys(merged.conflictContent).length > 0
          ? { conflictContent: merged.conflictContent }
          : {}),
      },
      journal: [
        {
          at: this.#now().toISOString(),
          action: 'created',
          files: merged.files.map((file) => file.path),
          detail: merged.conflicts.length > 0 ? 'conflicts detected' : 'clean candidate',
        },
      ],
    });
    return { integration, manifest };
  }

  /** Both sides of every unresolved conflict, for the review UI. */
  async integrationConflictDetail(input: {
    readonly ownerId: string;
    readonly integrationId: string;
  }): Promise<{
    integration: Integration;
    conflicts: Array<{
      path: string;
      baseHash: string | null;
      source: { content: string | null; hash: string | null };
      candidate: { content: string | null; hash: string | null };
      other: string | null;
    }>;
  }> {
    const integration = await this.teamStore.getIntegration(input.integrationId);
    if (!integration) throw new TeamError('TEAM_INTEGRATION_CONFLICT', '没有这个集成候选。', 404);
    await this.getRun(input.ownerId, integration.runId);
    const task = integration.taskId ? await this.teamStore.getTask(integration.taskId) : null;
    const recordedMemberId = integration.verification?.['memberId'];
    const memberId = task?.ownerId ?? (typeof recordedMemberId === 'string' ? recordedMemberId : null);
    const member = memberId ? await this.teamStore.getMember(memberId) : null;
    const conflictContent =
      (integration.verification?.['conflictContent'] as
        | Record<string, { candidate: string | null; other: string | null }>
        | undefined) ?? {};
    const conflicts = [];
    for (const path of integration.conflicts) {
      const source = member?.workspaceId
        ? await this.#deps.workspace.readSourceFile?.(path).catch(() => null)
        : await this.#deps.workspace.readSourceFile?.(path).catch(() => null);
      const candidate =
        member?.workspaceId
          ? await this.#deps.workspace.readWorkspaceFile?.(member.workspaceId, path).catch(() => null)
          : null;
      conflicts.push({
        path,
        baseHash: integration.baseHashes[path] ?? null,
        source: { content: source?.content ?? null, hash: source?.hash ?? null },
        candidate: {
          content: candidate?.content ?? conflictContent[path]?.candidate ?? null,
          hash: candidate?.hash ?? null,
        },
        other: conflictContent[path]?.other ?? null,
      });
    }
    return { integration, conflicts };
  }

  /** Resolve one conflict by choosing source, candidate or explicit content. */
  async resolveIntegrationConflict(input: {
    readonly ownerId: string;
    readonly integrationId: string;
    readonly path: string;
    readonly resolution: 'source' | 'candidate' | 'manual';
    readonly content?: string;
  }): Promise<Integration> {
    const integration = await this.teamStore.getIntegration(input.integrationId);
    if (!integration) throw new TeamError('TEAM_INTEGRATION_CONFLICT', '没有这个集成候选。', 404);
    await this.getRun(input.ownerId, integration.runId);
    if (!integration.conflicts.includes(input.path)) {
      throw new TeamError('TEAM_INTEGRATION_CONFLICT', '这个路径不在冲突列表里。', 409);
    }
    const task = integration.taskId ? await this.teamStore.getTask(integration.taskId) : null;
    const recordedMemberId = integration.verification?.['memberId'];
    const memberId = task?.ownerId ?? (typeof recordedMemberId === 'string' ? recordedMemberId : null);
    const member = memberId ? await this.teamStore.getMember(memberId) : null;
    if (!member?.workspaceId) {
      throw new TeamError('TEAM_WORKSPACE', '找不到冲突所属的成员工作区。', 409);
    }
    let content: string;
    if (input.resolution === 'source') {
      const source = await this.#deps.workspace.readSourceFile?.(input.path);
      if (!source) throw new TeamError('TEAM_INTEGRATION_CONFLICT', '源文件不存在。', 409);
      content = source.content;
    } else if (input.resolution === 'candidate') {
      const candidate = await this.#deps.workspace.readWorkspaceFile?.(
        member.workspaceId,
        input.path,
      );
      if (!candidate) throw new TeamError('TEAM_INTEGRATION_CONFLICT', '候选文件不存在。', 409);
      content = candidate.content;
    } else {
      if (typeof input.content !== 'string') {
        throw new TeamError('TEAM_INTEGRATION_CONFLICT', '手工解决必须提供 content。', 400);
      }
      content = input.content;
    }
    await this.#deps.workspace.writeWorkspaceFile?.(member.workspaceId, input.path, content);
    const baseline = await this.#deps.workspace.baselineForWorkspace?.(member.workspaceId);
    if (!baseline) throw new TeamError('TEAM_WORKSPACE', '缺少基线，无法重算候选。', 409);
    const manifest = await this.#deps.workspace.diff({
      workspaceTaskId: member.workspaceId,
      baselineId: baseline.baselineId,
    });
    await this.recordArtifact({
      ownerId: input.ownerId,
      runId: integration.runId,
      memberId: member.id,
      taskId: integration.taskId,
      attemptId: task?.currentAttemptId ?? null,
      kind: 'patch',
      manifest,
    });
    const conflicts = integration.conflicts.filter((path) => path !== input.path);
    const verification: Record<string, unknown> = {
      ...(integration.verification ?? {}),
      resolved: {
        path: input.path,
        resolution: input.resolution,
        at: this.#now().toISOString(),
      },
    };
    const conflictContent = {
      ...((verification['conflictContent'] as Record<string, unknown> | undefined) ?? {}),
    };
    delete conflictContent[input.path];
    verification['conflictContent'] = conflictContent;
    const nowIso = this.#now().toISOString();
    const updated = await this.teamStore.updateIntegration({
      integrationId: integration.id,
      patch: {
        status: conflicts.length > 0 ? 'conflict' : 'resolved',
        conflicts,
        verification,
        journal: [
          ...integration.journal,
          { at: nowIso, action: 'resolved', files: [input.path], detail: input.resolution },
        ],
      },
      now: nowIso,
      event: {
        kind: 'integration.created',
        payload: { integrationId: integration.id, resolved: input.path, conflicts: conflicts.length },
      },
    });
    if (!updated) throw new TeamError('TEAM_INTEGRATION_CONFLICT', '集成候选已被修改。', 409);
    return updated;
  }

  /** Recompute the candidate comparison after a resolution; no publish. */
  async verifyIntegration(input: {
    readonly ownerId: string;
    readonly integrationId: string;
  }): Promise<Integration> {
    const integration = await this.teamStore.getIntegration(input.integrationId);
    if (!integration) throw new TeamError('TEAM_INTEGRATION_CONFLICT', '没有这个集成候选。', 404);
    const run = await this.getRun(input.ownerId, integration.runId);
    if (integration.conflicts.length > 0) {
      throw new TeamError('TEAM_INTEGRATION_CONFLICT', '仍有冲突，不能验证。', 409);
    }
    const task = integration.taskId ? await this.teamStore.getTask(integration.taskId) : null;
    const member = task?.ownerId ? await this.teamStore.getMember(task.ownerId) : null;
    const root = (await this.teamStore.listMembers(run.teamId)).find((entry) => entry.role === 'root');
    const sourceHashes = root?.workspaceId
      ? await this.#deps.workspace.currentHashes(root.workspaceId)
      : {};
    const nowIso = this.#now().toISOString();
    const updated = await this.teamStore.updateIntegration({
      integrationId: integration.id,
      patch: {
        status: 'verified',
        verification: {
          ...(integration.verification ?? {}),
          checkedAt: nowIso,
          sourceHashes,
          memberId: member?.id ?? null,
        },
        journal: [...integration.journal, { at: nowIso, action: 'verified' }],
      },
      now: nowIso,
      event: {
        kind: 'integration.created',
        payload: { integrationId: integration.id, verified: true },
      },
    });
    if (!updated) throw new TeamError('TEAM_INTEGRATION_CONFLICT', '集成候选已被修改。', 409);
    return updated;
  }

  /**
   * Publish a verified candidate to the source root with hash checks.
   *
   * Refuses a candidate with unresolved conflicts. The underlying publisher
   * writes per file atomically, journals what was applied, and uses the
   * integration id as the idempotency key.
   */
  async publishIntegration(input: {
    readonly ownerId: string;
    readonly integrationId: string;
    readonly memberId: string;
  }): Promise<{ integration: Integration; result: Awaited<ReturnType<typeof publishCandidate>> }> {
    const integration = await this.teamStore.getIntegration(input.integrationId);
    if (!integration) {
      throw new TeamError('TEAM_INTEGRATION_CONFLICT', '没有这个集成候选。', 404);
    }
    const run = await this.getRun(input.ownerId, integration.runId);
    if (integration.conflicts.length > 0) {
      throw new TeamError('TEAM_INTEGRATION_CONFLICT', '候选仍有未解决的冲突，不能发布。', 409, {
        conflicts: integration.conflicts,
      });
    }
    const member = await this.getMember(input.ownerId, input.memberId);
    if (!member.workspaceId) {
      throw new TeamError('TEAM_WORKSPACE', '这个成员没有隔离工作区。', 409);
    }
    const artifacts = (
      await this.teamStore.listArtifacts({
        runId: run.id,
        ...(integration.taskId ? { taskId: integration.taskId } : {}),
        limit: 50,
      })
    ).filter((entry) => entry.memberId === member.id);
    const artifact =
      [...artifacts]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .find((entry) => entry.kind === 'patch') ?? artifacts[0];
    if (!artifact) {
      throw new TeamError('TEAM_INTEGRATION_CONFLICT', '找不到候选产物，不能发布。', 409);
    }
    const contentRoot = await this.#deps.workspace.workspacePathFor?.(member.workspaceId);
    const targetRoot = this.#deps.workspace.sourceRootPath?.();
    if (!targetRoot || !contentRoot) {
      throw new TeamError('TEAM_WORKSPACE', '发布需要源目录和成员工作区路径。', 409);
    }
    const root = (await this.teamStore.listMembers(run.teamId)).find(
      (entry) => entry.role === 'root',
    );
    const sourceHashes = root?.workspaceId
      ? await this.#deps.workspace.currentHashes(root.workspaceId)
      : {};
    const result = await publishCandidate({
      targetRoot,
      files: artifact.manifest.files,
      sourceHashes,
      expectedHashes: integration.baseHashes,
      idempotencyKey: integration.id,
      contentRoot,
    });
    const nowIso = this.#now().toISOString();
    const updated = await this.teamStore.updateIntegration({
      integrationId: integration.id,
      patch: {
        status: result.conflicts.length > 0 ? 'conflict' : 'published',
        conflicts: result.conflicts.map((conflict) => conflict.path),
        resultHashes: integration.resultHashes,
        verification: {
          applied: result.applied,
          skipped: result.skipped,
          completedAt: nowIso,
        },
        publishedAt: result.conflicts.length === 0 ? nowIso : null,
        journal: [
          ...integration.journal,
          ...result.journal,
          { at: nowIso, action: result.conflicts.length > 0 ? 'failed' : 'published' },
        ],
      },
      now: nowIso,
      event: {
        kind: result.conflicts.length > 0 ? 'integration.conflict' : 'integration.published',
        payload: { integrationId: integration.id, applied: result.applied },
      },
    });
    if (!updated) {
      throw new TeamError('TEAM_INTEGRATION_CONFLICT', '集成候选已被修改。', 409);
    }
    return { integration: updated, result };
  }

  /** Persist an integration record and emit the matching event. */
  async recordIntegration(input: {
    ownerId: string;
    runId: string;
    taskId: string | null;
    baseVersion: string;
    candidateHash: string;
    conflicts: readonly string[];
    baseHashes: Record<string, string>;
    resultHashes: Record<string, string>;
    journal?: readonly IntegrationJournalEntry[];
    verification?: Record<string, unknown> | null;
  }): Promise<Integration> {
    const run = await this.getRun(input.ownerId, input.runId);
    const nowIso = this.#now().toISOString();
    const integration: Integration = {
      id: newId('int'),
      teamId: run.teamId,
      runId: run.id,
      taskId: input.taskId,
      baseVersion: input.baseVersion,
      candidateHash: input.candidateHash,
      status: input.conflicts.length > 0 ? 'conflict' : 'candidate',
      conflicts: input.conflicts,
      baseHashes: input.baseHashes,
      resultHashes: input.resultHashes,
      verification: input.verification ?? null,
      journal: input.journal ?? [{ at: nowIso, action: 'created' }],
      createdAt: nowIso,
      updatedAt: nowIso,
      publishedAt: null,
    };
    return this.teamStore.createIntegration({
      integration,
      event: {
        kind: input.conflicts.length > 0 ? 'integration.conflict' : 'integration.created',
        payload: { integrationId: integration.id, conflicts: input.conflicts },
      },
    });
  }

  async resolveIntegration(
    ownerId: string,
    integrationId: string,
    input: {
      resultHashes: Record<string, string>;
      verification: Record<string, unknown> | null;
      published: boolean;
    },
  ): Promise<Integration> {
    const existing = await this.teamStore.getIntegration(integrationId);
    if (!existing) throw new TeamError('TEAM_INTEGRATION_CONFLICT', '没有这个集成候选。', 404);
    await this.getRun(ownerId, existing.runId);
    const nowIso = this.#now().toISOString();
    const updated = await this.teamStore.updateIntegration({
      integrationId,
      patch: {
        status: input.published ? 'published' : input.verification ? 'verified' : 'resolved',
        conflicts: [],
        resultHashes: input.resultHashes,
        verification: input.verification,
        publishedAt: input.published ? nowIso : null,
        journal: [
          ...existing.journal,
          { at: nowIso, action: input.published ? 'published' : 'verified' },
        ],
      },
      now: nowIso,
      event: {
        kind: input.published ? 'integration.published' : 'integration.created',
        payload: { integrationId, status: input.published ? 'published' : 'verified' },
      },
    });
    if (!updated) throw new TeamError('TEAM_INTEGRATION_CONFLICT', '集成候选已被修改。', 409);
    return updated;
  }

  // ------------------------------------------------------------- internals ---

  #rootWritesAllowed(): boolean {
    return this.#deps.toolPolicy?.allowWorkspaceWrites ?? false;
  }

  async #assertMemberOfTeam(teamId: string, memberId: string): Promise<void> {
    const member = await this.teamStore.getMember(memberId);
    if (!member || member.teamId !== teamId) {
      throw new TeamError('TEAM_MEMBER_NOT_FOUND', '成员不属于这个 Team。', 404);
    }
  }

  #validateDependencies(taskId: string, dependencies: readonly string[], tasks: readonly Task[]): void {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    if (dependencies.includes(taskId)) {
      throw new TeamError('TEAM_TASK_INVALID', '任务不能依赖自己。', 400);
    }
    for (const dependency of dependencies) {
      const target = byId.get(dependency);
      if (!target) {
        throw new TeamError('TEAM_TASK_INVALID', `依赖的任务不存在：${dependency}`, 400);
      }
      if (target.runId !== tasks[0]?.runId) {
        throw new TeamError('TEAM_TASK_INVALID', '依赖不能跨运行。', 400);
      }
    }
    // Cycle check over the proposed graph.
    const graph = new Map<string, readonly string[]>();
    for (const task of tasks) {
      graph.set(task.id, task.id === taskId ? dependencies : task.dependencies);
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        throw new TeamError('TEAM_TASK_INVALID', '任务依赖形成了环。', 409);
      }
      visiting.add(id);
      for (const next of graph.get(id) ?? []) visit(next);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of graph.keys()) visit(id);
  }
}

// ------------------------------------------------------------------ helpers ---

interface SlotWaiter {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

function callerUserId(caller: TeamToolCaller | { readonly userId?: string }): string {
  return 'userId' in caller && typeof caller.userId === 'string' ? caller.userId : 'user';
}

function abortError(): Error {
  const error = new Error('aborted while waiting for a model slot');
  error.name = 'AbortError';
  return error;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function taskInstruction(task: Task): string {
  return [
    `请执行任务「${task.title}」（${task.id}，当前版本 ${task.revision}）。`,
    '',
    '## 说明',
    task.specification || '（没有额外说明）',
    '',
    '## 验收条件',
    task.acceptance || '（没有验收条件；完成后仍需报告证据）',
    '',
    '## 要求',
    '- 先 team_task_get 确认状态。若任务尚未分配给你，用 team_task_claim 领取；若已经是你的 running 任务，直接执行，不要重复领取。',
    '- 完成后用 team_task_submit 提交总结和可核查的证据；不要自己验收。',
    '- 遇到阻塞或不确定的副作用，直接报告，不要假报完成。',
  ].join('\n');
}

