/**
 * One conversational turn, end to end.
 *
 * This is the orchestrator: it is the only place that knows the order in which
 * memory is retrieved, risk is assessed, the model is run, the reply is checked,
 * and everything is persisted. Both the HTTP layer and the evaluation runner go
 * through it, so an evaluation measures the product rather than a parallel
 * code path that resembles it.
 *
 * ## Crisis turns are not streamed
 *
 * For a high-risk message the reply is buffered and checked *before* a single
 * delta reaches the client; for everything else it streams as it is generated.
 * That is a deliberate loss of streaming, and the reason is the only one that
 * matters here: if the reply fails the safety check, deltas have already been
 * rendered on the person's screen, and replacing the message afterwards does not
 * un-show it. A crisis reply is three to five sentences, so the delay is not
 * perceptible, and correctness wins.
 *
 * The reasoning is withheld with the reply and for the same reason — a rendered
 * thought cannot be un-rendered either, and the thought behind a reply that was
 * discarded is the last thing anyone should be shown.
 *
 * ## Failure is contained
 *
 * Persisting a reply must never be able to fail a turn. The person already has
 * their answer on screen; losing it to a database error would turn a working
 * reply into an error message. Every write here is best-effort and logged.
 */

import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '../agent/events.ts';
import {
  createCompanionAgent,
  streamReply,
  type AgentOptions,
  type ConversationTurn,
} from '../agent/infp-agent.ts';
import { createMemoryTools } from '../tools/memory.ts';
import { codingTools } from '../tools/coding/index.ts';
import { createSkillTools } from '../tools/skill.ts';
import type { SkillRegistry } from '../skills/registry.ts';
import { ToolRegistry } from '../tools/registry.ts';
import { DEFAULT_TOOL_POLICY } from '../tools/types.ts';
import type { ToolPolicy } from '../tools/types.ts';
import type { SandboxToolProvider } from '../sandbox/tool-adapter.ts';
import { describePolicy } from '../tools/policy.ts';
import { PROMPT_VERSION } from '../agent/instructions.ts';
import { buildRuntimeContext } from '../agent/runtime-context.ts';
import { COMPANION_MODEL } from '../agent/model-client.ts';
import { contentFingerprint, log } from '../observability/logging.ts';
import { buildTurnContext } from './context.ts';
import { applyOutputCheck, safetyDirectiveFor } from '../safety/response.ts';
import { maxRisk } from '../safety/risk.ts';
import { conversationTitle } from '../session/types.ts';
import { SessionService } from '../session/service.ts';
import { renderArchivedSummary } from '../session/summary.ts';
import type { Message } from '../session/types.ts';
import type { TurnFinishPatch } from '../session/turn-types.ts';
import type { Store } from '../store.ts';
import { StoreTurnRecorder } from './turn-recorder.ts';
import { TurnCoordinator } from './turns.ts';

/**
 * What the model is told when the person resumes an interrupted reply.
 *
 * The interrupted assistant message is replayed as history, so the model can
 * see where it stopped. Without this instruction it tends to restart from the
 * opening sentence, which makes "继续" produce a near-duplicate instead of a
 * continuation.
 */
const CONTINUATION_DIRECTIVE = [
  '# 继续被打断的回复',
  '上一条回复是你在生成途中被用户停下的，它还没有说完。请从断点处接着说，',
  '保持同样的语气、人称和话题。不要重新开头，不要重复已经写过的内容，',
  '也不用说明你被打断了——直接继续就好。',
].join('\n');

export type TurnRunner = (
  agent: ReturnType<typeof createCompanionAgent>,
  message: string,
  options: Parameters<typeof streamReply>[2],
) => AsyncIterable<AgentEvent>;

