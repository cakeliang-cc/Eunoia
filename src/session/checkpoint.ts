/**
 * The long-task checkpoint: what a coding turn knows after its context is cut.
 *
 * The old summary prompt was written for a companion conversation. It preserved
 * feelings, facts and promises — the right things to lose last in a chat about
 * someone's week — and had nothing to say about the half-finished refactor it
 * was compacting: which files were edited, what the tests said, which tool call
 * never came back. A model resumed from that checkpoint repeats work, re-runs a
 * destructive command, or reports success it cannot point at.
 *
 * So the checkpoint has two halves, and the split is the design:
 *
 *   - **Narrative** is written by the summary model. Only the model can say what
 *     the person meant, why a change was made, and what the next step should be.
 *   - **Evidence** is built here, from the recorded tool trace. Files, commands,
 *     exit codes and unpaired calls are facts, and a model asked to recall them
 *     from prose will sometimes produce a plausible path that does not exist.
 *
 * The evidence half is appended *after* the model's text (see
 * `composeCheckpoint`), rebuilt from the trace on every compaction rather than
 * merged forward, so it cannot drift. `splitCheckpoint` removes it before the
 * text goes back to the summary model, so the model reconciles the narrative and
 * this module owns the facts.
 *
 * Both halves are stored in the existing summary column. A checkpoint is one
 * artifact — the text the resumed model reads — and a second table would let the
 * two disagree. The structure is recovered by parsing that text, which is the
 * same projection the model sees.
 */

import type { Message } from './types.ts';
import type { TurnEventRecord } from './turn-types.ts';
import { estimateTokens, truncateToTokens, type TokenEstimatorMode } from './tokens.ts';
import { renderTaskBoardSection, type TaskBoardSnapshot } from './task-board.ts';

export type CheckpointMode = 'coding' | 'companion';

/** How the deployment picks a template. `auto` is the default. */
export type CheckpointModePreference = 'auto' | CheckpointMode;

// --------------------------------------------------------------- evidence ---

export type FileOperation = 'write' | 'edit';

/** One file the trace shows the model writing, and whether that worked. */
export interface FileMutation {
  readonly path: string;
  readonly operation: FileOperation;
  readonly calls: number;
  /** The outcome of the last write; earlier writes are history, not state. */
  readonly lastStatus: VerificationStatus;
  /** A stable pointer into the trace, not a description of the file. */
  readonly evidence: string;
}

export type CommandKind = 'test' | 'typecheck' | 'lint' | 'build' | 'command';

/**
 * The outcome of one command.
 *
 * `unconfirmed` is a real third value. A command whose result row is missing,
 * or whose provider/gateway reported `unknown`, did not pass and did not fail:
 * the run cannot say. Recording it as either would be the lie this feature
 * exists to prevent.
 */
export type VerificationStatus = 'passed' | 'failed' | 'unconfirmed';

export interface CommandRun {
  readonly command: string;
  readonly kind: CommandKind;
  readonly status: VerificationStatus;
  readonly exitCode: number | null;
  /** Only for failed/unconfirmed runs: the tail is the diagnostic. */
  readonly outputTail: string | null;
  readonly evidence: string;
}

export type PendingReason = 'no_result' | 'unknown_outcome';

export interface PendingConfirmation {
  readonly toolName: string;
  /** The call's own summary, or its argument text, bounded. */
  readonly summary: string;
  readonly reason: PendingReason;
  readonly evidence: string;
}

/**
 * The deterministic work state of a conversation window.
 *
 * `toolCalls` and `searched` exist so mode selection can tell "a coding turn
 * happened" from "a conversation happened" even when no file was written: a
 * turn that only read code is still coding work, and its trace belongs in the
 * checkpoint.
 */
export interface WorkLedger {
  readonly toolCalls: number;
  readonly files: readonly FileMutation[];
  readonly commands: readonly CommandRun[];
  readonly pending: readonly PendingConfirmation[];
  readonly searched: boolean;
  /** One line per turn, for the evidence index. */
  readonly trace: readonly string[];
}

