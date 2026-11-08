/**
 * The model-facing Subagent/Team tools.
 *
 * These are adapters, not a second service. Every call goes through
 * `TeamToolHost`, which the `TeamService` implements, so the browser API and the
 * model exercise the same authorization, CAS and state-machine checks. A tool
 * closure captures the calling member and activation; no argument can name a
 * different sender, run or team.
 *
 * Error shape: the model receives `CODE: message` plus a JSON detail when there
 * is one. Codes are stable so a model can tell "retry with the fresh revision"
 * (TEAM_TASK_CONFLICT) from "you may not do this" (TEAM_FORBIDDEN).
 */

import { z } from 'zod';
import { defineTool, toolError, toolOk } from './types.ts';
import type { ToolDefinition } from './types.ts';
import type { Member, TaskAttempt, Team, TeamMessage, TeamRun } from '../teams/types.ts';
import { isTeamError } from '../teams/types.ts';
import type { TaskPage } from '../teams/store.ts';

export interface TeamToolCaller {
  readonly team: Team;
  readonly run: TeamRun;
  readonly member: Member;
  readonly activation: import('../teams/types.ts').Activation;
}

export interface TeamToolHost {
  createTask(caller: TeamToolCaller, input: {
    readonly title: string;
    readonly specification: string;
    readonly acceptance: string;
    readonly required?: boolean;
    readonly dependencies?: readonly string[];
    readonly ownerId?: string | null;
    readonly writeScopes?: readonly string[];
  }): Promise<import('../teams/types.ts').Task>;
  listTasks(caller: TeamToolCaller, options: {
    readonly limit?: number;
    readonly offset?: number;
    readonly status?: import('../teams/types.ts').TaskStatus;
  }): Promise<TaskPage>;
  getTask(caller: TeamToolCaller, taskId: string): Promise<{
    readonly task: import('../teams/types.ts').Task;
    readonly attempts: readonly TaskAttempt[];
  }>;
  updateTask(caller: TeamToolCaller, taskId: string, patch: {
    readonly expectedRevision: number;
    readonly title?: string;
    readonly specification?: string;
    readonly acceptance?: string;
    readonly required?: boolean;
    readonly dependencies?: readonly string[];
    readonly ownerId?: string | null;
    readonly writeScopes?: readonly string[];
  }): Promise<import('../teams/types.ts').Task>;
  claimTask(caller: TeamToolCaller, taskId: string, expectedRevision: number): Promise<{
    readonly task: import('../teams/types.ts').Task;
    readonly attempt: TaskAttempt;
  }>;
  submitTask(caller: TeamToolCaller, input: {
    readonly taskId: string;
    readonly expectedRevision: number;
    readonly summary: string;
    readonly artifactIds?: readonly string[];
    readonly testEvidence?: readonly string[];
    readonly candidateHash?: string | null;
  }): Promise<{ readonly task: import('../teams/types.ts').Task; readonly attempt: TaskAttempt }>;
  reviewTask(caller: TeamToolCaller, input: {
    readonly taskId: string;
    readonly expectedRevision: number;
    readonly attemptId?: string;
    readonly decision: 'accepted' | 'rejected';
    readonly reason: string;
    readonly evidence?: readonly string[];
    readonly candidateHash?: string | null;
  }): Promise<{ readonly task: import('../teams/types.ts').Task; readonly attempt: TaskAttempt }>;
  spawnFromTool(caller: TeamToolCaller, args: {
    readonly name?: string;
    readonly task?: string;
    readonly context?: 'fresh' | 'fork';
    readonly forkSeq?: number;
    readonly role?: Member['role'];
    readonly modelId?: string;
  }): Promise<{ readonly member: Member; readonly activation: import('../teams/types.ts').Activation | null }>;
  sendFromTool(caller: TeamToolCaller, args: {
    readonly recipientId: string;
    readonly body: string;
    readonly clientMessageId: string;
  }): Promise<{ readonly message: TeamMessage; readonly duplicate: boolean }>;
  waitFromTool(
    caller: TeamToolCaller,
    args: {
      readonly kind: 'activation' | 'message' | 'task' | 'member';
      readonly activationId?: string;
      readonly taskId?: string;
      readonly memberId?: string;
      readonly sinceSequence?: number;
      readonly timeoutMs?: number;
    },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
  listFromTool(caller: TeamToolCaller): Promise<{
    readonly members: readonly Member[];
    readonly run: TeamRun;
    readonly team: Team;
  }>;
  followupFromTool(
    caller: TeamToolCaller,
    memberId: string,
    message: string,
    requestId?: string,
  ): Promise<import('../teams/types.ts').Activation>;
  interruptFromTool(caller: TeamToolCaller, memberId: string): Promise<Member>;
  closeFromTool(caller: TeamToolCaller, memberId: string): Promise<readonly Member[]>;
}

/** JSON-safe view: ids and statuses, never credentials or private reasoning. */
function envelope(kind: string, value: unknown): string {
  return JSON.stringify({ ok: true, kind, value }, null, 0);
}

function failure(error: unknown): ReturnType<typeof toolError> {
  if (isTeamError(error)) {
    return toolError(`${error.code}: ${error.message}`, {
      team_error: error.code,
      ...(error.detail ? { detail: error.detail } : {}),
    });
  }
  return toolError(error instanceof Error ? error.message : String(error));
}

export function createTeamTools(host: TeamToolHost, caller: TeamToolCaller): readonly ToolDefinition[] {
  const taskMode = caller.team.config.mode === 'team';

  const agentSpawn = defineTool({
    name: 'agent_spawn',
    description:
      'Create a member with its own context, model and workspace, then start it on a task. Use fresh context by default; fork only when the member needs this conversation\'s committed history. Returns stable member and activation ids.',
    parameters: z.object({
      task: z.string().min(1).max(8_000).describe('What the member should do, including acceptance criteria.'),
      name: z.string().min(1).max(40).optional().describe('A human label, not an identity.'),
      context: z.enum(['fresh', 'fork']).optional().describe('fresh (default) or fork from a committed turn.'),
      forkSeq: z.number().int().positive().optional().describe('Only with fork: the last committed message seq to inherit.'),
      role: z.enum(['worker', 'reviewer']).optional(),
      modelId: z.string().min(1).max(100).optional().describe('Only a model the deployment catalog lists.'),
    }),
    sideEffect: 'command',
    readOnly: false,
    timeoutMs: 120_000,
    guidelines:
      'Use a subagent for work that is genuinely separable. It has its own context, so state everything it needs in `task`.',
    execute: async (args) => {
      try {
        const result = await host.spawnFromTool(caller, args);
        return toolOk(
          envelope('member', {
            member: publicMember(result.member),
            activationId: result.activation?.id ?? null,
          }),
          { summary: `spawned ${result.member.name}` },
        );
      } catch (error) {
        return failure(error);
      }
    },
  });

  const agentFollowup = defineTool({
    name: 'agent_followup',
    description:
      'Continue an existing member in its own context. If it is busy the request is queued; it does not interrupt the running turn.',
    parameters: z.object({
      memberId: z.string().min(1).max(120),
      message: z.string().min(1).max(8_000),
      requestId: z.string().min(1).max(200).optional(),
    }),
    sideEffect: 'command',
    readOnly: false,
    timeoutMs: 30_000,
    execute: async (args) => {
      try {
        const result = await host.listFromTool(caller);
        const member = result.members.find((entry) => entry.id === args.memberId);
        if (!member) throw new Error('TEAM_MEMBER_NOT_FOUND: 没有这个成员。');
        // Delegate to the same service path the UI uses; the tool adds no bypass.
        const activation = await host.followupFromTool(caller, args.memberId, args.message, args.requestId);
        return toolOk(envelope('activation', { activationId: activation.id }), {
          summary: `queued for ${member.name}`,
        });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const agentList = defineTool({
    name: 'agent_list',
    description: 'List the members of this team with their stable ids, roles, status and model.',
    parameters: z.object({}),
    sideEffect: 'none',
    readOnly: true,
    execute: async () => {
      const result = await host.listFromTool(caller);
      return toolOk(
        envelope('members', {
          runId: result.run.id,
          status: result.run.status,
          members: result.members.map(publicMember),
        }),
      );
    },
  });

  const agentSend = defineTool({
    name: 'agent_send_message',
    description:
      'Send a collaboration message to another member. The server sets the sender. Delivery is durable; the recipient may not have read it yet.',
    parameters: z.object({
      recipientId: z.string().min(1).max(120),
      body: z.string().min(1).max(4_000),
      clientMessageId: z.string().min(1).max(200).describe('Idempotency key for this recipient.'),
    }),
    sideEffect: 'command',
    readOnly: false,
    timeoutMs: 30_000,
    execute: async (args) => {
      try {
        const result = await host.sendFromTool(caller, args);
        return toolOk(
          envelope('message', {
            messageId: result.message.id,
            duplicate: result.duplicate,
            state: result.message.state,
          }),
          { summary: `message ${result.message.id}` },
        );
      } catch (error) {
        return failure(error);
      }
    },
  });

  const agentWait = defineTool({
    name: 'agent_wait',
    description:
      'Wait for an activation to finish, a task to change, a member status change or a new message. Returns the reason, a cursor and the matched event. Waiting does not consume a model-request slot.',
    parameters: z.object({
      kind: z.enum(['activation', 'message', 'task', 'member']),
      activationId: z.string().min(1).max(120).optional(),
      taskId: z.string().min(1).max(120).optional(),
      memberId: z.string().min(1).max(120).optional(),
      sinceSequence: z.number().int().min(0).optional(),
      timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
    }),
    sideEffect: 'none',
    readOnly: true,
    timeoutMs: 130_000,
    execute: async (args, context) => {
      if (args.kind === 'activation' && !args.activationId) {
        return toolError('TEAM_MESSAGE_INVALID: activationId is required for kind=activation');
      }
      if (args.kind === 'task' && !args.taskId) {
        return toolError('TEAM_MESSAGE_INVALID: taskId is required for kind=task');
      }
      if (args.kind === 'member' && !args.memberId) {
        return toolError('TEAM_MESSAGE_INVALID: memberId is required for kind=member');
      }
      try {
        const result = await host.waitFromTool(caller, args, context?.signal);
        return toolOk(envelope('wait', result), { summary: `wait ${String(result['reason'])}` });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const agentInterrupt = defineTool({
    name: 'agent_interrupt',
    description:
      'Stop the current activation of a member. The member stays alive and can be followed up; only its running turn is cancelled.',
    parameters: z.object({ memberId: z.string().min(1).max(120) }),
    sideEffect: 'command',
    readOnly: false,
    timeoutMs: 30_000,
    execute: async (args) => {
      try {
        const member = await host.interruptFromTool(caller, args.memberId);
        return toolOk(envelope('member', publicMember(member)), { summary: 'interrupted' });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const agentClose = defineTool({
    name: 'agent_close',
    description:
      'Stop and close a member and its subtree. It refuses further follow-ups; its history and artifacts stay. This is not a task cancellation.',
    parameters: z.object({ memberId: z.string().min(1).max(120) }),
    sideEffect: 'command',
    readOnly: false,
    timeoutMs: 30_000,
    execute: async (args) => {
      try {
        const closed = await host.closeFromTool(caller, args.memberId);
        return toolOk(
          envelope('members', { closed: closed.map((member) => member.id) }),
          { summary: `closed ${closed.length}` },
        );
      } catch (error) {
        return failure(error);
      }
    },
  });

  if (!taskMode) {
    return [agentSpawn, agentFollowup, agentList, agentSend, agentWait, agentInterrupt, agentClose];
  }

  const taskCreate = defineTool({
    name: 'team_task_create',
    description:
      'Create a shared task. Required tasks need an explicit, checkable acceptance condition. Dependencies are task ids in this run; cycles and cross-run ids are rejected.',
    parameters: z.object({
      title: z.string().min(1).max(200),
      specification: z.string().max(8_000).default(''),
      acceptance: z.string().max(8_000).default(''),
      required: z.boolean().optional(),
      dependencies: z.array(z.string().min(1).max(120)).max(32).optional(),
      ownerId: z.string().min(1).max(120).nullable().optional(),
      writeScopes: z.array(z.string().min(1).max(300)).max(32).optional(),
    }),
    sideEffect: 'command',
    readOnly: false,
    timeoutMs: 30_000,
    execute: async (args) => {
      try {
        const task = await host.createTask(caller, args);
        return toolOk(envelope('task', publicTask(task)), { summary: task.id });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const taskList = defineTool({
    name: 'team_task_list',
    description: 'Page through the shared task board. Do not fetch the whole board into context by default.',
    parameters: z.object({
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
      status: z
        .enum(['pending', 'running', 'submitted', 'accepted', 'failed', 'cancelled'])
        .optional(),
    }),
    sideEffect: 'none',
    readOnly: true,
    execute: async (args) => {
      const page = await host.listTasks(caller, args);
      const byId = new Map(page.items.map((task) => [task.id, task]));
      return toolOk(
        envelope('tasks', {
          total: page.total,
          items: page.items.map((task) => ({
            ...publicTask(task),
            ready: task.dependencies.every((id) => byId.get(id)?.status === 'accepted'),
          })),
        }),
      );
    },
  });

  const taskGet = defineTool({
    name: 'team_task_get',
    description: 'Read one task with its attempts, submissions and reviews.',
    parameters: z.object({ taskId: z.string().min(1).max(120) }),
    sideEffect: 'none',
    readOnly: true,
    execute: async (args) => {
      try {
        const result = await host.getTask(caller, args.taskId);
        return toolOk(
          envelope('task', {
            task: publicTask(result.task),
            attempts: result.attempts.map(publicAttempt),
          }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  });

  const taskUpdate = defineTool({
    name: 'team_task_update',
    description:
      'Update a task with expectedRevision. A stale revision returns the current task. Only the root/reviewer may change acceptance, dependencies or owner; a member may edit only its own task text.',
    parameters: z.object({
      taskId: z.string().min(1).max(120),
      expectedRevision: z.number().int().min(1),
      title: z.string().min(1).max(200).optional(),
      specification: z.string().max(8_000).optional(),
      acceptance: z.string().max(8_000).optional(),
      required: z.boolean().optional(),
      dependencies: z.array(z.string().min(1).max(120)).max(32).optional(),
      ownerId: z.string().min(1).max(120).nullable().optional(),
      writeScopes: z.array(z.string().min(1).max(300)).max(32).optional(),
    }),
    sideEffect: 'command',
    readOnly: false,
    timeoutMs: 30_000,
    execute: async (args) => {
      try {
        const { taskId, ...patch } = args;
        const task = await host.updateTask(caller, taskId, patch);
        return toolOk(envelope('task', publicTask(task)), { summary: `rev ${task.revision}` });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const taskClaim = defineTool({
    name: 'team_task_claim',
    description:
      'Claim a ready task (pending and all dependencies accepted). Two members cannot both succeed; on conflict the current revision is returned.',
    parameters: z.object({
      taskId: z.string().min(1).max(120),
      expectedRevision: z.number().int().min(1),
    }),
    sideEffect: 'command',
    readOnly: false,
    timeoutMs: 30_000,
    execute: async (args) => {
      try {
        const result = await host.claimTask(caller, args.taskId, args.expectedRevision);
        return toolOk(
          envelope('attempt', {
            task: publicTask(result.task),
            attemptId: result.attempt.id,
          }),
          { summary: `claimed ${result.task.id}` },
        );
      } catch (error) {
        return failure(error);
      }
    },
  });

  const taskSubmit = defineTool({
    name: 'team_task_submit',
    description:
      'Submit your attempt for review with a summary and evidence. Submission is not acceptance; the root or a reviewer must accept it.',
    parameters: z.object({
      taskId: z.string().min(1).max(120),
      expectedRevision: z.number().int().min(1),
      summary: z.string().min(1).max(4_000),
      artifactIds: z.array(z.string().min(1).max(120)).max(64).optional(),
      testEvidence: z.array(z.string().min(1).max(1_000)).max(64).optional(),
      candidateHash: z.string().min(1).max(200).nullable().optional(),
    }),
    sideEffect: 'command',
    readOnly: false,
    timeoutMs: 30_000,
    execute: async (args) => {
      try {
        const result = await host.submitTask(caller, args);
        return toolOk(
          envelope('task', publicTask(result.task)),
          { summary: `submitted ${result.task.id} rev ${result.task.revision}` },
        );
      } catch (error) {
        return failure(error);
      }
    },
  });

  const taskReview = defineTool({
    name: 'team_task_review',
    description:
      'Accept or reject a submission. The reviewer cannot be the submitter. Acceptance needs an acceptance condition and evidence; a candidate hash change invalidates old evidence.',
    parameters: z.object({
      taskId: z.string().min(1).max(120),
      expectedRevision: z.number().int().min(1),
      attemptId: z.string().min(1).max(120).optional(),
      decision: z.enum(['accepted', 'rejected']),
      reason: z.string().min(1).max(2_000),
      evidence: z.array(z.string().min(1).max(1_000)).max(64).optional(),
      candidateHash: z.string().min(1).max(200).nullable().optional(),
    }),
    sideEffect: 'command',
    readOnly: false,
    timeoutMs: 30_000,
    execute: async (args) => {
      try {
        const result = await host.reviewTask(caller, args);
        return toolOk(
          envelope('task', publicTask(result.task)),
          { summary: `${result.task.status} ${result.task.id}` },
        );
      } catch (error) {
        return failure(error);
      }
    },
  });

  return [
    agentSpawn,
    agentFollowup,
    agentList,
    agentSend,
    agentWait,
    agentInterrupt,
    agentClose,
    taskCreate,
    taskList,
    taskGet,
    taskUpdate,
    taskClaim,
    taskSubmit,
    taskReview,
  ];
}

export function publicMember(member: Member): Record<string, unknown> {
  return {
    id: member.id,
    name: member.name,
    role: member.role,
    depth: member.depth,
    status: member.status,
    parentMemberId: member.parentMemberId,
    modelId: member.profile.modelId,
    providerId: member.profile.providerId,
    contextMode: member.contextMode,
    workspaceMode: member.workspaceMode,
    currentActivationId: member.currentActivationId,
    error: member.error,
  };
}

export function publicTask(task: import('../teams/types.ts').Task): Record<string, unknown> {
  return {
    id: task.id,
    revision: task.revision,
    title: task.title,
    specification: task.specification,
    acceptance: task.acceptance,
    required: task.required,
    dependencies: task.dependencies,
    ownerId: task.ownerId,
    status: task.status,
    writeScopes: task.writeScopes,
    currentAttemptId: task.currentAttemptId,
    submittedAt: task.submittedAt,
    acceptedAt: task.acceptedAt,
    failureReason: task.failureReason,
  };
}

export function publicAttempt(attempt: TaskAttempt): Record<string, unknown> {
  return {
    id: attempt.id,
    taskId: attempt.taskId,
    generation: attempt.generation,
    activationId: attempt.activationId,
    leaseExpiresAt: attempt.leaseExpiresAt,
    submission: attempt.submission,
    review: attempt.review,
    createdAt: attempt.createdAt,
  };
}
