/**
 * Skill discovery and the per-turn index.
 *
 * Discovery is explicit about precedence: project skills in `.eunoia/skills`
 * beat compatible skills in `.agents/skills`, which beat the built-ins shipped
 * with the server. A duplicate name is a diagnostic, not a silent last-one-wins
 * — "which version of this workflow ran?" has to be answerable from a log.
 *
 * Discovery reads `SKILL.md` (to validate it) but the context only ever receives
 * `name` + `description`. The body is loaded by `load_skill`, which is the whole
 * point of progressive disclosure: a repository with twenty skills should not
 * pay for twenty bodies on every turn.
 *
 * See docs/adr/015-skills.md.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { parseSkillDocument, SkillParseError } from './parse.ts';
import type {
  Skill,
  SkillDiagnostic,
  SkillIndexEntry,
  SkillLoadResult,
  SkillSource,
} from './types.ts';

export interface SkillRoot {
  readonly dir: string;
  readonly source: SkillSource;
}

export interface SkillDiscoveryOptions {
  /** Hard cap on discovered skills. Twenty is already a lot of index text. */
  readonly maxSkills?: number;
  /** Cap on files listed per resource directory. */
  readonly maxResources?: number;
}

const MAX_INDEX_SKILLS = 30;
const MAX_INDEX_DESCRIPTION_CHARS = 300;

const SENSITIVE_NAMES: ReadonlySet<string> = new Set([
  '.env',
  '.npmrc',
  '.pypirc',
  'id_rsa',
  'id_ed25519',
  'credentials.json',
  'secrets.json',
]);

export class SkillRegistry {
  private readonly byName: ReadonlyMap<string, Skill>;
  private readonly diagnosticsList: readonly SkillDiagnostic[];
  private readonly all: readonly Skill[];

  constructor(skills: readonly Skill[], diagnostics: readonly SkillDiagnostic[] = []) {
    const map = new Map<string, Skill>();
    for (const skill of skills) {
      if (!map.has(skill.manifest.name)) map.set(skill.manifest.name, skill);
    }
    this.byName = map;
    this.all = [...map.values()].sort((left, right) =>
      left.manifest.name.localeCompare(right.manifest.name),
    );
    this.diagnosticsList = diagnostics;
  }

  list(): readonly Skill[] {
    return this.all;
  }

  get(name: string): Skill | undefined {
    return this.byName.get(name.trim());
  }

  load(name: string): SkillLoadResult {
    const skill = this.get(name);
    if (!skill) {
      return {
        ok: false,
        error: `unknown skill ${JSON.stringify(name)}`,
        available: this.all.map((entry) => entry.manifest.name),
      };
    }
    return { ok: true, skill };
  }

  diagnostics(): readonly SkillDiagnostic[] {
    return this.diagnosticsList;
  }

  count(): number {
    return this.all.length;
  }

  /**
   * A short identity for the whole skill set.
   *
   * Recorded with a run so "results changed" can be separated from "the
   * procedure changed" the same way `PROMPT_VERSION` does for the prompt.
   */
  version(): string {
    if (this.all.length === 0) return '';
    const material = this.all
      .map((skill) => `${skill.manifest.name}:${skill.hash}`)
      .join('\n');
    return createHash('sha256').update(material).digest('hex').slice(0, 12);
  }

  /**
   * The per-turn index.
   *
   * Descriptions are clipped to keep a large skill directory from becoming a
   * second system prompt; the full description is still in `SKILL.md`, and the
   * model can see it by loading the skill.
   */
  indexBlock(): string {
    if (this.all.length === 0) return '';
    const shown = this.all.slice(0, MAX_INDEX_SKILLS);
    const lines = shown.map((skill) => {
      const description = clip(skill.manifest.description, MAX_INDEX_DESCRIPTION_CHARS);
      return `- ${skill.manifest.name}（${sourceLabel(skill.source)}）— ${description}`;
    });
    if (this.all.length > shown.length) {
      lines.push(`… 还有 ${this.all.length - shown.length} 个技能未列出；用 load_skill 前先确认名字。`);
    }
    return [
      '# 可用技能',
      '以下是技能索引，不是完整说明。当用户请求匹配某个 description 时，先调用 load_skill 读取完整步骤；不要凭名字猜流程。',
      '',
      ...lines,
    ].join('\n');
  }

  /** For `/api/skills`; bodies are deliberately omitted. */
  toJSON(): readonly SkillIndexEntry[] {
    return this.all.map((skill) => ({
      name: skill.manifest.name,
      description: skill.manifest.description,
      source: skill.source,
    }));
  }
}

/**
 * Discover skills from roots in precedence order.
 *
 * A missing root is normal: most repositories have no `.agents/skills`. An
 * existing root with an invalid skill is a diagnostic, because silently
 * skipping it means the author sees a skill that never loads and no reason why.
 */
