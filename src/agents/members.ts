/**
 * The Subagent runtime: members, their activations, and the one execution path.
 *
 * A member execution is not a second agent implementation. It runs the same
 * `runAgentLoop` the companion uses, with:
 *
 *   - its own internal conversation and durable model transcript;
 *   - its own model provider/model, resolved from a capability-checked profile;
 *   - its own isolated sandbox workspace (when one is configured);
 *   - its own permission policy, which can only be a subset of its parent's;
 *   - a budget reservation per provider request, taken before the request;
 *   - a mailbox delivered between model steps, never inside a tool group.
 *
 * What is *not* reused is the companion's private context: a member does not get
 * relationship, narrative or long-term memory blocks. The task, the roster and
 * the collaboration rules are the whole background.
 *
 * ## Lifecycle
 *
 * `spawn` creates the member and enqueues its first activation. A member runs at
 * most one activation at a time; a follow-up that arrives while it is busy is
 * queued, not executed in parallel, so two writers cannot share one transcript.
 * `interrupt` stops the current activation and leaves the member usable; `close`
 * stops it, refuses follow-ups, and closes the subtree.
 */

import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '../agent/events.ts';
import { runAgentLoop } from '../agent/loop.ts';
import type { LoopInputItem, ModelTurn, ModelUsage } from '../agent/model-port.ts';
import { buildRunInput } from '../agent/infp-agent.ts';
import type { ContextBudget } from '../agent/context-budget.ts';
import { contentImageIds, legacyContent, messageContent } from '../agent/content.ts';
import type { UserContentV1 } from '../agent/content.ts';
import { preflightTeamMedia, loadMediaPlan } from '../service/media-turn.ts';
import type { ToolDefinition, ToolPolicy } from '../tools/types.ts';
import { TurnReadLedger } from '../tools/ledger.ts';
import { ToolRegistry } from '../tools/registry.ts';
import { codingTools } from '../tools/coding/index.ts';
import type { ModelProfile } from '../models/types.ts';
import type { ToolSandboxSession } from '../tools/types.ts';
import { SessionService } from '../session/service.ts';
import type { Store } from '../store.ts';
import { TurnCoordinator } from '../service/turns.ts';
import { StoreTurnRecorder } from '../service/turn-recorder.ts';
import { DurableTranscript } from '../service/model-transcript.ts';
import { transcriptMode, type TranscriptMode } from '../session/model-transcript.ts';
import type { FinishReason } from '../finish-reason.ts';
import type { TurnFinishPatch } from '../session/turn-types.ts';
import { contentFingerprint, log } from '../observability/logging.ts';
import { buildRuntimeContext } from '../agent/runtime-context.ts';
import { memberInstructions } from './prompt.ts';
import { TeamError } from '../teams/types.ts';
import type {
  Activation,
  ActivationInput,
  Member,
  MemberPermissions,
  MemberProfile as TeamMemberProfile,
  Team,
  TeamRun,
  UsageTotals,
} from '../teams/types.ts';
import type { TeamStore } from '../teams/store.ts';

// ------------------------------------------------------------------- host ---

export interface ModelCallGrant {
  /** Settle from provider usage. A missing usage stays conservative. */
  settle(usage: ModelUsage | undefined): Promise<void>;
  /** Release an unused reservation (a request that never reached the provider). */
  release(reason: string): Promise<void>;
}

export interface AuthorizeModelCallInput {
  readonly runId: string;
  readonly memberId: string;
  readonly activationId: string;
  readonly generation: number;
  readonly requestKey: string;
  readonly estimatedInputTokens: number;
  readonly maxOutputTokens: number;
}

export interface MailboxDelivery {
  readonly items: readonly LoopInputItem[];
  /** Called after the step containing them is durably recorded. */
  readonly markProcessed: () => Promise<void>;
  /**
   * Return undelivered messages to the queue when the activation ends without a
   * completed step. A message the model never saw must not be marked processed.
   */
  readonly requeue: () => Promise<void>;
}

/**
 * What the agent runtime needs from the team domain.
 *
 * Kept as an interface so `agents/` does not import `teams/service.ts`: the
 * dependency points from orchestration to runtime, never back.
 */
export interface ActivationHost {
  toolsFor(member: Member, activation: Activation): Promise<readonly ToolDefinition[]>;
  workspaceFor(member: Member): Promise<ToolSandboxSession | null>;
  /**
   * Create (once) the member's isolated workspace and return its sandbox task
   * id. Failure here must leave no runnable member.
   */
  provisionWorkspace(input: {
    team: Team;
    run: TeamRun;
    memberId: string;
    name: string;
    mode: Member['workspaceMode'];
    snapshotFrom: string | null;
  }): Promise<{ workspaceId: string; workspaceTaskId: string }>;
  contextFor(input: {
    team: Team;
    run: TeamRun;
    member: Member;
    activation: Activation;
  }): Promise<{
    readonly block: string;
    readonly workspacePath: string | null;
    readonly budget: string;
  }>;
  authorizeModelCall(input: AuthorizeModelCallInput): Promise<ModelCallGrant>;
  /** Acquire one model slot for the length of one provider request. */
  acquireModelSlot(runId: string, signal: AbortSignal | undefined): Promise<() => void>;
  takeMailbox(member: Member, activation: Activation): Promise<MailboxDelivery>;
  onActivationFinished(input: {
    readonly activation: Activation;
    readonly member: Member;
    readonly outcome: 'succeeded' | 'failed' | 'interrupted' | 'unknown';
    readonly summary: string;
    readonly error: string | null;
    readonly taskId: string | null;
  }): Promise<void>;
  profileFor(member: Member): ModelProfile;
  maxStepsFor(member: Member): number;
}

// ------------------------------------------------------------------- deps ---

export interface SubagentRuntimeDeps {
  readonly teamStore: TeamStore;
  readonly store: Store;
  readonly sessions: SessionService;
  readonly host: ActivationHost;
  readonly now?: () => Date;
  /** Resolve a model turn for a member. Injected by tests. */
  readonly resolveModelTurn: (member: Member) => Promise<ModelTurn>;
  readonly transcriptMode?: TranscriptMode;
  readonly media?: import('../media/service.ts').MediaService | null;
  readonly imagePolicies?: import('../provider/image-policy.ts').ImagePolicyRegistry;
  readonly mediaLimits?: import('../media/types.ts').MediaLimits;
  readonly sessionConfig?: import('../session/config.ts').SessionConfig;
  readonly availableImageModels?: readonly string[];
  /** MCP host, so a member sees the same external tools as its parent. */
  readonly mcp?: import('../mcp/service.ts').McpService | null;
}

