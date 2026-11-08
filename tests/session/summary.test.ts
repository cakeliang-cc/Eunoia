/**
 * The summary boundary's text contract.
 *
 * The summary is a system-prompt block, never a synthetic user message; these
 * tests pin that shape so a later refactor cannot make the UI show words the
 * person never said.
 */

import { describe, expect, it } from 'vitest';
import {
  cleanSummary,
  CODING_SUMMARY_PROMPT,
  renderArchivedSummary,
  renderSummaryPrompt,
  SUMMARY_SYSTEM_PROMPT,
  summaryPromptVersion,
  summarySystemPrompt,
} from '../../src/session/summary.ts';

describe('SUMMARY_SYSTEM_PROMPT', () => {
  it('requires a structured checkpoint and preserves corrections and quotes', () => {
    expect(SUMMARY_SYSTEM_PROMPT).toContain('## 当前主线');
    expect(SUMMARY_SYSTEM_PROMPT).toContain('## 重要事实与偏好');
    expect(SUMMARY_SYSTEM_PROMPT).toContain('## 人物与关系');
    expect(SUMMARY_SYSTEM_PROMPT).toContain('## 情绪与连续性');
    expect(SUMMARY_SYSTEM_PROMPT).toContain('## 承诺与未完成');
    expect(SUMMARY_SYSTEM_PROMPT).toContain('## 最近状态');
    expect(SUMMARY_SYSTEM_PROMPT).toContain('## 需要保留的原话');
    expect(SUMMARY_SYSTEM_PROMPT).toContain('## 关键背景');
    expect(SUMMARY_SYSTEM_PROMPT).toContain('不要原样复述旧摘要');
  });
});

describe('CODING_SUMMARY_PROMPT', () => {
  it('keeps work state, not just conversation state', () => {
    // The five facts a resumed coding turn cannot re-derive: what was asked,
    // what changed and why, what was verified, what is unconfirmed, and what is
    // next with a pointer to its evidence.
    for (const section of [
      '## 任务与约束',
      '## 文件与改动理由',
      '## 验证',
      '## 待确认',
      '## 下一步',
      '## 任务板',
    ]) {
      expect(CODING_SUMMARY_PROMPT).toContain(section);
    }
    expect(CODING_SUMMARY_PROMPT).toContain('不要编造文件、测试结果或退出码');
    expect(CODING_SUMMARY_PROMPT).toContain('证据');
  });

  it('selects the template and its version per mode', () => {
    expect(summarySystemPrompt('coding')).toBe(CODING_SUMMARY_PROMPT);
    expect(summarySystemPrompt()).toBe(SUMMARY_SYSTEM_PROMPT);
    expect(summaryPromptVersion('coding')).not.toBe(summaryPromptVersion('companion'));
    expect(summaryPromptVersion('coding')).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('renderArchivedSummary', () => {
  it('labels the block as an earlier-conversation summary', () => {
    const block = renderArchivedSummary('用户最近在准备面试。');
    expect(block).toContain('# 更早的对话');
    expect(block).toContain('用户最近在准备面试。');
    expect(block).toContain('<compacted-summary>');
    expect(block).toContain('</compacted-summary>');
    expect(block).not.toContain('用户：');
  });
});

describe('renderSummaryPrompt', () => {
  it('marks an image block without pretending the summary model saw pixels (A15)', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const prompt = renderSummaryPrompt({
      previousSummary: null,
      messages: [
        {
          id: 'm1',
          conversationId: 'c1',
          userId: 'u1',
          role: 'user',
          content: '',
          contentParts: {
            version: 1,
            parts: [
              { type: 'text', text: '看这张' },
              { type: 'image', assetId: id },
            ],
          },
          interrupted: false,
          createdAt: new Date(),
          seq: 1,
        },
      ],
      maxOutputTokens: 100,
    });
    expect(prompt).toContain('用户：看这张');
    expect(prompt).toContain('图片附件');
    expect(prompt).toContain(id);
    expect(prompt).not.toContain('data:image');
  });

  it('carries both the previous checkpoint and the new transcript', () => {
    const prompt = renderSummaryPrompt({
      previousSummary: '旧摘要',
      messages: [
        {
          id: 'm1',
          conversationId: 'c1',
          userId: 'u1',
          role: 'user',
          content: '新消息',
          interrupted: false,
          createdAt: new Date(),
          seq: 1,
        },
      ],
      maxOutputTokens: 100,
    });

    expect(prompt).toContain('[已有检查点]');
    expect(prompt).toContain('旧摘要');
    expect(prompt).toContain('用户：新消息');
  });

  it('adds the recorded work evidence only to a coding checkpoint', () => {
    const ledger = {
      toolCalls: 1,
      files: [
        {
          path: 'src/only-in-ledger.ts',
          operation: 'edit' as const,
          calls: 1,
          lastStatus: 'passed' as const,
          evidence: 'turn t1/seq 2',
        },
      ],
      commands: [],
      pending: [],
      searched: false,
      trace: [],
    };
    const request = {
      previousSummary: null,
      messages: [
        {
          id: 'm1',
          conversationId: 'c1',
          userId: 'u1',
          role: 'user' as const,
          content: '改一下 src/a.ts',
          interrupted: false,
          createdAt: new Date(),
          seq: 1,
        },
      ],
      maxOutputTokens: 100,
    };

    const coding = renderSummaryPrompt({ ...request, mode: 'coding', ledger });
    expect(coding).toContain('[系统记录的工作证据]');
    expect(coding).toContain('src/only-in-ledger.ts');

    const companion = renderSummaryPrompt({ ...request, mode: 'companion', ledger });
    expect(companion).not.toContain('[系统记录的工作证据]');
    expect(companion).not.toContain('src/only-in-ledger.ts');
  });
});

describe('cleanSummary', () => {
  it('strips a markdown fence and bounds the checkpoint', () => {
    const cleaned = cleanSummary('```text\n' + '我'.repeat(50) + '\n```', 10, 'mixed');
    expect(cleaned.startsWith('我')).toBe(true);
    expect(cleaned.endsWith('…')).toBe(true);
  });
});