export const EMPTY_LEDGER: WorkLedger = {
  toolCalls: 0,
  files: [],
  commands: [],
  pending: [],
  searched: false,
  trace: [],
};

/**
 * Where compaction reads the recorded trace from.
 *
 * The session layer owns the checkpoint logic; the service layer owns the
 * adapter that talks to `TurnStore`. Keeping the port here means the session
 * layer never imports the service layer, and a test can hand compaction a
 * ledger directly.
 */
export interface CheckpointEvidenceSource {
  /**
   * Everything the trace knows about this conversation up to `before`.
   *
   * An empty ledger is a valid answer: a conversation with no tool calls is not
   * an error, it is a conversation.
   */
  collect(conversationId: string, options?: { readonly before?: Date }): Promise<WorkLedger>;
}

const FILE_TOOLS: Readonly<Record<string, FileOperation>> = {
  write: 'write',
  edit: 'edit',
};

const SEARCH_TOOLS = new Set(['read', 'glob', 'grep', 'list_dir']);

/** Caps keep the appendix a checkpoint, not a second transcript. */
const MAX_FILES = 40;
const MAX_COMMANDS = 24;
const MAX_PENDING = 12;
const MAX_TRACE = 12;
const MAX_COMMAND_CHARS = 160;
const MAX_OUTPUT_TAIL_CHARS = 400;

const TEST_PATTERN =
  /\b(vitest|jest|mocha|pytest|unittest|go test|cargo test|npm (?:run )?test|pnpm (?:run )?test|yarn test|node --test|bun test)\b/i;
const TYPECHECK_PATTERN =
  /\b(tsc(?: --noEmit)?|npm (?:run )?typecheck|pnpm typecheck|yarn typecheck|mypy|go vet)\b/i;
const LINT_PATTERN = /\b(eslint|npm (?:run )?lint|pnpm lint|yarn lint|ruff|flake8|golangci-lint)\b/i;
const BUILD_PATTERN =
  /\b(npm run build|pnpm build|yarn build|cargo build|go build|make|vite build|docker build)\b/i;

interface TraceCall {
  readonly event: TurnEventRecord;
  readonly arguments: Record<string, unknown>;
  result: TurnEventRecord | null;
}

/**
 * Pair calls with results and keep the facts a resumed turn needs.
 *
 * Order is the trace's order, not the dictionary's. A file edited twice with
 * one failure is not the same state as two successes, and a command whose
 * result never arrived is not a pass. Both facts are lost by a `Set`.
 */
export function buildWorkLedger(events: readonly TurnEventRecord[]): WorkLedger {
  const calls = new Map<string, TraceCall>();
  const ordered: TraceCall[] = [];
  let toolCalls = 0;
  let searched = false;

  const sorted = [...events].sort(compareEvents);
  for (const event of sorted) {
    if (event.kind === 'tool_call') {
      toolCalls += 1;
      if (event.toolName && SEARCH_TOOLS.has(event.toolName)) searched = true;
      const call: TraceCall = {
        event,
        arguments: parseArguments(event.payload.arguments),
        result: null,
      };
      if (event.callId) calls.set(callKey(event), call);
      ordered.push(call);
      continue;
    }
    if (event.kind === 'tool_result' && event.callId) {
      const call = calls.get(callKey(event));
      if (call) call.result = event;
    }
  }

  const files = new Map<string, FileMutation>();
  const commands: CommandRun[] = [];
  const pending: PendingConfirmation[] = [];

  for (const call of ordered) {
    const toolName = call.event.toolName ?? 'unknown';
    const operation = FILE_TOOLS[toolName];
    const path = typeof call.arguments.file_path === 'string' ? call.arguments.file_path : '';

    if (operation && path) {
      const previous = files.get(path);
      files.set(path, {
        path,
        operation,
        calls: (previous?.calls ?? 0) + 1,
        lastStatus: statusOf(call),
        // The last call is the pointer a human would open; keep it.
        evidence: evidenceOf(call),
      });
    }

    if (toolName === 'bash') {
      const command =
        typeof call.arguments.command === 'string' ? call.arguments.command : '(missing command)';
      commands.push(commandRun(command, call));
    }

    if (!call.result) {
      pending.push({
        toolName,
        summary: callSummary(call),
        reason: 'no_result',
        evidence: evidenceOf(call),
      });
    } else if (call.result.status === 'unknown') {
      pending.push({
        toolName,
        summary: callSummary(call),
        reason: 'unknown_outcome',
        evidence: evidenceOf(call),
      });
    }
  }

  return {
    toolCalls,
    files: [...files.values()].slice(-MAX_FILES),
    commands: commands.slice(-MAX_COMMANDS),
    pending: pending.slice(-MAX_PENDING),
    searched,
    trace: traceLines(sorted).slice(-MAX_TRACE),
  };
}

