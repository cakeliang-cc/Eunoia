/**
 * Discovery, precedence and the index.
 *
 * The index is the only skill content that is in the prompt every turn, so the
 * important assertions are that it contains names and descriptions and *not*
 * bodies, and that a duplicate name resolves in a way the diagnostics can
 * explain.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverSkillRegistry } from '../../src/skills/registry.ts';

let base: string;
let project: string;
let agents: string;
let builtin: string;
let outside: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'eunoia-skills-'));
  project = join(base, 'project');
  agents = join(base, 'agents');
  builtin = join(base, 'builtin');
  outside = join(base, 'outside');
  await Promise.all([
    mkdir(project, { recursive: true }),
    mkdir(agents, { recursive: true }),
    mkdir(builtin, { recursive: true }),
    mkdir(outside, { recursive: true }),
  ]);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function writeSkill(
  root: string,
  directory: string,
  options: {
    readonly name?: string;
    readonly description?: string;
    readonly body?: string;
    readonly files?: Readonly<Record<string, string>>;
  } = {},
): Promise<void> {
  const skillDir = join(root, directory);
  await mkdir(skillDir, { recursive: true });
  const name = options.name ?? directory;
  const description = options.description ?? `${directory} 的描述，在相关请求时使用。`;
  await writeFile(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n${options.body ?? `# ${directory}\n\n步骤。\n`}`,
    'utf8',
  );
  for (const [path, content] of Object.entries(options.files ?? {})) {
    const full = join(skillDir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
}

function roots() {
  return [
    { dir: project, source: 'project' as const },
    { dir: agents, source: 'agents' as const },
    { dir: builtin, source: 'builtin' as const },
  ];
}

describe('discovery', () => {
  it('finds skills in precedence order and explains duplicates', async () => {
    await writeSkill(project, 'alpha', { body: '# project alpha\n' });
    await writeSkill(agents, 'alpha', { body: '# agents alpha\n' });
    await writeSkill(agents, 'beta', { body: '# beta\n' });
    await writeSkill(builtin, 'gamma', { body: '# gamma\n' });

    const registry = await discoverSkillRegistry(roots());
    expect(registry.list().map((skill) => skill.manifest.name)).toEqual(['alpha', 'beta', 'gamma']);
    expect(registry.get('alpha')?.source).toBe('project');
    expect(registry.get('beta')?.source).toBe('agents');
    expect(registry.get('gamma')?.source).toBe('builtin');

    const duplicate = registry
      .diagnostics()
      .find((entry) => entry.reason.includes('duplicate skill name'));
    expect(duplicate).toMatchObject({ source: 'agents', path: 'alpha' });
  });

  it('ignores a missing root rather than failing the server', async () => {
    await writeSkill(project, 'alpha');
    const registry = await discoverSkillRegistry([
      { dir: project, source: 'project' },
      { dir: join(base, 'does-not-exist'), source: 'agents' },
    ]);
    expect(registry.count()).toBe(1);
  });

  it('reports an invalid skill instead of silently dropping it', async () => {
    const skillDir = join(project, 'broken');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# no frontmatter\n', 'utf8');

    const registry = await discoverSkillRegistry(roots());
    expect(registry.count()).toBe(0);
    expect(registry.diagnostics()[0]?.reason).toContain('frontmatter');
  });

  it('refuses a symlinked skill directory with a diagnostic', async () => {
    await writeSkill(outside, 'outside-skill');
    await symlink(join(outside, 'outside-skill'), join(project, 'linked'));

    const registry = await discoverSkillRegistry(roots());
    expect(registry.count()).toBe(0);
    expect(registry.diagnostics().some((entry) => entry.reason.includes('symlink'))).toBe(true);
  });

  it('lists references and scripts without reading their contents into the index', async () => {
    await writeSkill(project, 'alpha', {
      body: 'BODY_SENTINEL',
      files: {
        'references/matrix.md': 'REFERENCE_SENTINEL',
        'scripts/check.sh': 'SCRIPT_SENTINEL',
        'assets/logo.png': 'binary',
        '.env': 'SECRET',
      },
    });

    const registry = await discoverSkillRegistry(roots());
    const skill = registry.get('alpha');
    expect(skill?.references).toEqual(['references/matrix.md']);
    expect(skill?.scripts).toEqual(['scripts/check.sh']);
    expect(skill?.assets).toEqual(['assets/logo.png']);

    const index = registry.indexBlock();
    expect(index).toContain('alpha');
    expect(index).not.toContain('BODY_SENTINEL');
    expect(index).not.toContain('REFERENCE_SENTINEL');
    expect(index).not.toContain('SCRIPT_SENTINEL');
  });

  it('loads a skill and reports the available names when one is unknown', async () => {
    await writeSkill(project, 'alpha', { body: 'BODY_SENTINEL' });
    const registry = await discoverSkillRegistry(roots());

    const loaded = registry.load('alpha');
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.skill.body).toContain('BODY_SENTINEL');

    const missing = registry.load('nope');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.available).toContain('alpha');
  });

  it('gives the whole set a stable version', async () => {
    await writeSkill(project, 'alpha');
    const first = await discoverSkillRegistry(roots());
    const second = await discoverSkillRegistry(roots());
    expect(first.version()).toBe(second.version());
    expect(first.version()).toMatch(/^[0-9a-f]{12}$/);
  });
});
