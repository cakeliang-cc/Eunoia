/**
 * Enforces canonical DeepSeek model IDs (ADR 005).
 *
 * This guard exists because the failure it prevents is *silent*. DeepSeek
 * resolves `deepseek-chat`, `deepseek-reasoner`, and `deepseek-v4-flash` to
 * `deepseek-flash` with no error, so writing `deepseek-reasoner` somewhere would
 * quietly run the weaker model. Nothing would fail — the agent would just be
 * worse, and the cause would be very hard to find.
 */

import { describe, expect, it } from 'vitest';
import { FORBIDDEN_MODEL_ALIASES, MODEL_IDS } from '../../src/config.ts';
import { readSources } from '../helpers/sources.ts';

/** `src/config.ts` is where the aliases are declared, so it is exempt. */
const DECLARATION_SITE = 'src/config.ts';

describe('canonical model IDs (ADR 005)', () => {
  it('declares exactly the two model IDs that exist', () => {
    expect(Object.values(MODEL_IDS).sort()).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
  });

  it('no source file outside config.ts references a forbidden alias', async () => {
    const sources = await readSources();
    const violations: string[] = [];

    for (const { relativePath, source } of sources) {
      if (relativePath === DECLARATION_SITE) continue;
      for (const alias of FORBIDDEN_MODEL_ALIASES) {
        if (source.includes(alias)) {
          violations.push(`${relativePath} references "${alias}"`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('aliases would be caught if introduced', async () => {
    // Prove the detector is not vacuous.
    const synthetic = `const model = 'deepseek-reasoner';`;
    expect(FORBIDDEN_MODEL_ALIASES.some((alias) => synthetic.includes(alias))).toBe(true);
  });
});
