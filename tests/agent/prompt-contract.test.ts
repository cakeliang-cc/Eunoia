/**
 * The spec requirements the prompt is checked against.
 *
 * `prompt-document.test.ts` uses these as its checklist. This file checks the
 * checklist itself — a duplicate id or an empty label would make that test pass
 * for the wrong reason, and a contract that cannot fail is not a contract.
 *
 * There was a third block here, for `RUMINATION_SIGNALS`. It is gone with the
 * list it tested; `src/agent/prompt-contract.ts` records why the list was
 * removed rather than wired up.
 */

import { describe, expect, it } from 'vitest';
import { REQUIRED_HEURISTICS, REQUIRED_PRINCIPLES } from '../../src/agent/prompt-contract.ts';

describe('the principle contract (spec §3)', () => {
  it('covers all five required principles, in the spec’s order', () => {
    expect(REQUIRED_PRINCIPLES.map((p) => p.id)).toEqual([
      'dont_rush_to_solve',
      'one_question',
      'dont_define_user',
      'gentle_not_unconditional',
      'not_life_judge',
    ]);
  });

  it('leaves no label empty, which would pin nothing', () => {
    for (const principle of REQUIRED_PRINCIPLES) {
      expect(principle.label.length, principle.id).toBeGreaterThan(1);
    }
  });
});

describe('the lens contract (spec §2)', () => {
  it('defines exactly Fi, Ne, Si, Te — and nothing that acts like a second agent', () => {
    expect(REQUIRED_HEURISTICS.map((h) => h.id)).toEqual(['fi', 'ne', 'si', 'te']);
  });

  it('pins a boundary phrase for every lens', () => {
    // The phrase is the lens's failure mode. A lens with none pinned is a lens
    // nothing stops from being used unbounded.
    for (const heuristic of REQUIRED_HEURISTICS) {
      expect(heuristic.mustMention.length, heuristic.id).toBeGreaterThan(0);
      expect(heuristic.coreQuestion.length, heuristic.id).toBeGreaterThan(5);
      // The heading carries the spec's own two-letter name, so a rename in the
      // document cannot silently detach the lens from the spec section.
      expect(heuristic.heading.toUpperCase()).toContain(heuristic.id.toUpperCase());
    }
  });
});