/** The status of one call, with a missing result treated as unconfirmed. */
function statusOf(call: TraceCall): VerificationStatus {
  const result = call.result;
  if (!result || result.status === 'unknown') return 'unconfirmed';
  return result.status === 'succeeded' ? 'passed' : 'failed';
}

function commandRun(command: string, call: TraceCall): CommandRun {
  const result = call.result;
  const exitCode = exitCodeOf(result);
  let status: VerificationStatus;
  if (!result || result.status === 'unknown') status = 'unconfirmed';
  else if (result.status === 'failed' || (exitCode !== null && exitCode !== 0)) status = 'failed';
  else status = 'passed';

  return {
    command: clip(command, MAX_COMMAND_CHARS),
    kind: classifyCommand(command),
    status,
    exitCode,
    outputTail: status === 'passed' ? null : outputTailOf(result),
    evidence: evidenceOf(call),
  };
}

export function classifyCommand(command: string): CommandKind {
  if (TEST_PATTERN.test(command)) return 'test';
  if (TYPECHECK_PATTERN.test(command)) return 'typecheck';
  if (LINT_PATTERN.test(command)) return 'lint';
  if (BUILD_PATTERN.test(command)) return 'build';
  return 'command';
}

function exitCodeOf(result: TurnEventRecord | null): number | null {
  if (!result) return null;
  const direct = result.payload.exitCode;
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  const summary = typeof result.payload.summary === 'string' ? result.payload.summary : '';
  const match = /退出码\s*(-?\d+)/.exec(summary);
  return match ? Number(match[1]) : null;
}

function outputTailOf(result: TurnEventRecord | null): string | null {
  if (!result) return null;
  const output = typeof result.payload.output === 'string' ? result.payload.output : '';
  const flat = output.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return null;
  return flat.length <= MAX_OUTPUT_TAIL_CHARS
    ? flat
    : `…${flat.slice(flat.length - MAX_OUTPUT_TAIL_CHARS)}`;
}

function callSummary(call: TraceCall): string {
  const summary = call.event.payload.summary;
  if (typeof summary === 'string' && summary.length > 0) return clip(summary, 200);
  // Never fall back to the raw argument JSON: for `write` it would copy file
  // content into the checkpoint, and the evidence block is not a place to
  // duplicate source. A command and a path are the useful primitives.
  const toolName = call.event.toolName ?? '工具调用';
  if (toolName === 'bash' && typeof call.arguments.command === 'string') {
    return clip(call.arguments.command, 200);
  }
  const path = call.arguments.file_path;
  if (typeof path === 'string' && path.length > 0) return `${toolName} ${path}`;
  return toolName;
}

/**
 * A call id is only unique inside its turn.
 *
 * Providers are free to reuse short ids, and a gateway that names calls `c1`
 * per request is common; keying by id alone would pair a later result with an
 * earlier call and turn an unconfirmed write into a confirmed one.
 */
