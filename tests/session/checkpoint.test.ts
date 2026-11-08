/**
 * The long-task checkpoint contract.
 *
 * These tests are about what survives a context cut, so they assert the failures
 * a resumed turn would otherwise make: a file edited with a failed last write
 * must not read as success, a command with no result is not a pass, and the
 * evidence appendix must be rebuilt rather than copied forward from the previous
 * checkpoint.
 */

import { describe, expect, it } from 'vitest';
import {
  buildWorkLedger,
  classifyCommand,
  CODING_CHECKPOINT_SECTIONS,
  composeCheckpoint,
  EMPTY_LEDGER,
  EVIDENCE_HEADING,
  inferCheckpointMode,
  parseCheckpoint,
  renderCheckpointBrief,
  renderWorkEvidence,
  resolveCheckpointMode,
  splitCheckpoint,
  type FileMutation,
  type WorkLedger,
} from '../../src/session/checkpoint.ts';
import {
  isOpenBoardTask,
  renderTaskBoardSection,
  renderTaskBrief,
  type TaskBoardSnapshot,
} from '../../src/session/task-board.ts';
import { estimateTokens } from '../../src/session/tokens.ts';
import type { Message } from '../../src/session/types.ts';
import type { TurnEventRecord } from '../../src/session/turn-types.ts';

const AT = new Date('2026-11-08T09:00:00.000Z');

function event(overrides: Partial<TurnEventRecord> & Pick<TurnEventRecord, 'seq' | 'kind'>): TurnEventRecord {
  return {
    turnId: 'turn-1234',
    conversationId: 'conv-1',
    callId: null,
    toolName: null,
    status: 'running',
    executionId: null,
    payload: {},
    createdAt: AT,
    ...overrides,
  };
}

function call(
  seq: number,
  callId: string,
  toolName: string,
  args: Record<string, unknown>,
): TurnEventRecord {
  return event({
    seq,
    kind: 'tool_call',
    callId,
    toolName,
    status: 'running',
    payload: { arguments: JSON.stringify(args) },
  });
}

function result(
  seq: number,
  callId: string,
  toolName: string,
  status: TurnEventRecord['status'],
  payload: Record<string, unknown> = {},
): TurnEventRecord {
  return event({
    seq,
    kind: 'tool_result',
    callId,
    toolName,
    status,
    payload,
  });
}

function message(role: Message['role'], content: string, seq = 1): Message {
  return {
    id: `m-${seq}`,
    conversationId: 'conv-1',
    userId: 'user-1',
    role,
    content,
    interrupted: false,
    createdAt: AT,
    seq,
  };
}

const codingMessages: Message[] = [
  message('user', '把 src/session/service.ts 里的 compact 拆一下，跑 npm test'),
  message('assistant', '好，我先看现有实现。', 2),
];