export interface SpawnInput {
  readonly team: Team;
  readonly run: TeamRun;
  readonly parent: Member | null;
  /** Ceiling when `parent` is null (a root member). */
  readonly rootPermissions?: MemberPermissions;
  readonly name?: string;
  readonly role?: Member['role'];
  /** `fresh` by default; `fork` requires an explicit committed cutoff. */
  readonly contextMode?: 'fresh' | 'fork';
  readonly forkSeq?: number | null;
  readonly profile?: Partial<TeamMemberProfile>;
  readonly permissions?: Partial<MemberPermissions>;
  readonly workspaceMode?: Member['workspaceMode'];
  readonly input: ActivationInput;
  readonly requestId?: string;
  /** Test seam: do not start the activation yet. */
  readonly defer?: boolean;
}

export interface SpawnResult {
  readonly member: Member;
  readonly activation: Activation | null;
}

// ---------------------------------------------------------------- runtime ---

export class SubagentRuntime {
  readonly #deps: SubagentRuntimeDeps;
  readonly #now: () => Date;
  readonly #mode: TranscriptMode;
  /** In-process cancellation, keyed by activation id. */
  readonly #aborts = new Map<string, AbortController>();
  /** One pump per member, so a busy member queues instead of racing. */
  readonly #pumps = new Map<string, Promise<void>>();
  /** Serialises activation creation per member (generation is max+1). */
  readonly #enqueueLocks = new Map<string, Promise<unknown>>();
  readonly #listeners = new Map<string, Set<(event: ActivationNotification) => void>>();