function callKey(event: TurnEventRecord): string {
  return `${event.turnId}:${event.callId ?? ''}`;
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** A short, stable pointer. The turn prefix is enough to find the row. */
function evidenceOf(call: TraceCall): string {
  return `turn ${shortId(call.event.turnId)}/seq ${call.event.seq}`;
}

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) : id;
}

function traceLines(events: readonly TurnEventRecord[]): string[] {
  const byTurn = new Map<string, { first: Date; calls: number; unknown: number }>();
  for (const event of events) {
    if (event.kind !== 'tool_call') continue;
    const current = byTurn.get(event.turnId) ?? {
      first: event.createdAt,
      calls: 0,
      unknown: 0,
    };
    current.calls += 1;
    byTurn.set(event.turnId, current);
  }
  for (const event of events) {
    if (event.kind === 'tool_result' && event.status === 'unknown') {
      const current = byTurn.get(event.turnId);
      if (current) current.unknown += 1;
    }
  }
  return [...byTurn.entries()].map(([turnId, info]) => {
    const at = info.first.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const unknown = info.unknown > 0 ? `，${info.unknown} 个结果未知` : '';
    return `turn ${shortId(turnId)}（${at}）· ${info.calls} 次工具调用${unknown}`;
  });
}

function compareEvents(left: TurnEventRecord, right: TurnEventRecord): number {
  const byTime = left.createdAt.getTime() - right.createdAt.getTime();
  if (byTime !== 0) return byTime;
  if (left.turnId !== right.turnId) return left.turnId < right.turnId ? -1 : 1;
  return left.seq - right.seq;
}

// ----------------------------------------------------------------- appendix ---

/**
 * The heading that separates the two halves.
 *
 * A heading rather than a fence or a marker: the block is read by the resumed
 * model, and Markdown is the format the rest of the checkpoint already uses.
 */
export const EVIDENCE_HEADING = '## 工作证据（自动记录）';

/** The evidence half, rendered for the model and parsed back for the API. */
export function renderWorkEvidence(
  ledger: WorkLedger | null,
  board: TaskBoardSnapshot | null = null,
): string {
  if (!ledger) {
    const onlyBoard = renderTaskBoardSection(board);
    return onlyBoard.length > 0 ? [EVIDENCE_HEADING, onlyBoard].join('\n') : '';
  }
  const hasTrace =
    ledger.files.length > 0 ||
    ledger.commands.length > 0 ||
    ledger.pending.length > 0 ||
    ledger.trace.length > 0;
  const boardSection = renderTaskBoardSection(board);
  if (!hasTrace && boardSection.length === 0) return '';

  const lines: string[] = [EVIDENCE_HEADING];
  if (ledger.files.length > 0) {
    lines.push('### 文件变更', ...ledger.files.map(renderFileLine));
  }
  if (ledger.commands.length > 0) {
    lines.push('### 命令与验证', ...ledger.commands.map(renderCommandLine));
  }
  if (ledger.pending.length > 0) {
    lines.push('### 待确认', ...ledger.pending.map(renderPendingLine));
  }
  if (boardSection.length > 0) lines.push(boardSection);
  if (ledger.trace.length > 0) {
    lines.push('### 证据索引', ...ledger.trace.map((line) => `- ${line}`));
  }
  return lines.join('\n');
}

function renderFileLine(file: FileMutation): string {
  const outcome =
    file.lastStatus === 'passed' ? '成功' : file.lastStatus === 'failed' ? '失败' : '未确认';
  const operation = file.operation === 'write' ? '写入' : '修改';
  return `- \`${file.path}\` · ${operation} ${file.calls} 次 · 最后一次${outcome}（${file.evidence}）`;
}