describe('buildWorkLedger', () => {
  it('records files, verification outcomes and unconfirmed calls from the trace', () => {
    const ledger = buildWorkLedger([
      call(1, 'c1', 'write', { file_path: 'src/session/checkpoint.ts', content: 'x' }),
      result(2, 'c1', 'write', 'succeeded'),
      call(3, 'c2', 'edit', { file_path: 'src/session/checkpoint.ts', old: 'a', new: 'b' }),
      result(4, 'c2', 'edit', 'succeeded'),
      call(5, 'c3', 'bash', { command: 'npx vitest run tests/session' }),
      result(6, 'c3', 'bash', 'failed', {
        summary: '退出码 1 · 2.1s',
        output: 'FAIL tests/session/service.test.ts\nAssertionError: expected 1 to be 2',
      }),
      call(7, 'c4', 'bash', { command: 'npm run typecheck' }),
      call(8, 'c5', 'read', { file_path: 'src/session/service.ts' }),
      result(9, 'c5', 'read', 'unknown'),
    ]);

    expect(ledger.toolCalls).toBe(5);
    expect(ledger.searched).toBe(true);
    expect(ledger.files).toHaveLength(1);
    expect(ledger.files[0]).toMatchObject({
      path: 'src/session/checkpoint.ts',
      operation: 'edit',
      calls: 2,
      lastStatus: 'passed',
    });
    expect(ledger.commands.map((run) => run.kind)).toEqual(['test', 'typecheck']);
    expect(ledger.commands[0]).toMatchObject({
      command: 'npx vitest run tests/session',
      status: 'failed',
      exitCode: 1,
    });
    expect(ledger.commands[0]?.outputTail).toContain('AssertionError');
    expect(ledger.commands[1]).toMatchObject({ status: 'unconfirmed', exitCode: null });
    // A call with no result and a result the gateway could not confirm are both
    // "待确认"; neither is a failure, and neither is a success.
    expect(ledger.pending.map((item) => [item.toolName, item.reason])).toEqual([
      ['bash', 'no_result'],
      ['read', 'unknown_outcome'],
    ]);
    expect(ledger.trace[0]).toContain('5 次工具调用');
  });

  it('marks the last write of a file instead of the aggregate', () => {
    const ledger = buildWorkLedger([
      call(1, 'c1', 'edit', { file_path: 'src/a.ts' }),
      result(2, 'c1', 'edit', 'failed', { summary: 'permission denied' }),
      call(3, 'c2', 'edit', { file_path: 'src/a.ts' }),
      result(4, 'c2', 'edit', 'succeeded'),
    ]);
    expect(ledger.files[0]?.lastStatus).toBe('passed');
  });

  it('pairs a call with its own turn, not with a reused id in another turn', () => {
    const ledger = buildWorkLedger([
      event({
        seq: 1,
        kind: 'tool_call',
        turnId: 'turn-a',
        callId: 'c1',
        toolName: 'edit',
        payload: { arguments: '{"file_path":"src/a.ts"}' },
      }),
      event({
        seq: 2,
        kind: 'tool_call',
        turnId: 'turn-b',
        callId: 'c1',
        toolName: 'edit',
        payload: { arguments: '{"file_path":"src/b.ts"}' },
      }),
      event({
        seq: 3,
        kind: 'tool_result',
        turnId: 'turn-a',
        callId: 'c1',
        toolName: 'edit',
        status: 'succeeded',
      }),
    ]);

    expect(ledger.files.find((file) => file.path === 'src/a.ts')?.lastStatus).toBe('passed');
    expect(ledger.files.find((file) => file.path === 'src/b.ts')?.lastStatus).toBe('unconfirmed');
    expect(ledger.pending).toHaveLength(1);
  });

  it('does not copy file content into a pending call description', () => {
    const ledger = buildWorkLedger([
      call(1, 'c1', 'write', {
        file_path: 'src/a.ts',
        content: 'const secret = "should not enter the checkpoint";',
      }),
    ]);
    expect(ledger.pending[0]?.summary).toBe('write src/a.ts');
    expect(ledger.pending[0]?.summary).not.toContain('secret');
  });
});

describe('classifyCommand', () => {
  it('separates tests, typecheck, lint and build from ordinary commands', () => {
    expect(classifyCommand('npx vitest run')).toBe('test');
    expect(classifyCommand('npm test')).toBe('test');
    expect(classifyCommand('tsc --noEmit')).toBe('typecheck');
    expect(classifyCommand('npm run lint')).toBe('lint');
    expect(classifyCommand('npm run build')).toBe('build');
    expect(classifyCommand('git status')).toBe('command');
  });
});

describe('inferCheckpointMode', () => {
  it('treats a tool trace as coding regardless of the prose', () => {
    expect(inferCheckpointMode([message('user', '今天好累')], { ...EMPTY_LEDGER, toolCalls: 1 })).toBe(
      'coding',
    );
  });

  it('recognises a code task before the first tool call', () => {
    expect(inferCheckpointMode(codingMessages, EMPTY_LEDGER)).toBe('coding');
    expect(inferCheckpointMode([message('user', '今天好累，想聊聊')], EMPTY_LEDGER)).toBe(
      'companion',
    );
  });

  it('lets an explicit preference win over detection', () => {
    expect(resolveCheckpointMode('companion', codingMessages, EMPTY_LEDGER)).toBe('companion');
    expect(resolveCheckpointMode('coding', [message('user', '今天好累')], EMPTY_LEDGER)).toBe(
      'coding',
    );
  });

  it('treats an existing task board as a coding signal', () => {
    const board: TaskBoardSnapshot = {
      runId: 'run-1',
      tasks: [{ id: 't-1', title: '实现', status: 'pending', required: true }],
    };
    expect(inferCheckpointMode([message('user', '开始吧')], EMPTY_LEDGER, board)).toBe('coding');
  });
});