export async function discoverSkillRegistry(
  roots: readonly SkillRoot[],
  options: SkillDiscoveryOptions = {},
): Promise<SkillRegistry> {
  const maxSkills = options.maxSkills ?? 50;
  const maxResources = options.maxResources ?? 100;
  const skills: Skill[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  const byName = new Set<string>();

  for (const root of roots) {
    const realRoot = await realpath(root.dir).catch(() => null);
    if (!realRoot) continue;
    const rootInfo = await stat(realRoot).catch(() => null);
    if (!rootInfo?.isDirectory()) {
      diagnostics.push({ source: root.source, path: root.dir, reason: 'not a directory' });
      continue;
    }

    let entries;
    try {
      entries = await readdir(realRoot, { withFileTypes: true });
    } catch (error) {
      diagnostics.push({
        source: root.source,
        path: root.dir,
        reason: `could not read directory: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (skills.length >= maxSkills) {
        diagnostics.push({
          source: root.source,
          path: root.dir,
          reason: `stopped after ${maxSkills} skills`,
        });
        break;
      }
      if (entry.isSymbolicLink()) {
        diagnostics.push({
          source: root.source,
          path: entry.name,
          reason: 'skill directory is a symlink; ignored',
        });
        continue;
      }
      if (!entry.isDirectory()) continue;

      const directory = join(realRoot, entry.name);
      const realDirectory = await realpath(directory).catch(() => null);
      if (!realDirectory || !isInside(realRoot, realDirectory)) {
        diagnostics.push({
          source: root.source,
          path: entry.name,
          reason: 'skill directory escapes its root',
        });
        continue;
      }

      const entryFile = join(realDirectory, 'SKILL.md');
      const raw = await readFile(entryFile, 'utf8').catch((error: unknown) => {
        diagnostics.push({
          source: root.source,
          path: entry.name,
          reason:
            (error as NodeJS.ErrnoException).code === 'ENOENT'
              ? 'missing SKILL.md'
              : `could not read SKILL.md: ${error instanceof Error ? error.message : String(error)}`,
        });
        return null;
      });
      if (raw === null) continue;

      let parsed;
      try {
        parsed = parseSkillDocument(raw, entry.name);
      } catch (error) {
        diagnostics.push({
          source: root.source,
          path: entry.name,
          reason:
            error instanceof SkillParseError
              ? error.message
              : `could not parse SKILL.md: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }

      for (const warning of parsed.warnings) {
        diagnostics.push({ source: root.source, path: entry.name, reason: warning });
      }

      if (byName.has(parsed.manifest.name)) {
        diagnostics.push({
          source: root.source,
          path: entry.name,
          reason: `duplicate skill name ${JSON.stringify(parsed.manifest.name)}; kept the higher-precedence one`,
        });
        continue;
      }

      const resources = await Promise.all([
        listResources(realDirectory, 'references', maxResources),
        listResources(realDirectory, 'scripts', maxResources),
        listResources(realDirectory, 'assets', maxResources),
      ]);

      byName.add(parsed.manifest.name);
      skills.push({
        manifest: parsed.manifest,
        root: realDirectory,
        entry: entryFile,
        body: parsed.body,
        source: root.source,
        hash: createHash('sha256').update(raw).digest('hex').slice(0, 12),
        references: resources[0],
        scripts: resources[1],
        assets: resources[2],
      });
    }
  }

  return new SkillRegistry(skills, diagnostics);
}

function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root + sep);
}

async function listResources(
  skillRoot: string,
  directory: string,
  limit: number,
): Promise<readonly string[]> {
  const base = join(skillRoot, directory);
  const info = await stat(base).catch(() => null);
  if (!info?.isDirectory()) return [];

  const found: string[] = [];
  const walk = async (absolute: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 3 || found.length >= limit) return;
    const entries = await readdir(absolute, { withFileTypes: true }).catch(() => null);
    if (!entries) return;
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (found.length >= limit) return;
      if (isSensitiveName(entry.name)) continue;
      const rel = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(join(absolute, entry.name), rel, depth + 1);
      } else if (entry.isFile()) {
        found.push(rel);
      }
    }
  };

  await walk(base, directory, 0);
  return found;
}

function isSensitiveName(name: string): boolean {
  if (name === '.env.example' || name === '.env.sample') return false;
  if (name === '.env' || name.startsWith('.env.')) return true;
  if (SENSITIVE_NAMES.has(name)) return true;
  return ['.pem', '.key', '.p12', '.pfx'].some((suffix) => name.endsWith(suffix));
}

function sourceLabel(source: SkillSource): string {
  switch (source) {
    case 'project':
      return '项目';
    case 'agents':
      return '兼容目录';
    case 'builtin':
      return '内置';
  }
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}