function renderCommandLine(run: CommandRun): string {
  const status =
    run.status === 'passed' ? '通过' : run.status === 'failed' ? '失败' : '未确认';
  const exit = run.exitCode === null ? '退出码未知' : `退出码 ${run.exitCode}`;
  const tail = run.outputTail ? `；输出尾部：${run.outputTail}` : '';
  return `- ${status} · \`${run.command}\` · ${exit}（${run.evidence}）${tail}`;
}

function renderPendingLine(item: PendingConfirmation): string {
  const reason = item.reason === 'no_result' ? '没有返回结果' : '结果未知';
  return `- \`${item.toolName}\` ${reason}：${item.summary}（${item.evidence}）`;
}

// ------------------------------------------------------------------ compose ---

/**
 * Put the narrative and the evidence together, within the checkpoint budget.
 *
 * Evidence is reserved first. Truncating the tail of the composed text would
 * cut exactly the facts this feature exists to keep, so the narrative yields
 * budget instead. The evidence itself is capped at half the budget: an
 * all-evidence checkpoint with no "why" is also unusable.
 */
export function composeCheckpoint(
  narrative: string,
  ledger: WorkLedger | null,
  board: TaskBoardSnapshot | null,
  maxTokens: number,
  mode: TokenEstimatorMode,
): string {
  const text = splitCheckpoint(narrative).narrative.trim();
  if (!ledger) return truncateToTokens(text, maxTokens, mode);

  const evidence = renderWorkEvidence(ledger, board);
  if (evidence.length === 0) return truncateToTokens(text, maxTokens, mode);

  const evidenceCap = Math.max(32, Math.floor(maxTokens / 2));
  const fittedEvidence = truncateToTokens(evidence, evidenceCap, mode);
  // `truncateToTokens` counts the ellipsis, so measure the result again.
  const evidenceTokens = Math.min(evidenceCap, estimateTokens(fittedEvidence, mode));
  const narrativeBudget = Math.max(32, maxTokens - evidenceTokens);
  const fittedNarrative = truncateToTokens(text, narrativeBudget, mode);
  return `${fittedNarrative}\n\n${fittedEvidence}`;
}

export interface SplitCheckpoint {
  /** The model-written text, without the appendix. */
  readonly narrative: string;
  /** The appendix including its heading, or null when there is none. */
  readonly evidence: string | null;
}

/**
 * Separate the two halves.
 *
 * The *last* heading wins: a model that copied the heading into its own text
 * would otherwise hide the real appendix behind a truncated duplicate.
 */
export function splitCheckpoint(text: string): SplitCheckpoint {
  const index = text.lastIndexOf(`\n${EVIDENCE_HEADING}`);
  if (index < 0) {
    const start = text.startsWith(`${EVIDENCE_HEADING}`) ? 0 : -1;
    if (start < 0) return { narrative: text, evidence: null };
    return { narrative: '', evidence: text.slice(start) };
  }
  return {
    narrative: text.slice(0, index).trimEnd(),
    evidence: text.slice(index + 1),
  };
}

// ------------------------------------------------------------------- prompt ---

/** The section list is asserted by tests and parsed by the API. */
export const CODING_CHECKPOINT_SECTIONS = [
  '## 任务与约束',
  '## 已完成',
  '## 文件与改动理由',
  '## 验证',
  '## 待确认',
  '## 下一步',
  '## 任务板',
  '## 关键决定与原话',
] as const;

export const COMPANION_CHECKPOINT_SECTIONS = [
  '## 当前主线',
  '## 重要事实与偏好',
  '## 人物与关系',
  '## 情绪与连续性',
  '## 承诺与未完成',
  '## 最近状态',
  '## 需要保留的原话',
  '## 关键背景',
] as const;

export function checkpointSections(mode: CheckpointMode): readonly string[] {
  return mode === 'coding' ? CODING_CHECKPOINT_SECTIONS : COMPANION_CHECKPOINT_SECTIONS;
}

// ------------------------------------------------------------------- parse ---

export interface ParsedCheckpointSection {
  readonly title: string;
  readonly bullets: readonly string[];
}