describe('work evidence', () => {
  const ledger = buildWorkLedger([
    call(1, 'c1', 'edit', { file_path: 'src/session/service.ts' }),
    result(2, 'c1', 'edit', 'succeeded'),
    call(3, 'c2', 'bash', { command: 'npm test' }),
    result(4, 'c2', 'bash', 'failed', { summary: '退出码 1', output: '1 failed' }),
    call(5, 'c3', 'bash', { command: 'npm run build' }),
  ]);
  const board: TaskBoardSnapshot = {
    runId: 'run-1',
    tasks: [
      {
        id: 'task-1',
        title: '拆分 compact',
        status: 'running',
        required: true,
        acceptance: 'npm test 通过',
      },
      { id: 'task-0', title: '写契约测试', status: 'accepted', required: true },
    ],
  };

  it('renders the facts a resumed model needs, and the board', () => {
    const text = renderWorkEvidence(ledger, board);
    expect(text).toContain(EVIDENCE_HEADING);
    expect(text).toContain('src/session/service.ts');
    expect(text).toContain('npm test');
    expect(text).toContain('退出码 1');
    expect(text).toContain('没有返回结果');
    expect(text).toContain('### 任务板');
    expect(text).toContain('task-0');
    // Accepted work sorts ahead of running work: settled first.
    expect(text.indexOf('task-0')).toBeLessThan(text.indexOf('task-1'));
  });

  it('keeps the narrative and the appendix separate', () => {
    const narrative = '## 任务与约束\n- 拆分 compact';
    const composed = composeCheckpoint(narrative, ledger, board, 2_000, 'mixed');
    const split = splitCheckpoint(composed);
    expect(split.narrative).toContain('## 任务与约束');
    expect(split.narrative).not.toContain(EVIDENCE_HEADING);
    expect(split.evidence).toContain(EVIDENCE_HEADING);
  });

  it('reserves half the budget for evidence instead of truncating it away', () => {
    const narrative = '## 任务与约束\n' + '- 很长的叙述。'.repeat(200);
    const composed = composeCheckpoint(narrative, ledger, board, 300, 'mixed');
    expect(composed).toContain(EVIDENCE_HEADING);
    expect(composed).toContain('npm test');
  });

  it('does not exceed a tiny checkpoint budget', () => {
    const narrative = '## 任务与约束\n' + '- 很长的叙述。'.repeat(200);
    const composed = composeCheckpoint(narrative, ledger, board, 64, 'mixed');
    // The estimator and the ellipsis make this approximate by less than a token.
    expect(estimateTokens(composed, 'mixed')).toBeLessThanOrEqual(66);
  });

  it('returns the narrative alone when there is no evidence', () => {
    expect(composeCheckpoint('## 任务与约束\n- 无', EMPTY_LEDGER, null, 1_000, 'mixed')).toBe(
      '## 任务与约束\n- 无',
    );
  });

  it('parses its own output back into files, verification, pending and board', () => {
    const composed = composeCheckpoint(
      ['# 检查点', ...CODING_CHECKPOINT_SECTIONS.map((section) => `${section}\n- 内容`)].join('\n'),
      ledger,
      board,
      2_000,
      'mixed',
    );
    const parsed = parseCheckpoint(composed);

    expect(parsed.mode).toBe('coding');
    expect(parsed.sections[0]?.title).toBe('任务与约束');
    expect(parsed.evidence?.files).toMatchObject([
      { path: 'src/session/service.ts', operation: '修改', calls: 1, lastStatus: 'passed' },
    ]);
    expect(parsed.evidence?.verifications[0]).toMatchObject({
      status: 'failed',
      command: 'npm test',
      exitCode: 1,
    });
    // The build command ran with no result, so it is a verification too — and
    // an unconfirmed one, not a pass.
    expect(parsed.evidence?.verifications[1]).toMatchObject({
      status: 'unconfirmed',
      command: 'npm run build',
      exitCode: null,
    });
    expect(parsed.evidence?.pending).toMatchObject([
      { toolName: 'bash', reason: 'no_result' },
    ]);
    expect(parsed.evidence?.board.map((task) => task.id)).toEqual(['task-0', 'task-1']);
    expect(parsed.evidence?.index).toHaveLength(1);
  });

  it('does not carry an older appendix forward into the model prompt', () => {
    const previous = [
      '## 任务与约束',
      '- 旧任务',
      '',
      EVIDENCE_HEADING,
      '### 文件变更',
      '- `src/old.ts` · 修改 1 次 · 最后一次成功（turn old/seq 1）',
    ].join('\n');
    const split = splitCheckpoint(previous);
    expect(split.narrative).toBe('## 任务与约束\n- 旧任务');
    expect(split.evidence).toContain('src/old.ts');
  });

  it('builds a member brief from the work sections only', () => {
    const parsed = parseCheckpoint(
      [
        '## 任务与约束',
        '- 拆分 compact',
        '## 情绪与连续性',
        '- 与任务无关',
        '## 下一步',
        '- 跑测试',
        '',
        EVIDENCE_HEADING,
        '### 证据索引',
        '- turn t1（2026-11-08T09:00:00Z）· 2 次工具调用',
      ].join('\n'),
    );
    const brief = renderCheckpointBrief(parsed);
    expect(brief).toContain('拆分 compact');
    expect(brief).toContain('跑测试');
    expect(brief).toContain('证据索引');
    expect(brief).not.toContain('与任务无关');
  });
});

