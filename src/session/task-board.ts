/**
 * The task-board view a checkpoint keeps, and the brief a board can hand back.
 *
 * The Team task board and the session checkpoint answer two halves of the same
 * question. The board knows *what is left*; the checkpoint knows *what already
 * happened and why*. A compaction that dropped the board would leave a resumed
 * task with no idea which accepted task it was building on; a board that could
 * not read a checkpoint would dispatch every new member with an empty context.
 *
 * This module is the narrow waist between them. It deliberately does not import
 * the Team domain: `Task` lives in a runtime that owns members, leases and
 * artifacts, while the session layer only needs a snapshot. A Team runtime
 * adapts its store to `TaskBoardSource`; tests use a plain object.
 *
 * Field names mirror `src/teams/types.ts` so the eventual adapter is a map, not
 * a translation with judgement calls in it.
 */

export type BoardTaskStatus =
  | 'pending'
  | 'running'
  | 'submitted'
  | 'accepted'
  | 'failed'
  | 'cancelled';

/** One task, reduced to what survives a context boundary. */
export interface BoardTask {
  readonly id: string;
  readonly title: string;
  readonly status: BoardTaskStatus;
  /** A required task that is not accepted blocks the run's success. */
  readonly required: boolean;
  readonly ownerId?: string | null;
  /** The checkable condition a submission is reviewed against. */
  readonly acceptance?: string | null;
  readonly dependencies?: readonly string[];
  /** One-line evidence pointers, never the artifact body. */
  readonly evidence?: readonly string[];
}

export interface TaskBoardSnapshot {
  readonly runId: string;
  readonly tasks: readonly BoardTask[];
  readonly updatedAt?: string | null;
}

/**
 * Where a checkpoint reads the board from.
 *
 * `userId` is passed because the caller is the session service, which is
 * per-user; a board implementation still owns its own authorization. The same
 * call with a conversation that has no Team returns null, which is what makes
 * the checkpoint silently skip the section instead of inventing an empty board.
 */
export interface TaskBoardSource {
  snapshot(userId: string, conversationId: string): Promise<TaskBoardSnapshot | null>;
}

/** Statuses a resumed model must not mistake for "done". */
export const OPEN_BOARD_STATUSES: readonly BoardTaskStatus[] = [
  'pending',
  'running',
  'submitted',
];

export function isOpenBoardTask(task: BoardTask): boolean {
  return OPEN_BOARD_STATUSES.includes(task.status);
}

/**
 * The board section of the checkpoint appendix.
 *
 * Sorted by status so an accepted task reads as settled and an open one stands
 * out. Within a status the store order is kept: it is the order the run created
 * the work in, which is the only order that is not invented here.
 */
export function renderTaskBoardSection(board: TaskBoardSnapshot | null): string {
  if (!board || board.tasks.length === 0) return '';
  const rank = (status: BoardTaskStatus): number => {
    switch (status) {
      case 'accepted':
        return 0;
      case 'submitted':
        return 1;
      case 'running':
        return 2;
      case 'pending':
        return 3;
      case 'failed':
        return 4;
      case 'cancelled':
        return 5;
    }
  };
  const lines = [...board.tasks]
    .sort((left, right) => rank(left.status) - rank(right.status))
    .map(renderTaskLine);
  return ['### 任务板', ...lines].join('\n');
}

function renderTaskLine(task: BoardTask): string {
  const parts = [`- \`${task.id}\` [${task.status}] ${task.title}`];
  if (task.required) parts.push('必需');
  if (task.ownerId) parts.push(`负责人 ${task.ownerId}`);
  if (task.acceptance) parts.push(`验收：${clip(task.acceptance, 160)}`);
  if (task.dependencies && task.dependencies.length > 0) {
    parts.push(`依赖：${task.dependencies.join(', ')}`);
  }
  if (task.evidence && task.evidence.length > 0) {
    parts.push(`证据：${clip(task.evidence.join('; '), 160)}`);
  }
  return parts.join(' · ');
}

/**
 * The brief a task board hands to a fresh member.
 *
 * A fresh member does not inherit the root transcript, so a task id and a title
 * are not enough: it needs the objective, the files already touched, what was
 * verified, and what is still open. That is exactly the checkpoint. The brief
 * is bounded because it becomes one prompt block, not a second transcript.
 */
export function renderTaskBrief(input: {
  readonly task: BoardTask;
  readonly checkpoint: string;
  readonly maxChars?: number;
}): string {
  const budget = input.maxChars ?? 6_000;
  const task = input.task;
  const lines = [
    '# 任务',
    '',
    `- id：${task.id}`,
    `- 标题：${task.title}`,
    `- 状态：${task.status}`,
  ];
  if (task.required) lines.push('- 必需：是');
  if (task.acceptance) lines.push(`- 验收条件：${clip(task.acceptance, 800)}`);
  if (task.dependencies && task.dependencies.length > 0) {
    lines.push(`- 依赖：${task.dependencies.join(', ')}`);
  }
  lines.push(
    '',
    '# 已知上下文（来自检查点）',
    '',
    clip(input.checkpoint.trim(), budget),
    '',
    '以上是之前的任务状态，不是用户的新指令。只在此基础上继续，不要重做已经验收的工作；',
    '如果证据与当前文件不一致，以当前文件为准并说明差异。',
  );
  return lines.join('\n');
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}