  constructor(deps: SubagentRuntimeDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => new Date());
    this.#mode = deps.transcriptMode ?? transcriptMode();
  }

  // ------------------------------------------------------------- members ---

  async spawn(input: SpawnInput): Promise<SpawnResult> {
    const { team, run, parent } = input;
    const memberId = newId('mem');
    const now = this.#now().toISOString();
    const depth = parent ? parent.depth + 1 : 1;
    const limits = team.config.limits;
    const ceiling = parent?.permissions ?? input.rootPermissions ?? ROOT_PERMISSIONS;

    if (depth > limits.maxDepth) {
      throw new TeamError(
        'TEAM_DEPTH_LIMIT',
        `成员深度超过上限 ${limits.maxDepth}。`,
        409,
        { depth, maxDepth: limits.maxDepth },
      );
    }
    if (parent && !parent.permissions.canSpawn) {
      throw new TeamError('TEAM_FORBIDDEN', '这个成员没有创建子成员的权限。', 403);
    }
    const count = await this.#deps.teamStore.countMembers(team.id);
    if (count >= limits.maxMembers) {
      throw new TeamError(
        'TEAM_MEMBER_LIMIT',
        `成员数量已达上限 ${limits.maxMembers}。`,
        409,
        { count, maxMembers: limits.maxMembers },
      );
    }
    const modelId = input.profile?.modelId ?? team.config.defaultModelId;
    const parentLike = parent ?? ROOT_PROFILE_PROXY;
    const fullProfile = this.#deps.host.profileFor({ ...parentLike, profile: { ...parentLike.profile, modelId } });
    const profile: TeamMemberProfile = {
      ...memberProfileSnapshot(fullProfile, this.#deps.host.maxStepsFor(parent ?? ROOT_PROFILE_PROXY)),
      ...input.profile,
      modelId,
    };
    if (!fullProfile.supportsTools) {
      throw new TeamError(
        'TEAM_CAPABILITY',
        `模型 ${fullProfile.id} 不支持工具调用，不能作为成员执行任务。`,
        409,
        { modelId: fullProfile.id },
      );
    }
    const wantsImages = (input.input.images?.length ?? 0) > 0;
    if (wantsImages && fullProfile.capabilities.input.image !== 'supported') {
      throw new TeamError(
        'TEAM_CAPABILITY',
        `模型 ${fullProfile.id} 不支持图片输入；请改用具备能力的模型或去掉图片。`,
        409,
        { modelId: fullProfile.id },
      );
    }
    if (team.config.mode === 'delegation' && input.role === 'reviewer') {
      throw new TeamError('TEAM_MODE_DISABLED', '关闭 Team 后不能创建验收成员。', 409);
    }

    const permissions = intersectPermissions(ceiling, {
      ...input.permissions,
      allowWorkspaceWrites:
        (input.permissions?.allowWorkspaceWrites ?? true) && ceiling.allowWorkspaceWrites,
      allowCommands: (input.permissions?.allowCommands ?? true) && ceiling.allowCommands,
      canSpawn:
        (input.permissions?.canSpawn ?? true) && ceiling.canSpawn && depth < limits.maxDepth,
      canWriteMemory: false,
    });

    const workspaceMode = input.workspaceMode ?? (permissions.allowWorkspaceWrites ? 'copy' : 'readonly');
    // A copy workspace is a writable snapshot; without the write permission that
    // would be a promise the policy does not keep. A read-only bind (the root
    // member on the user's own directory) is fine: writes are refused by policy.
    if (workspaceMode === 'copy' && !permissions.allowWorkspaceWrites) {
      throw new TeamError('TEAM_FORBIDDEN', '只读成员不能获得可写工作区副本。', 403);
    }

    // The internal conversation is hidden from the normal list by the API
    // (member conversations are filtered), but it is a real conversation with
    // its own transcript and mutex.
    await this.#deps.store.ensureUser(team.ownerId);
    const conversation = await this.#deps.sessions.create(
      team.ownerId,
      `成员 ${input.name ?? defaultName(depth)}`,
      modelId,
    );

    let member: Member = {
      id: memberId,
      teamId: team.id,
      parentMemberId: parent?.id ?? null,
      internalConversationId: conversation.id,
      name: input.name?.trim() || defaultName(depth),
      role: input.role ?? 'worker',
      depth,
      status: 'provisioning',
      profile,
      permissions,
      workspaceId: null,
      workspaceMode,
      contextMode: input.contextMode ?? 'fresh',
      forkSeq: input.contextMode === 'fork' ? (input.forkSeq ?? null) : null,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      currentActivationId: null,
      error: null,
    };

    try {
      // Fork is a context operation before anything runs. It copies only
      // committed messages; when the member is less privileged than the source,
      // it refuses rather than inheriting history it may not read.
      if (member.contextMode === 'fork' && parent) {
        await this.#forkHistory(team, run, parent, member, input.forkSeq ?? null);
      }
      const workspace = await this.#deps.host.provisionWorkspace({
        team,
        run,
        memberId,
        name: member.name,
        mode: workspaceMode,
        snapshotFrom:
          member.contextMode === 'fork' && parent ? parent.internalConversationId : null,
      });
      member = {
        ...member,
        workspaceId: workspace.workspaceId,
        status: 'idle',
      };
      await this.#deps.teamStore.createMember({
        member,
        event: {
          kind: 'member.created',
          payload: {
            memberId,
            parentMemberId: parent?.id ?? null,
            name: member.name,
            role: member.role,
            depth,
            workspaceId: workspace.workspaceId,
          },
        },
      });
    } catch (error) {
      // No ghost member: the row exists so the failure is readable, but it is
      // never idle and can never be activated.
      const failed: Member = {
        ...member,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        updatedAt: this.#now().toISOString(),
      };
      await this.#deps.teamStore
        .createMember({
          member: failed,
          event: {
            kind: 'member.created',
            payload: { memberId, status: 'failed', error: failed.error },
          },
        })
        .catch(() => undefined);
      throw error;
    }

    if (input.defer) return { member, activation: null };
    const activation = await this.#enqueue(member, input.input, input.requestId);
    void this.pump(member.id);
    return { member, activation };
  }

  async followup(memberId: string, input: ActivationInput): Promise<Activation> {
    const member = await this.#requireMember(memberId);
    this.#assertOpen(member);
    const activation = await this.#enqueue(member, input);
    void this.pump(member.id);
    return activation;
  }

  async interrupt(memberId: string, reason = 'interrupted by request'): Promise<Member> {
    const member = await this.#requireMember(memberId);
    const active = await this.#activeActivation(member);
    if (active) {
      this.#aborts.get(active.id)?.abort();
      await this.#deps.teamStore.updateActivation(
        active.id,
        ['running', 'waiting'],
        {
          status: 'interrupted',
          error: reason,
          finishedAt: this.#now().toISOString(),
        },
        { kind: 'activation.finished', payload: { activationId: active.id, status: 'interrupted' } },
      );
    }
    const updated = await this.#deps.teamStore.updateMember(
      member.id,
      { status: member.status === 'closed' ? 'closed' : 'idle', currentActivationId: null, now: this.#now().toISOString() },
      { kind: 'member.status', payload: { memberId, status: 'idle', interrupted: true } },
    );
    return updated ?? member;
  }

  async close(memberId: string, options: { cascade?: boolean } = {}): Promise<Member[]> {
    const closed = await this.#closeOne(memberId, options.cascade !== false);
    return closed;
  }

  async getMember(memberId: string): Promise<Member | null> {
    return this.#deps.teamStore.getMember(memberId);
  }

  async listMembers(teamId: string): Promise<Member[]> {
    return this.#deps.teamStore.listMembers(teamId);
  }

  /** Wait for an activation to reach a terminal status, without holding a slot. */
  async waitForActivation(
    activationId: string,
    options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
  ): Promise<Activation> {
    const deadline = this.#now().getTime() + Math.max(1, options.timeoutMs);
    for (;;) {
      const activation = await this.#deps.teamStore.getActivation(activationId);
      if (!activation) {
        throw new TeamError('TEAM_ACTIVATION_CONFLICT', '没有这个执行。', 404);
      }
      if (['succeeded', 'failed', 'interrupted', 'unknown'].includes(activation.status)) {
        return activation;
      }
      if (this.#now().getTime() >= deadline) return activation;
      if (options.signal?.aborted) return activation;
      await delay(100);
    }
  }

  /** Subscribe to activation changes for `agent_wait` and the SSE tail. */
  subscribe(runId: string, listener: (event: ActivationNotification) => void): () => void {
    const set = this.#listeners.get(runId) ?? new Set();
    set.add(listener);
    this.#listeners.set(runId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.#listeners.delete(runId);
    };
  }

  /** Recover activations a dead process left running. Never replays a tool. */
  async recover(): Promise<{ interrupted: number; unknown: number }> {
    const now = this.#now().toISOString();
    const expired = await this.#deps.teamStore.expiredActivations(now);
    let interrupted = 0;
    let unknown = 0;
    for (const activation of expired) {
      const member = await this.#deps.teamStore.getMember(activation.memberId);
      if (!member) continue;
      // A model response may have been lost after tools ran. Marking it
      // `unknown` is the honest state; retrying is the caller's decision.
      const target = member.workspaceMode === 'copy' ? 'interrupted' : 'unknown';
      await this.#deps.teamStore.updateActivation(
        activation.id,
        ['running', 'waiting'],
        { status: target, error: '进程重启时执行未结束', finishedAt: now },
        {
          kind: 'activation.finished',
          payload: { activationId: activation.id, status: target, recovered: true },
        },
      );
      if (target === 'unknown') unknown += 1;
      else interrupted += 1;
      await this.#deps.teamStore.updateMember(member.id, {
        status: 'idle',
        currentActivationId: null,
        now,
      });
    }
    return { interrupted, unknown };
  }

  // ------------------------------------------------------------ internals ---

  async #requireMember(memberId: string): Promise<Member> {
    const member = await this.#deps.teamStore.getMember(memberId);
    if (!member) throw new TeamError('TEAM_MEMBER_NOT_FOUND', '没有这个成员。', 404);
    return member;
  }

  #assertOpen(member: Member): void {
    if (member.status === 'closed' || member.status === 'closing') {
      throw new TeamError('TEAM_MEMBER_CLOSED', `成员 ${member.name} 已关闭，不能继续跟进。`, 409);
    }
  }

  async #activeActivation(member: Member): Promise<Activation | null> {
    const activations = await this.#deps.teamStore.listActivations(
      (await this.#runOfMember(member))?.id ?? '',
      member.id,
    );
    return activations.find((entry) => entry.status === 'running' || entry.status === 'waiting') ?? null;
  }

  /** A member belongs to a team, not a run; this finds its current run. */
  async #runOfMember(member: Member): Promise<TeamRun | null> {
    const runs = await this.#deps.teamStore.listRuns(member.teamId, 20);
    for (const run of runs) {
      const activations = await this.#deps.teamStore.listActivations(run.id, member.id);
      if (activations.length > 0) return run;
    }
    return runs[0] ?? null;
  }

  async #enqueue(
    member: Member,
    input: ActivationInput,
    requestId?: string,
  ): Promise<Activation> {
    const previous = this.#enqueueLocks.get(member.id) ?? Promise.resolve();
    const task = previous.then(async () => {
      const run = await this.#runOfMember(member);
      if (!run) throw new TeamError('TEAM_RUN_NOT_FOUND', '成员不属于任何运行。', 404);
      if (run.status !== 'running' && run.status !== 'waiting_user') {
        throw new TeamError('TEAM_RUN_TERMINAL', '这次运行已经结束，不能再启动成员。', 409);
      }
      const team = await this.#deps.teamStore.getTeam(member.teamId);
      if (!team) throw new TeamError('TEAM_NOT_FOUND', '没有这个 Team。', 404);
      const existing = await this.#deps.teamStore.listActivations(run.id, member.id);
      const generation = existing.reduce((max, entry) => Math.max(max, entry.generation), 0) + 1;
      const now = this.#now().toISOString();
      const activation: Activation = {
        id: newId('act'),
        runId: run.id,
        memberId: member.id,
        requestId: requestId ?? newId('req'),
        generation,
        status: 'queued',
        checkpoint: {},
        input,
        result: null,
        error: null,
        createdAt: now,
        startedAt: null,
        finishedAt: null,
        leaseExpiresAt: null,
      };
      const created = await this.#deps.teamStore.createActivation({
        activation,
        maxActivations: team.config.limits.maxActivations,
        event: {
          kind: 'activation.queued',
          payload: {
            activationId: activation.id,
            memberId: member.id,
            kind: input.kind,
            generation,
            taskId: input.taskId ?? null,
          },
        },
      });
      return created;
    });
    this.#enqueueLocks.set(member.id, task.catch(() => undefined));
    return task;
  }

  /** Drain one member's queue. A busy member never starts a second execution. */
  async pump(memberId: string): Promise<void> {
    const current = this.#pumps.get(memberId);
    if (current) return current;
    const started = (async () => {
      for (;;) {
        const member = await this.#deps.teamStore.getMember(memberId);
        if (!member || member.status === 'closed' || member.status === 'closing' || member.status === 'failed') {
          return;
        }
        const activation = await this.#deps.teamStore.nextQueuedActivation(memberId);
        if (!activation) return;
        await this.#execute(member, activation).catch((error: unknown) => {
          log.warn('team.activation_unhandled', {
            member_id: memberId,
            activation_id: activation.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    })();
    this.#pumps.set(memberId, started);
    void started.finally(() => {
      if (this.#pumps.get(memberId) === started) this.#pumps.delete(memberId);
    });
    return started;
  }

  async #execute(member: Member, activation: Activation): Promise<void> {
    const now = this.#now();
    const nowIso = now.toISOString();
    const running = await this.#deps.teamStore.updateActivation(
      activation.id,
      ['queued'],
      { status: 'running', startedAt: nowIso, leaseExpiresAt: new Date(now.getTime() + 10 * 60_000).toISOString() },
      { kind: 'activation.started', payload: { activationId: activation.id, memberId: member.id } },
    );
    if (!running) return; // another pump won the queued→running race

    await this.#deps.teamStore.updateMember(member.id, {
      status: 'active',
      currentActivationId: activation.id,
      now: nowIso,
    });

    const team = await this.#deps.teamStore.getTeam(member.teamId);
    const run = await this.#deps.teamStore.getRun(activation.runId);
    if (!team || !run) {
      await this.#finish(member, activation, 'failed', '', 'Team 或运行记录不存在', null);
      return;
    }

    const abort = new AbortController();
    this.#aborts.set(activation.id, abort);

    const coordinator = new TurnCoordinator(this.#deps.store);
    const requestHash = contentFingerprint(
      `${activation.id}\u0000${activation.input.kind}\u0000${activation.input.text}`,
    );
    try {
      const begun = await coordinator.begin({
        requestId: activation.requestId,
        turnId: activation.requestId,
        userId: team.ownerId,
        conversationId: member.internalConversationId,
        requestHash,
        model: member.profile.modelId,
      });
      if (begun.kind !== 'started') {
        throw new TeamError(
          'TEAM_ACTIVATION_CONFLICT',
          '这个成员的上一次执行还没有正常结束，已拒绝重复执行。',
          409,
        );
      }
    } catch (error) {
      await this.#finish(
        member,
        activation,
        'failed',
        '',
        error instanceof Error ? error.message : String(error),
        null,
      );
      this.#aborts.delete(activation.id);
      return;
    }

    let summary = '';
    let errorText: string | null = null;
    let outcome: 'succeeded' | 'failed' | 'interrupted' | 'unknown' = 'failed';
    let usage: UsageTotals | undefined;
    const taskId = activation.input.taskId ?? null;
    let releaseMedia: (() => Promise<void>) | null = null;
    const deliveries: MailboxDelivery[] = [];

    try {
      const conversation = await this.#deps.sessions.ensure(team.ownerId, member.internalConversationId);
      const profile = this.#deps.host.profileFor(member);
      const tools = new ToolRegistry(await this.#deps.host.toolsFor(member, activation));
      const workspace = await this.#deps.host.workspaceFor(member);
      if (workspace) tools.registerAll(codingTools);
      /** MCP tools are granted to the member, not to the root's conversation. */
      let mcpGuidelines = '';
      let permissionPort: import('../tools/types.ts').ToolPermissionPort | null = null;
      if (this.#deps.mcp) {
        const mcpTurn = await this.#deps.mcp.toolsForTurn({
          userId: team.ownerId,
          conversationId: member.internalConversationId,
          ...(abort.signal ? { signal: abort.signal } : {}),
        });
        tools.registerAll(mcpTurn.tools);
        mcpGuidelines = mcpTurn.guidelines;
        permissionPort = this.#deps.mcp.permissionPort();
      }
      const policy: ToolPolicy = {
        allowWorkspaceWrites: member.permissions.allowWorkspaceWrites,
        allowCommands: member.permissions.allowCommands,
        maxOutputChars: member.permissions.maxOutputChars,
      };
      const roster = await this.#deps.teamStore.listMembers(team.id);
      const instructions = memberInstructions({
        team,
        run,
        member,
        roster,
        taskBoard: team.config.mode === 'team',
      });
      const memberContext = await this.#deps.host.contextFor({ team, run, member, activation });
      const runtimeContext = buildRuntimeContext({
        workspaceBlock: workspace ? `工作区挂载路径：${workspace.displayPath}` : null,
        toolGuidelines: [tools.guidelines(), mcpGuidelines].filter(Boolean).join('\n\n'),
        narrativeBlock: memberContext.block,
      });

      const images = activation.input.images ?? [];
      const userContent: UserContentV1 =
        images.length > 0
          ? {
              version: 1,
              parts: [
                { type: 'text', text: activation.input.text },
                ...images.map((assetId) => ({ type: 'image' as const, assetId })),
              ],
            }
          : legacyContent(activation.input.text);
      if (images.length > 0 && (!this.#deps.media || !this.#deps.imagePolicies)) {
        throw new TeamError(
          'TEAM_CAPABILITY',
          '这个部署没有配置图片存储或图片策略，不能把图片派发给成员。',
          409,
        );
      }
      const userMessage = await this.#ensureUserMessage(team.ownerId, member, activation, userContent);
      const replay = await this.#deps.sessions.prepare(team.ownerId, conversation.id, {
        protectSeq: userMessage.seq,
        ...(abort.signal ? { signal: abort.signal } : {}),
      });
      let mediaPlan: import('../agent/request-plan.ts').PreparedMediaPlan | undefined;
      if (images.length > 0) {
        const history = replay.messages
          .filter((entry) => entry.id !== userMessage.id)
          .filter((entry) => entry.role === 'user' || entry.role === 'assistant')
          .map((entry) => messageContent(entry));
        const preflight = await preflightTeamMedia(
          {
            media: this.#deps.media ?? null,
            policies: this.#deps.imagePolicies!,
            limits: this.#deps.mediaLimits ?? (await import('../media/limits.ts')).mediaLimits(),
            ...(this.#deps.sessionConfig
              ? { inputBudgetTokens: this.#deps.sessionConfig.inputBudgetTokens }
              : {}),
            ...(this.#deps.availableImageModels
              ? { availableModels: this.#deps.availableImageModels }
              : {}),
          },
          {
            userId: team.ownerId,
            profile,
            content: userContent,
            history,
            requiresTools: true,
            ...(this.#deps.sessionConfig
              ? { fixedTokens: this.#deps.sessionConfig.promptReserveTokens }
              : {}),
          },
        );
        const loaded = await loadMediaPlan(
          { media: this.#deps.media ?? null },
          team.ownerId,
          preflight.plan,
        );
        mediaPlan = loaded.plan;
        releaseMedia = loaded.release;
      }

      const durable = this.#mode === 'durable';
      let input: readonly LoopInputItem[];
      let transcript: DurableTranscript | null = null;
      if (durable) {
        const begun = await DurableTranscript.begin({
          store: this.#deps.store,
          userId: team.ownerId,
          conversationId: conversation.id,
          requestId: activation.requestId,
          turnId: activation.requestId,
          instructions,
          promptVersion: 'team-member@2026-11-08',
          tools: tools.schemas(),
          profile,
          replay,
          user: {
            content: userContent,
            messageId: userMessage.id,
            seq: userMessage.seq,
          },
          context: {
            relationshipBlock: null,
            narrativeBlock: memberContext.block,
            situationBlock: null,
            workspaceBlock: workspace ? `工作区挂载路径：${workspace.displayPath}` : null,
            permissionBlock: `写入：${policy.allowWorkspaceWrites ? '允许' : '拒绝'}；命令：${policy.allowCommands ? '允许' : '拒绝'}`,
            toolGuidelines: [tools.guidelines(), mcpGuidelines].filter(Boolean).join('\n\n'),
          },
          policy,
          now,
        });
        transcript = begun.transcript;
        input = begun.input;
      } else {
        const history = replay.messages
          .filter((entry) => entry.id !== userMessage.id)
          .filter((entry): entry is typeof entry & { role: 'user' | 'assistant' } =>
            entry.role === 'user' || entry.role === 'assistant',
          )
          .map((entry) => ({ role: entry.role, content: entry.content }));
        const built = buildRunInput(
          images.length > 0 ? userContent : userMessage.content,
          history,
          runtimeContext,
        );
        input =
          typeof built === 'string'
            ? [{ type: 'message', role: 'user', content: built }]
            : [...built];
      }

      const recorder = new StoreTurnRecorder({
        store: this.#deps.store,
        turnId: activation.requestId,
        conversationId: conversation.id,
      });
      const contextBudget: ContextBudget = {
        windowTokens: profile.contextWindowTokens,
        outputReserveTokens: profile.maxOutputTokens,
        safetyBufferTokens: profile.safetyBufferTokens,
        estimator: profile.tokenEstimator,
      };

      const baseTurn = await this.#deps.resolveModelTurn(member);
      const budgetedTurn = this.#budgetedModelTurn(baseTurn, run, member, activation);

      let reply = '';
      let finishReason: FinishReason = 'completed';
      let usedTools = 0;
      let failedTools = 0;
      const toolCalls: string[] = [];
      const events: AgentEvent[] = [];

      let pendingDelivery: MailboxDelivery | null = null;
      let stepCompleted = false;
      // Mail is drained once per model step: a message that arrived while the
      // member was thinking is delivered before the next request, never in the
      // middle of a tool group.
      const beforeStep = async (): Promise<readonly LoopInputItem[] | void> => {
        pendingDelivery = await this.#deps.host.takeMailbox(member, activation);
        if (pendingDelivery.items.length > 0) deliveries.push(pendingDelivery);
        return pendingDelivery.items;
      };
      const afterStep = async (): Promise<void> => {
        stepCompleted = true;
        await pendingDelivery?.markProcessed().catch(() => undefined);
        pendingDelivery = null;
      };

      for await (const event of runAgentLoop({
        modelTurn: budgetedTurn,
        instructions,
        input,
        tools,
        toolContext: {
          workspace: workspace?.workspace ?? null,
          executor: workspace?.executor ?? null,
          cwd: workspace?.cwd ?? null,
          policy,
          ledger: new TurnReadLedger(),
          now,
          sandboxed: Boolean(workspace),
        },
        maxSteps: this.#deps.host.maxStepsFor(member),
        signal: abort.signal,
        recorder,
        contextBudget,
        ...(permissionPort ? { permission: permissionPort } : {}),
        ...(mediaPlan ? { media: mediaPlan } : {}),
        ...(transcript ? { transcript } : {}),
        beforeStep,
        afterStep,
      })) {
        events.push(event);
        if (event.type === 'completed') {
          reply = event.text;
          finishReason = event.finishReason ?? 'completed';
        } else if (event.type === 'error') {
          if (abort.signal.aborted || event.message === 'cancelled') {
            outcome = 'interrupted';
          } else {
            errorText = event.message;
          }
        } else if (event.type === 'interrupted') {
          reply = event.text;
          outcome = 'interrupted';
        } else if (event.type === 'tool_call') {
          usedTools += 1;
          toolCalls.push(event.name);
        } else if (event.type === 'tool_result' && !event.ok) {
          failedTools += 1;
        }
      }

      if (!stepCompleted) {
        await Promise.all(deliveries.map((delivery) => delivery.requeue().catch(() => undefined)));
      }
      if (outcome !== 'interrupted' && errorText === null) outcome = 'succeeded';
      summary = reply.trim();
      if (transcript) {
        try {
          const totals = await transcript.usage();
          usage = toUsageTotals(totals.turnUsage);
        } catch {
          // Usage is diagnostic here; the budget ledger is the authority.
        }
      }

      const assistant = await this.#deps.sessions
        .append({
          conversationId: conversation.id,
          userId: team.ownerId,
          role: 'assistant',
          content: reply,
          interrupted: outcome === 'interrupted',
        })
        .catch((error: unknown) => {
          log.warn('team.member_reply_persist_failed', {
            member_id: member.id,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        });
      if (transcript && assistant) {
        await transcript.linkAssistantMessage(assistant.id).catch(() => undefined);
      }
      if (transcript && outcome === 'interrupted') {
        await transcript.recordInterrupted(reply).catch(() => undefined);
      }

      await this.#deps.store
        .recordRun({
          id: randomUUID(),
          userId: team.ownerId,
          conversationId: conversation.id,
          model: profile.id,
          promptVersion: 'team-member@2026-11-08',
          status: outcome === 'succeeded' ? 'completed' : outcome === 'interrupted' ? 'interrupted' : 'failed',
          usedTools: usedTools > 0,
          toolCalls,
          inputFingerprint: contentFingerprint(activation.input.text),
          outputFingerprint: contentFingerprint(reply),
          riskLevel: 'none',
          durationMs: Date.now() - now.getTime(),
          finishReason: outcome === 'succeeded' ? finishReason : outcome === 'interrupted' ? 'cancelled' : 'failed',
          error: errorText,
        })
        .catch(() => undefined);

      if (failedTools > 0) {
        log.info('team.member_tools_failed', { member_id: member.id, failed: failedTools });
      }
      void events;
    } catch (error) {
      await Promise.all(deliveries.map((delivery) => delivery.requeue().catch(() => undefined)));
      if (abort.signal.aborted || isAbort(error)) {
        outcome = 'interrupted';
      } else if (error instanceof TeamError) {
        // A budget exhaustion is a policy stop, not an unknown side effect.
        outcome = 'failed';
        errorText = error.message;
      } else {
        outcome = 'failed';
        errorText = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (releaseMedia) await releaseMedia().catch(() => undefined);
      this.#aborts.delete(activation.id);
      const patch: TurnFinishPatch = {
        status:
          outcome === 'succeeded' ? 'completed' : outcome === 'interrupted' ? 'interrupted' : 'failed',
        finishReason:
          outcome === 'succeeded' ? 'completed' : outcome === 'interrupted' ? 'cancelled' : 'failed',
        reply: summary,
        ...(errorText ? { error: errorText } : {}),
        ...(usage
          ? {
              usage: {
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                totalTokens: usage.inputTokens + usage.outputTokens,
                cachedTokens: usage.cachedTokens,
                responseModel: null,
                imageTokensUnknown: false,
              },
            }
          : {}),
      };
      await coordinator
        .finish(activation.requestId, patch)
        .catch(() => undefined);
      await this.#finish(member, activation, outcome, summary, errorText, taskId).catch(
        (error: unknown) => {
          log.error('team.activation_finish_failed', {
            activation_id: activation.id,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      );
    }
  }

  async #finish(
    member: Member,
    activation: Activation,
    outcome: 'succeeded' | 'failed' | 'interrupted' | 'unknown',
    summary: string,
    error: string | null,
    taskId: string | null,
  ): Promise<void> {
    const nowIso = this.#now().toISOString();
    const current = await this.#deps.teamStore.getActivation(activation.id);
    // A late callback from a replaced generation loses. This is the guard that
    // stops "I stopped it" from being overwritten by "it finished".
    if (!current || current.generation !== activation.generation) return;
    if (!['running', 'waiting'].includes(current.status) && current.status !== 'queued') return;

    const result = summary.length > 0 || taskId !== null
      ? {
          summary: summary.slice(0, 4_000),
          ...(taskId ? { taskId } : {}),
        }
      : null;
    await this.#deps.teamStore.updateActivation(
      activation.id,
      ['running', 'waiting', 'queued'],
      {
        status: outcome === 'succeeded' ? 'succeeded' : outcome,
        ...(result ? { result } : {}),
        error,
        finishedAt: nowIso,
        leaseExpiresAt: null,
      },
      {
        kind: 'activation.finished',
        payload: { activationId: activation.id, memberId: member.id, status: outcome, summary: summary.slice(0, 400) },
      },
    );
    const fresh = await this.#deps.teamStore.getMember(member.id);
    if (fresh && fresh.status !== 'closed' && fresh.status !== 'closing') {
      await this.#deps.teamStore.updateMember(member.id, {
        status: 'idle',
        currentActivationId: null,
        now: nowIso,
      });
    }
    // A close may have raced this finish between the read and the write. The
    // `closedAt` stamp is the durable fact; repair the status if the finish's
    // "idle" write landed after the close.
    const after = await this.#deps.teamStore.getMember(member.id);
    if (after?.closedAt && after.status !== 'closed') {
      await this.#deps.teamStore.updateMember(member.id, {
        status: 'closed',
        currentActivationId: null,
        now: nowIso,
      });
    }
    this.#notify(activation.runId, {
      type: 'activation',
      activationId: activation.id,
      memberId: member.id,
      status: outcome,
    });
    await this.#deps.host.onActivationFinished({
      activation: { ...activation, status: outcome },
      member,
      outcome,
      summary,
      error,
      taskId,
    });
  }

  async #closeOne(memberId: string, cascade: boolean): Promise<Member[]> {
    const member = await this.#deps.teamStore.getMember(memberId);
    if (!member) return [];
    const closed: Member[] = [];
    const nowIso = this.#now().toISOString();
    const active = await this.#activeActivation(member);
    if (active) {
      this.#aborts.get(active.id)?.abort();
      await this.#deps.teamStore.updateActivation(active.id, ['running', 'waiting'], {
        status: 'interrupted',
        error: '成员已关闭',
        finishedAt: nowIso,
      });
    }
    await this.#deps.teamStore.updateMember(
      member.id,
      { status: 'closed', closedAt: nowIso, currentActivationId: null, now: nowIso },
      { kind: 'member.status', payload: { memberId, status: 'closed' } },
    );
    closed.push({ ...member, status: 'closed', closedAt: nowIso });
    if (cascade) {
      const roster = await this.#deps.teamStore.listMembers(member.teamId);
      const children = roster.filter((entry) => entry.parentMemberId === member.id);
      for (const child of children) {
        if (child.status !== 'closed') closed.push(...(await this.#closeOne(child.id, true)));
      }
    }
    return closed;
  }

  #budgetedModelTurn(
    base: ModelTurn,
    run: TeamRun,
    member: Member,
    activation: Activation,
  ): ModelTurn {
    const host = this.#deps.host;
    let sequence = 0;
    return async function* budgeted(request) {
      sequence += 1;
      const requestKey = `${activation.id}:${sequence}`;
      const estimated = estimateRequestTokens(request, member.profile);
      const output = Math.max(1, member.profile.maxOutputTokens);
      // Acquire the concurrency slot *before* reserving budget. Otherwise a
      // queued request that is not even in flight reserves its maximum output
      // and can exhaust the team budget while only three requests are allowed to
      // run. The slot is released on every path.
      const release = await host.acquireModelSlot(run.id, request.signal);
      let grant: ModelCallGrant;
      try {
        grant = await host.authorizeModelCall({
          runId: run.id,
          memberId: member.id,
          activationId: activation.id,
          generation: activation.generation,
          requestKey,
          estimatedInputTokens: estimated,
          maxOutputTokens: output,
        });
      } catch (error) {
        release();
        throw error;
      }
      let usage: ModelUsage | undefined;
      let settled = false;
      try {
        for await (const event of base(request)) {
          if (event.type === 'done' || event.type === 'incomplete') usage = event.usage;
          yield event;
        }
        await grant.settle(usage);
        settled = true;
      } catch (error) {
        // A stream that may have reached the provider is not released as if it
        // had been free; the reservation stays conservative.
        await grant.settle(usage).catch(() => undefined);
        settled = true;
        throw error;
      } finally {
        release();
        if (!settled) await grant.settle(usage).catch(() => undefined);
      }
    };
  }

  async #ensureUserMessage(
    userId: string,
    member: Member,
    activation: Activation,
    content: UserContentV1,
  ): Promise<{ id: string; seq: number; content: string }> {
    const checkpoint = activation.checkpoint as { userMessageId?: string; userSeq?: number };
    if (typeof checkpoint.userMessageId === 'string' && typeof checkpoint.userSeq === 'number') {
      return {
        id: checkpoint.userMessageId,
        seq: checkpoint.userSeq,
        content: activation.input.text,
      };
    }
    const imageIds = contentImageIds(content);
    const message = await this.#deps.sessions.append({
      conversationId: member.internalConversationId,
      userId,
      role: 'user',
      content: activation.input.text,
      // The asset belongs to the user's original conversation. The member's
      // conversation must not become a second owner of it; the explicit Team
      // grant is what authorizes this request, so only the block reference is
      // stored here.
      ...(imageIds.length > 0 ? { contentParts: content } : {}),
    });
    await this.#deps.teamStore.updateActivation(activation.id, ['running'], {
      checkpoint: { ...activation.checkpoint, userMessageId: message.id, userSeq: message.seq },
    });
    return { id: message.id, seq: message.seq, content: message.content };
  }

  async #forkHistory(
    team: Team,
    run: TeamRun,
    parent: Member,
    child: Member,
    forkSeq: number | null,
  ): Promise<void> {
    // Fork inherits the parent's committed history, including whatever its
    // assistant text may contain. A child with *narrower* permissions must not
    // receive it; the safe options are fresh or an explicit material selection.
    if (!canInheritHistory(parent.permissions, child.permissions)) {
      throw new TeamError(
        'TEAM_FORBIDDEN',
        '子成员权限低于父成员，不能通过 fork 继承父轨迹；请使用 fresh 或显式选择资料。',
        403,
      );
    }
    const messages = await this.#deps.store.listMessages(
      team.ownerId,
      parent.internalConversationId,
      10_000,
    );
    const committed = messages.filter((message) => message.role !== 'system');
    // Cut at a committed assistant message: a trailing user prompt or a
    // half-generated reply is not a turn a child may inherit.
    const lastAssistantSeq = committed.reduce(
      (last, message) => (message.role === 'assistant' ? message.seq : last),
      0,
    );
    const requested = forkSeq ?? lastAssistantSeq;
    const cutoffSeq = Math.min(requested, lastAssistantSeq);
    for (const message of committed) {
      if (message.seq > cutoffSeq) break;
      if (message.interrupted) continue;
      if (message.contentParts) {
        const images = contentImageIds(message.contentParts);
        const missing = images.filter((id) => !child.permissions.imageAssetIds.includes(id));
        if (missing.length > 0) {
          throw new TeamError(
            'TEAM_FORBIDDEN',
            '父轨迹包含未授权给子成员的图片；请改用 fresh 或先授予资源。',
            403,
            { missing },
          );
        }
      }
      await this.#deps.sessions.append({
        conversationId: child.internalConversationId,
        userId: team.ownerId,
        role: message.role,
        content: message.content,
        ...(message.contentParts ? { contentParts: message.contentParts } : {}),
      });
    }
    void run;
  }

  #notify(runId: string, event: ActivationNotification): void {
    for (const listener of this.#listeners.get(runId) ?? []) {
      try {
        listener(event);
      } catch {
        // A listener is a UI concern; it cannot fail an activation.
      }
    }
  }
}