describe('task board', () => {
  const board: TaskBoardSnapshot = {
    runId: 'run-1',
    tasks: [
      { id: 't-1', title: '实现', status: 'pending', required: true, dependencies: ['t-0'] },
      { id: 't-2', title: '审查', status: 'submitted', required: false },
    ],
  };

  it('renders only open work as a task list and keeps ids machine-readable', () => {
    const text = renderTaskBoardSection(board);
    expect(text).toContain('### 任务板');
    expect(text).toContain('`t-1` [pending] 实现');
    expect(text).toContain('依赖：t-0');
    expect(text).toContain('`t-2` [submitted] 审查');
    expect(text).toBe(renderTaskBoardSection({ ...board, tasks: [...board.tasks].reverse() }));
  });

  it('returns nothing for a conversation without a board', () => {
    expect(renderTaskBoardSection(null)).toBe('');
    expect(renderTaskBoardSection({ runId: 'run-1', tasks: [] })).toBe('');
  });

  it('marks only pending, running and submitted tasks as open', () => {
    expect(isOpenBoardTask({ ...board.tasks[0]!, status: 'pending' })).toBe(true);
    expect(isOpenBoardTask({ ...board.tasks[0]!, status: 'running' })).toBe(true);
    expect(isOpenBoardTask({ ...board.tasks[0]!, status: 'submitted' })).toBe(true);
    expect(isOpenBoardTask({ ...board.tasks[0]!, status: 'accepted' })).toBe(false);
    expect(isOpenBoardTask({ ...board.tasks[0]!, status: 'failed' })).toBe(false);
  });

  it('hands a fresh member the task and the checkpoint instead of the transcript', () => {
    const brief = renderTaskBrief({
      task: {
        id: 't-1',
        title: '实现检查点',
        status: 'pending',
        required: true,
        acceptance: '测试通过',
        dependencies: ['t-0'],
      },
      checkpoint: '## 任务与约束\n- 保留任务板',
    });
    expect(brief).toContain('# 任务');
    expect(brief).toContain('t-1');
    expect(brief).toContain('验收条件：测试通过');
    expect(brief).toContain('依赖：t-0');
    expect(brief).toContain('保留任务板');
    expect(brief).toContain('不是用户的新指令');
  });
});

describe('FileMutation shape', () => {
  it('is a plain value the API can serialise', () => {
    const file: FileMutation = {
      path: 'src/a.ts',
      operation: 'edit',
      calls: 1,
      lastStatus: 'unconfirmed',
      evidence: 'turn t/seq 1',
    };
    expect(JSON.parse(JSON.stringify(file))).toEqual(file);
  });

  it('keeps a ledger with no tool calls empty rather than inventing a section', () => {
    const empty: WorkLedger = EMPTY_LEDGER;
    expect(renderWorkEvidence(empty, null)).toBe('');
  });
});
