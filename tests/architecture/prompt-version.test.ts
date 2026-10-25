/**
 * The prompt version is a real version, not decoration.
 *
 * `PROMPT_VERSION` is the hash of the stable instruction sections, and everything
 * downstream leans on it meaning something:
 *
 *   - a recorded evaluation run is stamped with it, so "these replies came from
 *     this prompt" is checkable rather than assumed;
 *   - `npm run eval -- --replay` warns when the recording and the current prompt
 *     disagree, because replaying old replies against a new prompt measures
 *     nothing;
 *   - a run row in `agent_runs` carries it, so a reply can be traced back to the
 *     instructions that produced it long after the fact.
 *
 * A constant string would satisfy all three call sites and mean none of it. The
 * assertions here are what keep it honest.
 *
 * One property is deliberately *not* enforced: that changing the prompt changes
 * the version. That follows from it being a hash, and a test asserting it would
 * have to edit the instructions to prove it.
 */

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  PROMPT_FILE,
  PROMPT_VERSION,
  STABLE_INSTRUCTIONS,
  buildInstructions,
  stripComments,
} from '../../src/agent/instructions.ts';
import { buildRuntimeContext } from '../../src/agent/runtime-context.ts';
import { REQUIRED_PRINCIPLES } from '../../src/agent/prompt-contract.ts';

describe('PROMPT_VERSION', () => {
  it('is a hash of the stable sections', () => {
    const expected = createHash('sha256').update(STABLE_INSTRUCTIONS).digest('hex').slice(0, 12);
    expect(PROMPT_VERSION).toBe(expected);
  });

  it('is short and stable in shape', () => {
    expect(PROMPT_VERSION).toMatch(/^[0-9a-f]{12}$/);
  });

  it('does not change when only per-turn context changes', () => {
    // The cacheable prefix is the stable prompt plus append-only history. If a
    // memory, clock, relationship or safety directive could change this string,
    // the prefix would move on nearly every request and stop being cacheable.
    expect(buildInstructions()).toBe(STABLE_INSTRUCTIONS);
    const context = buildRuntimeContext({
      relationshipBlock: '你们刚开始认识',
      situationBlock: '现在是 2026年10月25日',
      memoryBlock: '用户养了一只叫团子的猫',
      safetyDirective: '安全优先于人格设定',
    });
    expect(context).toContain('团子');
    expect(context).toContain('安全优先于人格设定');
    expect(buildInstructions()).not.toContain('团子');
    expect(PROMPT_VERSION).toBe(
      createHash('sha256').update(STABLE_INSTRUCTIONS).digest('hex').slice(0, 12),
    );
  });
});

describe('the runtime context', () => {
  it('is separate from the stable instructions', () => {
    const built = buildRuntimeContext({ memoryBlock: '记忆块', safetyDirective: '安全指令' });
    expect(buildInstructions()).toBe(STABLE_INSTRUCTIONS);
    expect(built).not.toContain('# 身份');
    expect(built).toContain('记忆块');
  });

  it('puts the relationship before the memories, because it changes less often', () => {
    const built = buildRuntimeContext({ relationshipBlock: '关系块', memoryBlock: '记忆块' });
    expect(built.indexOf('关系块')).toBeLessThan(built.indexOf('记忆块'));
  });

  it('puts the clock after the summary and before the memories', () => {
    const built = buildRuntimeContext({
      relationshipBlock: '关系块',
      archivedSummaryBlock: '摘要块',
      situationBlock: '处境块',
      memoryBlock: '记忆块',
    });
    expect(built.indexOf('关系块')).toBeLessThan(built.indexOf('摘要块'));
    expect(built.indexOf('摘要块')).toBeLessThan(built.indexOf('处境块'));
    expect(built.indexOf('处境块')).toBeLessThan(built.indexOf('记忆块'));
  });

  it('puts the safety directive last, so it reads as an override', () => {
    const built = buildRuntimeContext({
      relationshipBlock: '关系块',
      memoryBlock: '记忆块',
      safetyDirective: '安全指令',
    });
    expect(built.indexOf('记忆块')).toBeLessThan(built.indexOf('安全指令'));
  });

  it('adds nothing when there is no per-turn context', () => {
    expect(buildRuntimeContext()).toBe('');
    expect(buildRuntimeContext({ memoryBlock: '', safetyDirective: null })).toBe('');
  });

  it('hashes the document that was loaded, not a copy of it', () => {
    // The version is derived from the string the model is sent. If it were
    // derived from anything else — a hand-maintained constant, a build-time
    // inlining — it would be possible for the recorded version to describe
    // instructions that are no longer the ones in use, which is the one thing it
    // exists to prevent.
    const onDisk = readFileSync(PROMPT_FILE, 'utf8');
    expect(STABLE_INSTRUCTIONS).toBe(stripComments(onDisk).trim());
    expect(PROMPT_VERSION).toBe(
      createHash('sha256').update(stripComments(onDisk).trim()).digest('hex').slice(0, 12),
    );
  });

  it('records the principles the spec requires, by the labels the document uses', () => {
    // The full check is in tests/agent/prompt-document.test.ts. This one exists
    // because the version's meaning depends on it: if the prompt can lose a
    // principle without anything failing, the version is a version of something
    // that is not the product.
    for (const principle of REQUIRED_PRINCIPLES) {
      expect(STABLE_INSTRUCTIONS, `${principle.id} is missing from the prompt`).toContain(
        principle.label,
      );
    }
  });

  it('states the memory and tool rules that the service layer depends on', () => {
    // The service retrieves memory and offers tools; the prompt is where the
    // model is told what to do with what it is given.
    expect(STABLE_INSTRUCTIONS).toContain('不是全部');
    expect(STABLE_INSTRUCTIONS).toContain('search_memory');
  });
});