export interface ActivationNotification {
  readonly type: 'activation';
  readonly activationId: string;
  readonly memberId: string;
  readonly status: string;
}

// ---------------------------------------------------------------- helpers ---

function toUsageTotals(
  totals: import('../session/turn-types.ts').TurnUsageTotals | null | undefined,
): UsageTotals | undefined {
  if (!totals) return undefined;
  return {
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cachedTokens: totals.cachedTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    requests: totals.totalSteps,
    measuredRequests: totals.measuredSteps,
    incomplete: totals.incomplete,
  };
}

function estimateRequestTokens(
  request: {
    readonly instructions: string;
    readonly input: readonly unknown[];
    readonly tools: readonly unknown[];
    readonly media?: { readonly estimatedInputTokens: number } | undefined;
  },
  profile: TeamMemberProfile,
): number {
  void profile;
  const chars =
    request.instructions.length +
    JSON.stringify(request.input).length +
    JSON.stringify(request.tools).length;
  const textEstimate = Math.ceil(chars / 4);
  const mediaEstimate = request.media?.estimatedInputTokens ?? 0;
  // The media plan already carries an upper-bound-aware estimate; never price
  // text only when an image is in the request.
  const base = Math.max(textEstimate, mediaEstimate);
  // A conservative ceiling: the estimator is not a promise, and under-reserving
  // is the failure that lets two members overdraw one budget.
  return Math.ceil(base * 1.15) + 256;
}