export interface TurnDependencies {
  readonly store: Store;
  /**
   * Session operations for this turn.
   *
   * Optional so callers that already hold the composite store (tests, the
   * evaluation runner) do not have to construct it; production passes the same
   * instance the HTTP routes use, which keeps lifecycle rules in one place.
   */
  readonly session?: SessionService;
  /**
   * Per-run provider supplied by the composition root.
   *
   * Typed through `AgentOptions` so this orchestration layer never imports a
   * vendor SDK directly.
   */
  readonly modelProvider?: AgentOptions['modelProvider'];
  /**
   * The sandbox tool provider, when the platform is configured.
   *
   * Null means no file tools at all. The task is the conversation id, supplied
   * by the server's own session object; a path or task id that arrives on a chat
   * request would let the model choose its own sandbox.
   */
  readonly sandbox?: SandboxToolProvider | null;
  /** Write/command permissions for this process. Fail-closed defaults. */
  readonly toolPolicy?: ToolPolicy;
  /**
   * Discovered skills, when the process configured a workspace.
   *
   * The registry is read-only after discovery. It contributes an index block
   * and one `skill` tool; it never adds a tool per skill.
   */
  readonly skills?: SkillRegistry | null;
  /** Model/tool step cap for one turn. */
  readonly maxSteps?: number;
  /**
   * Injectable so tests and the evaluation replay mode can drive the whole turn
   * — retrieval, safety, persistence and all — without a model call.
   */
  readonly runner?: TurnRunner;
  /**
   * Admission control for this process.
   *
   * Optional so an evaluation run that never touches HTTP does not have to
   * construct it. When absent, `runTurn` builds one over the same store — every
   * caller that persists a turn gets admission, not just the HTTP one.
   */
  readonly turns?: TurnCoordinator;
  readonly now?: () => Date;
  /**
   * IANA zone for the situation block. Omitted, the process zone is used.
   * A client that knows the person's zone should pass it: the process zone
   * is right only while the server and the person share one.
   */
  readonly timeZone?: string;
}

/**
 * One file the person attached to this turn.
 *
 * `path` is workspace-relative and is what the model is told; the file itself
 * was written by the upload endpoint. Only metadata crosses this boundary.
 */
export interface TurnAttachment {
  readonly path: string;
  readonly name: string;
  readonly mime: string;
  readonly bytes: number;
}

export interface TurnRequest {
  readonly userId: string;
  readonly conversationId?: string | null;
  readonly message: string;
  readonly signal?: AbortSignal;
  /**
   * The client's idempotency key, already admitted by `TurnCoordinator.begin`.
   *
   * `runTurn` only *settles* the record: admission happens at the transport edge
   * so a busy conversation can be answered with 409 before a stream is opened,
   * while settlement has to happen here because this is the only layer that
   * knows the outcome on every exit path, including a consumer that stops
   * reading halfway.
   */
  readonly requestId?: string;
  /**
   * Rerun the last user message instead of sending a new one.
   *
   * The HTTP layer has already removed the reply being replaced; this flag only
   * tells the turn not to append a second copy of the user message and to take
   * its text from the transcript.
   */
  readonly regenerate?: boolean;
  /** Files uploaded for this turn, already on disk in the workspace. */
  readonly attachments?: readonly TurnAttachment[];
  /**
   * The person pressed "continue" on an interrupted reply.
   *
   * The instruction is added to the trailing context rather than to the stored
   * user message: the transcript should keep saying what the person said
   * ("继续"), and how to resume is a per-turn instruction, not a fact.
   */
  readonly continue?: boolean;
  /**
   * Whether to write the user message, the reply and the run row. Evaluation
   * turns set this false: they are not part of anyone's conversation, and
   * letting them into the history would corrupt the thing being measured.
   */
  readonly persist?: boolean;
  /** Force a risk level, for safety tests that need a deterministic path. */
  readonly riskLevel?: 'none' | 'elevated' | 'crisis';
  /**
   * Whether to retrieve memories for this turn. The person can switch this off
   * from the UI; honouring it here means the setting is a promise the system
   * keeps rather than a filter applied to output after the fact.
   */
  readonly retrieve?: boolean;
}

/**
 * Run a turn and stream the reply.
 *
 * Yields `AgentEvent`s in the order a client should act on them: retrieval
 * notice, safety notice if any, tool activity, text, then `completed`.
 */
