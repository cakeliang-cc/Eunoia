/**
 * `SKILL.md` parsing.
 *
 * The format is the Agent Skills one: YAML frontmatter, then a Markdown body.
 * The frontmatter is the routing contract — `name` and `description` are what
 * the model sees before deciding to load anything else — so it is validated
 * eagerly and with messages an author can act on.
 *
 * Two limits exist for context safety, not taste:
 *
 * - `description` is capped at the standard's 1024 characters because every
 *   description is in the per-turn index;
 * - the body is capped well above the recommended 5k tokens, but still capped,
 *   because `load_skill` puts the whole body into one tool result. A skill that
 *   needs more should move the detail into `references/`.
 */

import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import type { SkillManifest } from './types.ts';

export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MAX_DESCRIPTION_CHARS = 1_024;
export const MAX_BODY_CHARS = 60_000;
export const RECOMMENDED_BODY_CHARS = 20_000;

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

const manifestSchema = z.looseObject({
  name: z.string().optional(),
  description: z.string(),
  'allowed-tools': z.union([z.string(), z.array(z.string())]).optional(),
  version: z.string().optional(),
  license: z.string().optional(),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

export class SkillParseError extends Error {
  override readonly name = 'SkillParseError';
}

export interface ParsedSkill {
  readonly manifest: SkillManifest;
  readonly body: string;
  /** Non-fatal authoring problems, shown by the registry's diagnostics. */
  readonly warnings: readonly string[];
}

/**
 * Parse one document.
 *
 * `fallbackName` is the directory name, used when the frontmatter omits `name` —
 * the open standard requires it, Claude Code defaults it. Accepting the fallback
 * costs nothing and makes a hand-written skill usable without a second failure.
 */
export function parseSkillDocument(raw: string, fallbackName: string): ParsedSkill {
  const source = raw.replace(/^\uFEFF/, '');
  const match = FRONTMATTER.exec(source);
  if (!match) {
    throw new SkillParseError('SKILL.md must start with YAML frontmatter delimited by ---');
  }

  let data: unknown;
  try {
    data = parseYaml(match[1] ?? '');
  } catch (error) {
    throw new SkillParseError(
      `frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = manifestSchema.safeParse(data);
  if (!parsed.success) {
    throw new SkillParseError(
      parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(frontmatter)'}: ${issue.message}`)
        .join('; '),
    );
  }

  const warnings: string[] = [];
  const name = (parsed.data.name?.trim() || fallbackName).trim();
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new SkillParseError(
      `name must be lowercase letters, numbers and hyphens (max 64), got ${JSON.stringify(name)}`,
    );
  }

  const description = parsed.data.description.replace(/\s+/g, ' ').trim();
  if (description.length === 0) {
    throw new SkillParseError('description must not be empty');
  }
  if (description.length > MAX_DESCRIPTION_CHARS) {
    throw new SkillParseError(
      `description is ${description.length} characters; the limit is ${MAX_DESCRIPTION_CHARS}`,
    );
  }
  if (/<[A-Za-z][^>]*>/.test(description)) {
    throw new SkillParseError('description must not contain XML tags');
  }
  if (parsed.data.name && parsed.data.name.trim() !== fallbackName) {
    warnings.push(`name ${JSON.stringify(name)} does not match directory ${JSON.stringify(fallbackName)}`);
  }

  const allowedTools = parseAllowedTools(parsed.data['allowed-tools']);
  const body = source.slice((match.index ?? 0) + match[0].length).trim();
  if (body.length === 0) {
    throw new SkillParseError('SKILL.md has no body; the frontmatter alone is not instructions');
  }
  if (body.length > MAX_BODY_CHARS) {
    throw new SkillParseError(
      `body is ${body.length} characters; the limit is ${MAX_BODY_CHARS}. Move detail into references/.`,
    );
  }
  if (body.length > RECOMMENDED_BODY_CHARS) {
    warnings.push(
      `body is ${body.length} characters; the recommended limit is ${RECOMMENDED_BODY_CHARS}. Move detail into references/.`,
    );
  }

  return {
    manifest: {
      name,
      description,
      allowedTools,
      ...(parsed.data.version ? { version: parsed.data.version } : {}),
      ...(parsed.data.license ? { license: parsed.data.license } : {}),
      metadata: normalizeMetadata(parsed.data.metadata),
    },
    body,
    warnings,
  };
}

/**
 * Claude Code spells its tools `Read`, `Bash`, `Grep`; ours are lowercase and
 * use different nouns. Mapping the common aliases lets a skill written for
 * Claude be dropped into `.eunoia/skills` without a silent "tool not available"
 * warning. The mapping is advisory only — it never grants a permission.
 */
const TOOL_ALIASES: Readonly<Record<string, string>> = {
  Read: 'read_file',
  Write: 'write_file',
  Edit: 'edit_file',
  MultiEdit: 'edit_file',
  Grep: 'grep',
  Glob: 'glob',
  LS: 'list_dir',
  Bash: 'run_command',
  Shell: 'run_command',
};

function parseAllowedTools(value: string | readonly string[] | undefined): readonly string[] {
  if (value === undefined) return [];
  const raw = typeof value === 'string' ? value.split(',') : value;
  const seen = new Set<string>();
  for (const entry of raw) {
    const rawName = String(entry).trim();
    if (rawName.length === 0) continue;
    // `Bash(git status *)` names a tool plus a pattern; the pattern is a Claude
    // permission detail, not something this project can enforce, so keep the
    // tool name and let the process policy decide.
    const base = rawName.split('(')[0]?.trim() ?? rawName;
    seen.add(TOOL_ALIASES[base] ?? base);
  }
  return [...seen];
}

function normalizeMetadata(
  value: Record<string, string | number | boolean> | undefined,
): Readonly<Record<string, string>> {
  if (!value) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = String(entry);
  return out;
}