function intersectPermissions(
  ceiling: MemberPermissions,
  requested: Partial<MemberPermissions>,
): MemberPermissions {
  const allowed = requested.allowedTools ?? ceiling.allowedTools;
  const tools =
    allowed === null || allowed === undefined
      ? ceiling.allowedTools
      : ceiling.allowedTools === null
        ? allowed
        : allowed.filter((tool) => ceiling.allowedTools?.includes(tool));
  return {
    allowWorkspaceWrites:
      (requested.allowWorkspaceWrites ?? false) && ceiling.allowWorkspaceWrites,
    allowCommands: (requested.allowCommands ?? false) && ceiling.allowCommands,
    allowedTools: tools,
    canSpawn: Boolean(requested.canSpawn) && ceiling.canSpawn,
    canWriteMemory: Boolean(requested.canWriteMemory) && ceiling.canWriteMemory,
    maxOutputChars: Math.min(
      requested.maxOutputChars ?? ceiling.maxOutputChars,
      ceiling.maxOutputChars,
    ),
    imageAssetIds: intersectArrays(requested.imageAssetIds ?? [], ceiling.imageAssetIds),
  };
}

function intersectArrays(a: readonly string[], b: readonly string[]): readonly string[] {
  return a.filter((entry) => b.includes(entry));
}

