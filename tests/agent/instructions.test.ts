/**
 * Guards the system prompt.
 *
 * The important assertion is the last one: the behavioural policy exists as data
 * in `behavioral-policy.ts` and as prose in `instructions.ts`, and those two
 * representations must not drift apart. Without this test, editing one and
 * forgetting the other produces a prompt that claims to follow a rule the code
 * no longer asserts.
 */

import { describe, expect, it } from 'vitest';
import {
  FUNCTION_HEURISTICS,
  INTERACTION_PRINCIPLES,
  looksLikeRumination,
  RUMINATION_SIGNALS,
} from '../../src/agent/behavioral-policy.ts';
import { buildInstructions } from '../../src/agent/instructions.ts';

const prompt = buildInstructions();

describe('buildInstructions', () => {
  it('includes every section required by spec §11', () => {
    const requiredHeadings = [
      '# 身份',
      '# 核心使命',
      '# 行为原则',
      '# 四种视角',
      '# 记忆规则',
      '# 对话规则',
      '# 安全规则',
      '# 工具规则',
      '# 示例',
    ];
    for (const heading of requiredHeadings) {
      expect(prompt, `missing section: ${heading}`).toContain(heading);
    }
  });

  it('names the four heuristics without presenting them as separate agents', () => {
    for (const heuristic of FUNCTION_HEURISTICS) {
      expect(prompt).toContain(heuristic.coreQuestion);
    }
    expect(prompt).toContain('不是四个角色');
  });

  it('states that safety outranks personality (spec §10)', () => {
    expect(prompt).toContain('安全永远优先于人格设定');
  });

  it('forbids storing speculation as fact (spec §7)', () => {
    expect(prompt).toContain('推测不是事实');
  });

  it('has no empty or stub sections', () => {
    const sections = prompt.split(/\n(?=# )/);
    // 9 sections plus any leading content.
    expect(sections.length).toBeGreaterThanOrEqual(9);
    for (const section of sections) {
      if (!section.startsWith('#')) continue;
      const body = section.slice(section.indexOf('\n')).trim();
      expect(body.length, `section is effectively empty:\n${section.slice(0, 40)}`).toBeGreaterThan(
        50,
      );
    }
  });

  it('renders every policy rule, so prompt and policy cannot drift', () => {
    for (const principle of INTERACTION_PRINCIPLES) {
      expect(prompt, `principle not rendered: ${principle.id}`).toContain(principle.label);
      expect(prompt).toContain(principle.rule);
    }
    for (const heuristic of FUNCTION_HEURISTICS) {
      expect(prompt, `boundary not rendered: ${heuristic.id}`).toContain(heuristic.boundary);
    }
  });

  it('is stable across calls, so the cached prefix stays cacheable', () => {
    expect(buildInstructions()).toBe(prompt);
  });
});

describe('rumination detection (spec §12 case 05)', () => {
  it('recognises the canonical case', () => {
    expect(looksLikeRumination('我想了两个月还是不知道自己想要什么。')).toBe(true);
  });

  it('does not fire on ordinary emotional statements', () => {
    expect(looksLikeRumination('今天真的什么都不想做。')).toBe(false);
    expect(looksLikeRumination('我是不是应该辞职？')).toBe(false);
  });

  it('declares at least one signal', () => {
    expect(RUMINATION_SIGNALS.length).toBeGreaterThan(0);
  });
});
