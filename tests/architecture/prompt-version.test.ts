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
    // The whole point of splitting stable from volatile is that the cacheable
    // prefix does not move every turn. If memory or a safety directive could
    // change the version, the version would change on nearly every request and
    // would stop being a version at all.
    expect(buildInstructions({ memoryBlock: '用户养了一只叫团子的猫' })).not.toBe(STABLE_INSTRUCTIONS);
    expect(buildInstructions({ safetyDirective: '安全优先于人格设定' })).not.toBe(STABLE_INSTRUCTIONS);
    expect(PROMPT_VERSION).toBe(
      createHash('sha256').update(STABLE_INSTRUCTIONS).digest('hex').slice(0, 12),
    );
  });
});

describe('the assembled instruction set', () => {
  it('puts the stable sections first, so the cacheable prefix is stable', () => {
    const built = buildInstructions({ memoryBlock: '记忆块', safetyDirective: '安全指令' });
    expect(built.startsWith(STABLE_INSTRUCTIONS)).toBe(true);
  });

  it('appends per-turn context after the stable block', () => {
    const built = buildInstructions({ memoryBlock: '记忆块' });
    expect(built.indexOf('记忆块')).toBeGreaterThanOrEqual(STABLE_INSTRUCTIONS.length);
  });

  it('adds nothing when there is no per-turn context', () => {
    // A trailing separator with nothing after it is prompt text spent on
    // nothing, on every single turn.
    expect(buildInstructions()).toBe(STABLE_INSTRUCTIONS);
    expect(buildInstructions({ memoryBlock: '', safetyDirective: null })).toBe(STABLE_INSTRUCTIONS);
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