/**
 * Whether a child may inherit the parent's committed history.
 *
 * This is about *reading* the parent's content: the child must not be more
 * restricted on file visibility, commands or image resources. Spawning depth is
 * unrelated (a depth-limited child can still read a fork), so it is not checked
 * here; the child's own spawn permission is enforced separately.
 */
function canInheritHistory(
  parent: MemberPermissions,
  child: MemberPermissions,
): boolean {
  return (
    (!parent.allowWorkspaceWrites || child.allowWorkspaceWrites) &&
    (!parent.allowCommands || child.allowCommands) &&
    parent.imageAssetIds.every((id) => child.imageAssetIds.includes(id))
  );
}

const ROOT_PERMISSIONS: MemberPermissions = {
  allowWorkspaceWrites: true,
  allowCommands: true,
  allowedTools: null,
  canSpawn: true,
  canWriteMemory: false,
  maxOutputChars: 60_000,
  imageAssetIds: [],
};

/**
 * A stand-in only used to resolve the model profile for a root member; it is
 * never persisted and never becomes a parent id.
 */
const ROOT_PROFILE_PROXY: Member = {
  id: 'root',
  teamId: 'root',
  parentMemberId: null,
  internalConversationId: 'root',
  name: 'root',
  role: 'root',
  depth: 1,
  status: 'idle',
  profile: {
    modelId: '',
    providerId: '',
    maxSteps: 12,
    supportsTools: true,
    supportsImages: false,
    contextWindowTokens: 0,
    maxOutputTokens: 0,
  },
  permissions: ROOT_PERMISSIONS,
  workspaceId: null,
  workspaceMode: 'bind',
  contextMode: 'fresh',
  forkSeq: null,
  createdAt: '',
  updatedAt: '',
  closedAt: null,
  currentActivationId: null,
  error: null,
};

function memberProfileSnapshot(profile: ModelProfile, maxSteps: number): TeamMemberProfile {
  return {
    modelId: profile.id,
    providerId: profile.providerId,
    maxSteps,
    supportsTools: profile.supportsTools,
    supportsImages: profile.capabilities.input.image === 'supported',
    contextWindowTokens: profile.contextWindowTokens,
    maxOutputTokens: profile.maxOutputTokens,
  };
}

function defaultName(depth: number): string {
  return depth === 2 ? `成员${randomUUID().slice(0, 4)}` : `子成员${randomUUID().slice(0, 4)}`;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function isAbort(error: unknown): boolean {
  const named = error as { name?: string; code?: string } | undefined;
  return named?.name === 'AbortError' || named?.code === 'ABORT_ERR';
}

