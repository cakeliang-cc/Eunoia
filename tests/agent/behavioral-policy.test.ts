/**
 * Policy data integrity.
 *
 * The `boundary` assertion is the one that carries product meaning: each of the
 * four heuristics is harmful when unbounded (Ne becomes anxiety, Te becomes
 * productivity coaching, Si becomes mechanical citation of the past). Requiring
 * a boundary on every heuristic makes the spec's anti-patterns structural rather
 * than a matter of remembering.
 */

import { describe, expect, it } from 'vitest';
import {
  FUNCTION_HEURISTICS,
  INTERACTION_PRINCIPLES,
  POLICY_IDS,
} from '../../src/agent/behavioral-policy.ts';

describe('interaction principles (spec §3)', () => {
  it('covers all five required principles', () => {
    expect(INTERACTION_PRINCIPLES.map((p) => p.id)).toEqual([
      'dont_rush_to_solve',
      'one_question',
      'dont_define_user',
      'gentle_not_unconditional',
      'not_life_judge',
    ]);
  });

  it('states each rule as behaviour and lists what violates it', () => {
    for (const principle of INTERACTION_PRINCIPLES) {
      expect(principle.rule.length, principle.id).toBeGreaterThan(10);
      expect(principle.avoid.length, principle.id).toBeGreaterThan(0);
      expect(principle.label.length, principle.id).toBeGreaterThan(0);
    }
  });
});

describe('function heuristics (spec §2)', () => {
  it('defines exactly Fi, Ne, Si, Te — and nothing that acts like a second agent', () => {
    expect(FUNCTION_HEURISTICS.map((h) => h.id)).toEqual(['fi', 'ne', 'si', 'te']);
  });

  it('gives every heuristic a boundary, so none is unbounded', () => {
    for (const heuristic of FUNCTION_HEURISTICS) {
      expect(heuristic.boundary.length, `${heuristic.id} has no boundary`).toBeGreaterThan(10);
    }
  });

  it('encodes the specific failure modes the spec warns about', () => {
    const ne = FUNCTION_HEURISTICS.find((h) => h.id === 'ne');
    const te = FUNCTION_HEURISTICS.find((h) => h.id === 'te');
    const si = FUNCTION_HEURISTICS.find((h) => h.id === 'si');

    // Ne must expand possibility without manufacturing anxiety.
    expect(ne?.boundary).toContain('焦虑');
    // Te must not convert everything into productivity work.
    expect(te?.avoid.join()).toContain('productivity');
    // Si must not cite history mechanically.
    expect(si?.boundary).toContain('相关');
  });
});

describe('POLICY_IDS', () => {
  it('exposes every policy id, with no duplicates', () => {
    expect(POLICY_IDS).toHaveLength(INTERACTION_PRINCIPLES.length + FUNCTION_HEURISTICS.length);
    expect(new Set(POLICY_IDS).size).toBe(POLICY_IDS.length);
  });
});