export interface ParsedEvidenceFile {
  readonly path: string;
  readonly operation: string;
  readonly calls: number;
  readonly lastStatus: VerificationStatus;
}

export interface ParsedVerification {
  readonly status: VerificationStatus;
  readonly command: string;
  readonly exitCode: number | null;
}

export interface ParsedPending {
  readonly toolName: string;
  readonly reason: PendingReason;
  readonly summary: string;
}

export interface ParsedBoardTask {
  readonly id: string;
  readonly status: string;
  readonly title: string;
}

export interface ParsedCheckpointEvidence {
  readonly files: readonly ParsedEvidenceFile[];
  readonly verifications: readonly ParsedVerification[];
  readonly pending: readonly ParsedPending[];
  readonly board: readonly ParsedBoardTask[];
  readonly index: readonly string[];
}

export interface ParsedCheckpoint {
  readonly mode: CheckpointMode;
  readonly narrative: string;
  readonly sections: readonly ParsedCheckpointSection[];
  readonly evidence: ParsedCheckpointEvidence | null;
}

/**
 * Recover structure from the checkpoint text.
 *
 * This is a projection of the format this module writes, not a Markdown parser.
 * Anything it cannot recognise stays in the narrative rather than being dropped;
 * the API is allowed to show less structure, never less content.
 */
export function parseCheckpoint(text: string): ParsedCheckpoint {
  const { narrative, evidence } = splitCheckpoint(text);
  const sections = parseSections(narrative);
  const mode: CheckpointMode = sections.some(
    (section) => section.title === '任务与约束' || section.title === '文件与改动理由',
  )
    ? 'coding'
    : 'companion';
  return {
    mode,
    narrative,
    sections,
    evidence: evidence ? parseEvidence(evidence) : null,
  };
}

function parseSections(text: string): ParsedCheckpointSection[] {
  const sections: ParsedCheckpointSection[] = [];
  let current: { title: string; bullets: string[] } | null = null;
  for (const line of text.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      if (current) sections.push(current);
      current = { title: heading[1] as string, bullets: [] };
      continue;
    }
    const bullet = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    if (bullet && current) current.bullets.push(bullet[1] as string);
  }
  if (current) sections.push(current);
  return sections;
}

function parseEvidence(text: string): ParsedCheckpointEvidence {
  const files: ParsedEvidenceFile[] = [];
  const verifications: ParsedVerification[] = [];
  const pending: ParsedPending[] = [];
  const board: ParsedBoardTask[] = [];
  const index: string[] = [];

  let subsection = '';
  for (const line of text.split('\n')) {
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading) {
      subsection = heading[1] as string;
      continue;
    }
    const bullet = /^-\s+(.+?)\s*$/.exec(line);
    if (!bullet) continue;
    const body = bullet[1] as string;

    if (subsection === '文件变更') {
      const match = /^`([^`]+)`\s*·\s*(写入|修改)\s+(\d+)\s*次\s*·\s*最后一次(成功|失败|未确认)/.exec(
        body,
      );
      if (match) {
        files.push({
          path: match[1] as string,
          operation: match[2] as string,
          calls: Number(match[3]),
          lastStatus:
            match[4] === '成功' ? 'passed' : match[4] === '失败' ? 'failed' : 'unconfirmed',
        });
      }
      continue;
    }
    if (subsection === '命令与验证') {
      const match = /^(通过|失败|未确认)\s*·\s*`([^`]+)`\s*·\s*(?:退出码\s*(-?\d+)|退出码未知)/.exec(
        body,
      );
      if (match) {
        verifications.push({
          status: match[1] === '通过' ? 'passed' : match[1] === '失败' ? 'failed' : 'unconfirmed',
          command: match[2] as string,
          exitCode: match[3] === undefined ? null : Number(match[3]),
        });
      }
      continue;
    }
    if (subsection === '待确认') {
      const match = /^`([^`]+)`\s*(没有返回结果|结果未知)：(.+?)（turn [^）]*）$/.exec(body);
      if (match) {
        pending.push({
          toolName: match[1] as string,
          reason: match[2] === '没有返回结果' ? 'no_result' : 'unknown_outcome',
          summary: match[3] as string,
        });
      }
      continue;
    }
    if (subsection === '任务板') {
      const match = /^`([^`]+)`\s*\[([a-z_]+)\]\s*(.+?)(?:\s*·|$)/.exec(body);
      if (match) {
        board.push({
          id: match[1] as string,
          status: match[2] as string,
          title: match[3] as string,
        });
      }
      continue;
    }
    if (subsection === '证据索引') {
      index.push(body);
    }
  }

  return { files, verifications, pending, board, index };
}