export async function* runTurn(
  deps: TurnDependencies,
  request: TurnRequest,
): AsyncIterable<AgentEvent> {
  const persist = request.persist ?? true;
  const coordinator = deps.turns ?? new TurnCoordinator(deps.store);
  let outcome: TurnFinishPatch | null = null;

  try {
    for await (const event of runTurnInner(deps, request)) {
      // The terminal event is the authority on the outcome, which is why the
      // settlement below is derived from what was emitted rather than from a
      // second set of bookkeeping flags that could disagree with it.
      if (event.type === 'completed') {
        outcome = {
          status: 'completed',
          finishReason: event.finishReason ?? 'completed',
          reply: event.text,
          messageId: event.messageId ?? null,
          ...(event.accepted !== undefined ? { accepted: event.accepted } : {}),
        };
      } else if (event.type === 'interrupted') {
        outcome = {
          status: 'interrupted',
          finishReason: 'cancelled',
          reply: event.text,
          messageId: event.messageId ?? null,
        };
      } else if (event.type === 'error') {
        outcome = {
          status: 'failed',
          finishReason: 'failed',
          error: event.message,
        };
      }
      yield event;
    }
  } finally {
    // Runs on the normal path, on a thrown error, and on a consumer that stops
    // iterating (a dropped connection) — the last of which is exactly the case
    // that would otherwise leave a conversation locked until restart.
    if (request.requestId && persist) {
      await coordinator
        .finish(
          request.requestId,
          outcome ?? { status: 'interrupted', finishReason: 'cancelled', reply: '' },
        )
        .catch((error: unknown) => {
          log.warn('turn.settle_failed', {
            request_id: request.requestId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
  }
}

async function* runTurnInner(
  deps: TurnDependencies,
  request: TurnRequest,
): AsyncIterable<AgentEvent> {
  const startedAt = Date.now();
  const runId = randomUUID();
  const persist = request.persist ?? true;
  const runner = deps.runner ?? streamReply;
  const session = deps.session ?? new SessionService(deps.store);

  let message = request.message?.trim() ?? '';
  if (!request.regenerate && message.length === 0) {
    yield { type: 'error', message: 'message is empty', retryable: false };
    return;
  }
  if (request.regenerate && !persist) {
    // Rerunning is defined in terms of the stored transcript; without one there
    // is nothing to rerun and nothing to replace.
    yield { type: 'error', message: 'regenerate needs a persisted conversation', retryable: false };
    return;
  }

  // Before anything is written. `conversations.user_id` and every per-user table
  // reference `users`, and the in-memory store enforces none of those keys — so
  // this ordering was invisible offline and a 500 the first time it met
  // Postgres: the conversation was created before its owner existed.
  await deps.store.ensureUser(request.userId);

  const conversation = await session.ensure(request.userId, request.conversationId);
  const conversationId = conversation.id;

  let userMessage: Message | null = null;
  if (persist && request.regenerate) {
    // The HTTP layer rewound the conversation to this message already. Reading
    // it back (rather than trusting a request body) is what makes the rerun use
    // exactly the text that is in the transcript.
    userMessage = await session.lastUserMessage(request.userId, conversationId);
    if (!userMessage) {
      yield { type: 'error', message: 'nothing to regenerate', retryable: false };
      return;
    }
    message = userMessage.content;
  } else if (persist) {
    userMessage = await session.append({
      conversationId,
      userId: request.userId,
      role: 'user',
      content: message,
    });

    // The conversation takes its name from the message that opened it. Done
    // here rather than at creation because `ensureConversation` runs before the
    // user's message exists, and because a conversation created by a client that
    // then failed to send anything should stay unnamed rather than be labelled
    // with nothing.
    await session
      .name(request.userId, conversationId, conversationTitle(message))
      .catch(() => undefined);
  }

  // The database is the source of truth for replay. Working memory is no longer
  // consulted here: a process-local window cannot honour a summary boundary, and
  // two sources would eventually disagree about what the model has seen.
  const replay = await session.prepare(request.userId, conversationId, {
    ...(userMessage ? { protectSeq: userMessage.seq } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
  });
  const userMessageId = userMessage?.id ?? null;

  const now = deps.now?.() ?? new Date();
  const context = await buildTurnContext(deps.store, request.userId, message, {
    now,
    retrieve: request.retrieve,
    ...(deps.timeZone ? { timeZone: deps.timeZone } : {}),
  });
  const riskLevel = request.riskLevel ?? context.risk.level;

  if (context.memoryCount > 0) {
    yield {
      type: 'memory_retrieved',
      count: context.memoryCount,
      considered: context.memoryConsidered,
    };
  }
  if (riskLevel !== 'none') {
    yield { type: 'safety_notice', level: riskLevel, replaced: false };
  }

  const history: ConversationTurn[] = replay.messages
    // The current user turn is passed separately to the model. Replaying it
    // here as well would make the model answer its own prompt twice.
    .filter((entry) => entry.id !== userMessageId)
    // System rows are storage bookkeeping, not conversation. They never become
    // model turns.
    .filter((entry): entry is typeof entry & { role: 'user' | 'assistant' } =>
      entry.role === 'user' || entry.role === 'assistant',
    )
    .map((entry) => ({ role: entry.role, content: entry.content }));

  const policy = deps.toolPolicy ?? DEFAULT_TOOL_POLICY;
  const sandboxSession = deps.sandbox
    ? await deps.sandbox.forTask({
        taskId: conversationId,
        sessionId: conversationId,
        userId: request.userId,
      })
    : null;
  const toolRegistry = new ToolRegistry(
    createMemoryTools({
      store: deps.store,
      userId: request.userId,
      sourceMessageId: userMessageId,
      now,
    }),
  );
  if (sandboxSession) toolRegistry.registerAll(codingTools);
  const skills = deps.skills ?? null;
  if (skills && skills.count() > 0) {
    toolRegistry.registerAll(
      createSkillTools(skills, { availableTools: new Set(toolRegistry.names()) }),
    );
  }

  /**
   * The execution log for this turn, when it is persisted.
   *
   * Only persisted turns get one: an evaluation run has no `turn_requests` row
   * for the events to reference, and writing bookkeeping nobody will recover is
   * cost without a question it can answer.
   */
  const recorder =
    persist && request.requestId
      ? new StoreTurnRecorder({
          store: deps.store,
          turnId: request.requestId,
          conversationId,
        })
      : null;

  const agentOptions: AgentOptions = {
    tools: toolRegistry,
    policy,
    workspace: sandboxSession?.workspace ?? null,
    executor: sandboxSession?.executor ?? null,
    // ADR 021: the run gets the task's working-directory port beside the file and
    // command ports, so `change_directory` needs no access to the sandbox.
    cwd: sandboxSession?.cwd ?? null,
    model: conversation.modelId ?? COMPANION_MODEL,
    ...(deps.modelProvider ? { modelProvider: deps.modelProvider } : {}),
    ...(deps.maxSteps ? { maxSteps: deps.maxSteps } : {}),
    ...(recorder ? { recorder } : {}),
    now,
  };
  const agent = createCompanionAgent(agentOptions);
  const runtimeContext = buildRuntimeContext({
    relationshipBlock: context.relationshipBlock,
    narrativeBlock: context.narrativeBlock,
    archivedSummaryBlock: replay.summary ? renderArchivedSummary(replay.summary) : null,
    situationBlock: context.situationBlock,
    ...(sandboxSession ? { workspaceBlock: workspaceBlock(sandboxSession.displayPath, policy) } : {}),
    skillsBlock: skills?.indexBlock() ?? '',
    toolGuidelines: toolRegistry.guidelines(),
    memoryBlock: context.memoryBlock,
    ...(request.attachments && request.attachments.length > 0
      ? { attachmentsBlock: renderAttachments(request.attachments) }
      : {}),
    ...(request.continue ? { continuationBlock: CONTINUATION_DIRECTIVE } : {}),
    safetyDirective: safetyDirectiveFor(riskLevel),
  });

  const buffer = riskLevel === 'crisis';
  let reply = '';
  /**
   * What the client has actually been shown.
   *
   * `reply` only becomes meaningful at `completed`, which never arrives for an
   * interrupted turn. These deltas are the half-finished reply, and they are
   * what gets persisted so "continue" has something to continue from.
   */
  let streamed = '';
  let interrupted = false;
  let usedTools = false;
  const toolCalls: string[] = [];
  let failed: string | null = null;

  for await (const event of runner(agent, message, {
    signal: request.signal,
    history,
    context: runtimeContext,
    ...(deps.modelProvider ? { modelProvider: deps.modelProvider } : {}),
  })) {
    if (event.type === 'completed') {
      reply = event.text;
      continue;
    }
    if (event.type === 'error') {
      // A stop is not a failure. The runner reports cancellation as an error
      // because that is how the loop unwinds; here it ends the turn normally,
      // with the partial reply kept.
      if (request.signal?.aborted === true || event.message === 'cancelled') {
        interrupted = true;
        break;
      }
      failed = event.message;
      yield event;
      break;
    }
    if (event.type === 'tool_call') {
      usedTools = true;
      toolCalls.push(event.name);
    }
    // Withholding deltas is the whole point of `buffer`. Reasoning is withheld
    // alongside the reply: a person in crisis should not watch the model work
    // its way toward them, and if the reply is then replaced by the safety
    // fallback, reasoning that argued for the discarded reply is worse than
    // nothing.
    if (buffer && (event.type === 'text_delta' || event.type === 'thinking_delta')) continue;
    if (buffer && event.type === 'thinking_done') continue;
    if (event.type === 'text_delta') streamed += event.text;
    yield event;
  }

  if (interrupted) {
    const partial = streamed.trim();
    let assistantMessageId: string | null = null;
    if (persist) {
      assistantMessageId = await persistTurn(deps.store, session, {
        runId,
        userId: request.userId,
        conversationId,
        message,
        reply: partial,
        interrupted: true,
        riskLevel,
        usedTools,
        toolCalls,
        status: 'interrupted',
        durationMs: Date.now() - startedAt,
      });
    }
    log.info('turn.interrupted', {
      duration_ms: Date.now() - startedAt,
      reply_chars: partial.length,
      used_tools: usedTools,
      tool_calls: toolCalls.length,
    });
    yield {
      type: 'interrupted',
      text: partial,
      conversationId: persist ? conversationId : null,
      messageId: assistantMessageId,
    };
    return;
  }

  if (failed !== null) {
    if (persist) {
      await deps.store
        .recordRun({
          id: runId,
          userId: request.userId,
          conversationId,
          model: COMPANION_MODEL,
          promptVersion: PROMPT_VERSION,
          status: 'failed',
          usedTools,
          toolCalls,
          inputFingerprint: contentFingerprint(message),
          outputFingerprint: null,
          riskLevel,
          durationMs: Date.now() - startedAt,
          error: failed,
        })
        .catch((error: unknown) => log.warn('run.record_failed', { error: String(error) }));
    }
    return;
  }

  const outcome = applyOutputCheck(riskLevel, reply);
  if (outcome.violations.length > 0) {
    log.warn('safety.output_violation', {
      level: maxRisk(riskLevel, 'elevated'),
      violations: outcome.violations,
      replaced: outcome.replaced,
    });
  }
  if (outcome.replaced) {
    yield { type: 'safety_notice', level: 'crisis', replaced: true };
  }

  // In buffered mode nothing has been sent yet, so the checked reply goes out as
  // one delta followed by `completed` — the same shape a non-streaming client
  // already handles (see events.ts).
  if (buffer && outcome.reply.length > 0) {
    yield { type: 'text_delta', text: outcome.reply };
  }

  let assistantMessageId: string | null = null;
  if (persist) {
    assistantMessageId = await persistTurn(deps.store, session, {
      runId,
      userId: request.userId,
      conversationId,
      message,
      reply: outcome.reply,
      interrupted: false,
      riskLevel,
      usedTools,
      toolCalls,
      status: outcome.replaced ? 'safety_replaced' : 'completed',
      durationMs: Date.now() - startedAt,
    });
  }

  yield {
    type: 'completed',
    text: outcome.reply,
    conversationId: persist ? conversationId : null,
    messageId: assistantMessageId,
  };
}

/** Returns the stored assistant message id, or null if persistence failed. */
async function persistTurn(
  store: Store,
  session: SessionService,
  turn: {
    runId: string;
    userId: string;
    conversationId: string;
    message: string;
    reply: string;
    /** True when `reply` is the part generated before the person pressed stop. */
    interrupted: boolean;
    riskLevel: 'none' | 'elevated' | 'crisis';
    usedTools: boolean;
    toolCalls: readonly string[];
    status: 'completed' | 'safety_replaced' | 'interrupted';
    durationMs: number;
  },
): Promise<string | null> {
  try {
    // A stop before the first visible character has produced nothing to keep;
    // the run row still records that the turn was interrupted.
    const stored =
      turn.status === 'interrupted' && turn.reply.length === 0
        ? null
        : await session.append({
            conversationId: turn.conversationId,
            userId: turn.userId,
            role: 'assistant',
            content: turn.reply,
            ...(turn.interrupted ? { interrupted: true } : {}),
          });
    await store.recordRun({
      id: turn.runId,
      userId: turn.userId,
      conversationId: turn.conversationId,
      model: COMPANION_MODEL,
      promptVersion: PROMPT_VERSION,
      status: turn.status,
      usedTools: turn.usedTools,
      toolCalls: turn.toolCalls,
      inputFingerprint: contentFingerprint(turn.message),
      outputFingerprint: contentFingerprint(turn.reply),
      riskLevel: turn.riskLevel,
      durationMs: turn.durationMs,
      error: null,
    });
    return stored?.id ?? null;
  } catch (error) {
    // The reply is already on the person's screen. Failing the turn now would
    // take it away over a bookkeeping problem.
    log.error('turn.persist_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Drain a turn into its final text. Used by the evaluation runner and tests. */
export async function collectTurn(
  deps: TurnDependencies,
  request: TurnRequest,
): Promise<{ reply: string; events: AgentEvent[]; riskLevel: 'none' | 'elevated' | 'crisis' }> {
  const events: AgentEvent[] = [];
  let reply = '';
  let riskLevel: 'none' | 'elevated' | 'crisis' = 'none';

  for await (const event of runTurn(deps, { ...request, persist: request.persist ?? false })) {
    events.push(event);
    if (event.type === 'completed') reply = event.text;
    else if (event.type === 'interrupted') reply = event.text;
    else if (event.type === 'error') reply = '';
    else if (event.type === 'safety_notice') riskLevel = maxRisk(riskLevel, event.level);
  }

  return { reply, events, riskLevel };
}


/**
 * The per-turn list of attached files.
 *
 * It names paths rather than embedding content: the files are already in the
 * workspace, and a prompt that inlined a 10 MB attachment would be a worse
 * failure than the one it was trying to avoid. The last line is deliberate —
 * this model has no visual input, and a model that pretends to have seen an
 * image is worse than one that says it cannot.
 */
function renderAttachments(attachments: readonly TurnAttachment[]): string {
  const lines = [
    '# 用户上传的文件',
    '这些文件已经放进工作区，下面的路径相对于工作区根目录。需要时用 read、glob 或 bash 查看。',
    '图片不会作为视觉输入送给你，只能当文件处理；不要假装看过图片里的内容。',
    '',
    ...attachments.map(
      (file) => `- ${file.path}（${file.mime || '未知类型'}，${formatBytes(file.bytes)}）`,
    ),
  ];
  return lines.join('\n');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The per-turn statement of the sandbox.
 *
 * The stable prompt says how to behave around code; this block says where the
 * code is and what the process currently allows. It sits in the trailing
 * context, so changing a permission does not invalidate the cached prompt and
 * history — and the model cannot infer a permission it was not given.
 */
function workspaceBlock(displayPath: string, policy: ToolPolicy): string {
  return [
    '# 工作目录',
    `你现在可以在一个隔离沙箱里工作：${displayPath}`,
    `当前权限：${describePolicy(policy)}。`,
    '所有路径都相对于这个目录；不要使用绝对路径，也不要尝试访问目录之外的文件。',
    '沙箱只挂载了当前任务的目录，网络默认关闭。命令在沙箱容器内执行，不会碰到宿主机。',
    '看到"需要审批"或"沙箱未开启"时，不要换一条路径重试，直接告诉用户。',
  ].join('\n');
}
