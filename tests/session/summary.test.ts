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
  renderArchivedSummary,
  renderSummaryPrompt,
  SUMMARY_SYSTEM_PROMPT,
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
          createdAt: new Date(),
          seq: 1,
        },
      ],
      maxOutputTokens: 100,
    });

    expect(prompt).toContain('[已有摘要]');
    expect(prompt).toContain('旧摘要');
    expect(prompt).toContain('用户：新消息');
  });
});

describe('cleanSummary', () => {
  it('strips a markdown fence and bounds the checkpoint', () => {
    const cleaned = cleanSummary('```text\n' + '我'.repeat(50) + '\n```', 10, 'mixed');
    expect(cleaned.startsWith('我')).toBe(true);
    expect(cleaned.endsWith('…')).toBe(true);
  });
});