// --------------------------------------------------------------------- mode ---

const CODE_PATH =
  /(?:^|[\s(（])(?:[\w.@-]+\/)+[\w.@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|css|scss|html|json|ya?ml|toml|sql|sh|md)\b/;
const CODE_WORD =
  /\b(git|npm|pnpm|yarn|vitest|jest|pytest|tsc|eslint|docker|make|cmake|cargo|go build)\b/;
const CODE_FENCE = /```/;

/**
 * Coding work is detected from what the run *did*, and only then from what was
 * said.
 *
 * A tool trace is the strong signal: it cannot be produced by a conversation
 * about someone's week. The text heuristics exist for the turn before the first
 * tool call, where a pasted stack trace or a path is already unambiguous. The
 * fallback is the companion template, because mislabelling a personal
 * conversation as a ticket is the failure the old prompt warned about.
 */
export function inferCheckpointMode(
  messages: readonly Message[],
  ledger: WorkLedger | null,
  board: TaskBoardSnapshot | null = null,
): CheckpointMode {
  // A board is itself a coding signal: a conversation that has Team tasks is a
  // work conversation even before its first tool call lands.
  if (board && board.tasks.length > 0) return 'coding';
  if (ledger && (ledger.toolCalls > 0 || ledger.searched)) return 'coding';
  for (const message of messages) {
    const text = message.content;
    if (CODE_FENCE.test(text)) return 'coding';
    if (CODE_PATH.test(text) || CODE_WORD.test(text)) return 'coding';
  }
  return 'companion';
}

export function resolveCheckpointMode(
  preference: CheckpointModePreference,
  messages: readonly Message[],
  ledger: WorkLedger | null,
  board: TaskBoardSnapshot | null = null,
): CheckpointMode {
  return preference === 'auto' ? inferCheckpointMode(messages, ledger, board) : preference;
}

// -------------------------------------------------------------------- brief ---

/**
 * A compact handoff for a member that starts from a checkpoint.
 *
 * The task board can dispatch a fresh member for an open task. That member has
 * no transcript, so the checkpoint is its context. This renders the parts a
 * worker needs and leaves out the relationship/emotional sections, which are
 * the root conversation's business, not a task's.
 */
export function renderCheckpointBrief(checkpoint: ParsedCheckpoint): string {
  const wanted = new Set(['任务与约束', '已完成', '文件与改动理由', '验证', '待确认', '下一步', '任务板']);
  const sections = checkpoint.sections.filter((section) => wanted.has(section.title));
  const lines: string[] = ['# 任务检查点', ''];
  if (sections.length === 0) {
    lines.push(checkpoint.narrative.trim());
  } else {
    for (const section of sections) {
      lines.push(`## ${section.title}`);
      if (section.bullets.length === 0) lines.push('- （无）');
      else for (const bullet of section.bullets) lines.push(`- ${bullet}`);
      lines.push('');
    }
    const index = checkpoint.evidence?.index ?? [];
    if (index.length > 0) {
      lines.push('## 证据索引', ...index.map((line) => `- ${line}`));
    }
  }
  return lines.join('\n').trim();
}

export function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}
