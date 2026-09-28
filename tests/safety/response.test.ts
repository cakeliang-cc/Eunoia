/**
 * The output guardrail (spec §10).
 *
 * This is the test that matters most in the whole suite, because it is the only
 * place where the system does not take the model's word for anything. The system
 * prompt asks the model to handle a crisis well; this file checks what happens
 * when it does not.
 */

import { describe, expect, it } from 'vitest';
import {
  CRISIS_DIRECTIVE,
  CRISIS_FALLBACK,
  applyOutputCheck,
  checkCrisisReply,
  checkElevatedReply,
  safetyDirectiveFor,
} from '../../src/safety/response.ts';

const GOOD_CRISIS_REPLY =
  '我很担心你。你现在安全吗？如果情况紧急请打 120，' +
  '全国24小时心理援助热线是 12356，随时有人接。你不用一个人扛着。';

describe('safetyDirectiveFor', () => {
  it('gives a crisis directive for crisis', () => {
    expect(safetyDirectiveFor('crisis')).toBe(CRISIS_DIRECTIVE);
  });

  it('gives a lighter directive for elevated', () => {
    const directive = safetyDirectiveFor('elevated');
    expect(directive).toBeTruthy();
    expect(directive).not.toBe(CRISIS_DIRECTIVE);
  });

  it('gives nothing when there is no risk', () => {
    expect(safetyDirectiveFor('none')).toBeNull();
  });

  it('states that safety outranks the persona', () => {
    // The directive has to be an override, not advice — the behavioural policy
    // it overrides says "ask one question, don\'t be directive", which is
    // exactly wrong for a crisis.
    expect(CRISIS_DIRECTIVE).toContain('安全优先于人格设定');
    expect(CRISIS_DIRECTIVE).toContain('让位');
  });

  it('names real, reachable resources', () => {
    expect(CRISIS_DIRECTIVE).toContain('12356');
    expect(CRISIS_DIRECTIVE).toContain('120');
    expect(CRISIS_DIRECTIVE).toContain('110');
  });
});

describe('checkCrisisReply', () => {
  it('passes a reply that names a resource and does not minimise', () => {
    expect(checkCrisisReply(GOOD_CRISIS_REPLY).ok).toBe(true);
  });

  it('fails a reply with no resource', () => {
    const check = checkCrisisReply('听起来你很难受，我在这里陪着你。');
    expect(check.ok).toBe(false);
    expect(check.violations).toContain('no_resource');
  });

  it('fails a reply that minimises', () => {
    const check = checkCrisisReply(`${GOOD_CRISIS_REPLY} 不过你想开点就好了。`);
    expect(check.violations).toContain('minimising');
  });

  it('fails a reply that diagnoses', () => {
    const check = checkCrisisReply(`${GOOD_CRISIS_REPLY} 你可能得了抑郁症。`);
    expect(check.violations).toContain('diagnosing');
  });

  it('fails a reply too long to be useful in a crisis', () => {
    const check = checkCrisisReply(`${GOOD_CRISIS_REPLY}${'补充说明。'.repeat(200)}`);
    expect(check.violations).toContain('too_long');
  });

  it('fails an empty reply', () => {
    expect(checkCrisisReply('').violations).toEqual(['empty']);
  });

  it('reports every violation, not just the first', () => {
    // A test that fails should show the whole problem, not one symptom of it.
    const check = checkCrisisReply('你想开点。你可能得了抑郁症。');
    expect(check.violations).toContain('no_resource');
    expect(check.violations).toContain('minimising');
    expect(check.violations).toContain('diagnosing');
  });

  it('does not fire on ordinary warm language', () => {
    // A check that flags good replies gets disabled by whoever is trying to
    // ship, so the patterns are deliberately narrow.
    const check = checkCrisisReply(
      '我理解你说的。你愿意的话，可以打 12356 跟专业的人聊聊，也可以先跟我说说。',
    );
    expect(check.ok).toBe(true);
  });
});

describe('checkElevatedReply', () => {
  it('does not require a resource', () => {
    expect(checkElevatedReply('听上去这阵子真的很重。今天身边有人吗？').ok).toBe(true);
  });

  it('still catches minimising language', () => {
    expect(checkElevatedReply('别多想，加油').violations).toContain('minimising');
  });
});

describe('applyOutputCheck', () => {
  it('leaves an ordinary reply untouched', () => {
    const outcome = applyOutputCheck('none', '今天怎么了？');
    expect(outcome.replaced).toBe(false);
    expect(outcome.reply).toBe('今天怎么了？');
  });

  it('replaces a failing crisis reply with the fallback', () => {
    const outcome = applyOutputCheck('crisis', '想开点，一切都会好的。');
    expect(outcome.replaced).toBe(true);
    expect(outcome.reply).toBe(CRISIS_FALLBACK);
  });

  it('lets a good crisis reply through unchanged', () => {
    const outcome = applyOutputCheck('crisis', GOOD_CRISIS_REPLY);
    expect(outcome.replaced).toBe(false);
    expect(outcome.reply).toBe(GOOD_CRISIS_REPLY);
  });

  it('does NOT replace an elevated reply, only reports it', () => {
    // Substituting a template for a merely-insensitive reply would feel like
    // being hung up on, which is its own kind of harm.
    const outcome = applyOutputCheck('elevated', '别多想，加油');
    expect(outcome.replaced).toBe(false);
    expect(outcome.reply).toBe('别多想，加油');
    expect(outcome.violations.length).toBeGreaterThan(0);
  });

  it('the fallback itself would pass the check', () => {
    // Otherwise the guardrail would produce output it would reject, which is
    // the kind of thing that is only discovered during an incident.
    expect(checkCrisisReply(CRISIS_FALLBACK).ok).toBe(true);
  });

  it('the fallback names real numbers and does not diagnose', () => {
    expect(CRISIS_FALLBACK).toContain('12356');
    expect(CRISIS_FALLBACK).toContain('120');
    expect(checkCrisisReply(CRISIS_FALLBACK).violations).toEqual([]);
  });
});
