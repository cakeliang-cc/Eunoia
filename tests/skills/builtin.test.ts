/**
 * The built-in skills are part of the product, so they are parsed by the same
 * tests as user skills. A malformed built-in would otherwise ship silently: the
 * registry would report a diagnostic that nobody reads, and `load_skill` would
 * simply be absent for that workflow.
 */

import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { discoverSkillRegistry } from '../../src/skills/registry.ts';
import { PROJECT_ROOT } from '../helpers/sources.ts';

const BUILTIN = join(PROJECT_ROOT, 'src', 'skills', 'builtin');

describe('built-in skills', () => {
  it('all parse, have a trigger description, and declare their tools', async () => {
    const registry = await discoverSkillRegistry([{ dir: BUILTIN, source: 'builtin' }]);
    expect(registry.diagnostics()).toEqual([]);
    expect(registry.list().map((skill) => skill.manifest.name)).toEqual([
      'code-change-verification',
      'docs-sync',
      'release-review',
    ]);

    for (const skill of registry.list()) {
      expect(skill.source).toBe('builtin');
      expect(skill.manifest.description.length).toBeGreaterThan(20);
      expect(skill.manifest.allowedTools.length).toBeGreaterThan(0);
      expect(skill.body.length).toBeGreaterThan(100);
      expect(skill.references).toEqual([]);
      expect(skill.scripts).toEqual([]);
    }
  });

  it('does not put bodies in the index', async () => {
    const registry = await discoverSkillRegistry([{ dir: BUILTIN, source: 'builtin' }]);
    const index = registry.indexBlock();
    for (const skill of registry.list()) {
      expect(index).toContain(skill.manifest.name);
      expect(index).not.toContain(skill.body.slice(0, 30));
    }
  });
});
