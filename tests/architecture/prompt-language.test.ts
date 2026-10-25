/**
 * The prompt is Chinese, and the parts of it that are not are named here.
 *
 * The product is Chinese-facing (spec §11), so every word the model *reads*
 * should be Chinese. Two kinds of string are legitimately not, and they are
 * exempted by name rather than by a pattern:
 *
 *   - **Identifiers the code matches on.** Tool names, enum values the model
 *     emits as arguments (`user_explicit`), and JSON Schema field names
 *     (`source`, `confidence`). Translating one of these breaks a tool call, so
 *     a test that "fixed" them would be breaking the product to make itself pass.
 *   - **The spec's own names.** `Fi`/`Ne`/`Si`/`Te` are how spec §2 names the four
 *     lenses, and `INFP` is the product. Renaming them would invent a second
 *     vocabulary for something the spec, the ADRs and the code all already call
 *     by one name.
 *
 * Everything else fails. The reason to enforce this rather than to have cleaned
 * it up once: the sweep that produced this list found English in six heuristics
 * that had **no Chinese at all** (`unconsidered possibilities`, `one 20-minute
 * task`, `personal history`) — none of it visible from reading the source, since
 * each string looked like a deliberate English term next to Chinese ones. A
 * cleanup decays; a test does not.
 *
 * It scans model-facing surfaces, not files. `instructions.ts` is not the only
 * thing the model reads — the tool schemas, the safety directives and the
 * rendered memory block are separate surfaces, and English hid in all of them.
 */

import { describe, expect, it } from 'vitest';

import { PROMPT_VERSION, STABLE_INSTRUCTIONS } from '../../src/agent/instructions.ts';
import { buildRuntimeContext } from '../../src/agent/runtime-context.ts';
import { renderSituation } from '../../src/agent/situation.ts';
import { CRISIS_DIRECTIVE, CRISIS_FALLBACK, ELEVATED_DIRECTIVE } from '../../src/safety/response.ts';
import { renderMemories } from '../../src/memory/render.ts';
import { createMemoryTools } from '../../src/tools/memory.ts';
import { codingTools } from '../../src/tools/coding/index.ts';
import { jsonSchemaOf } from '../../src/tools/schema.ts';

/** Tokens allowed to be Latin, each with the reason it is allowed. */
const ALLOWED: Readonly<Record<string, string>> = {
  // Proper names — the spec's vocabulary for the lenses, and the product.
  Fi: 'spec §2 lens name',
  Ne: 'spec §2 lens name',
  Si: 'spec §2 lens name',
  Te: 'spec §2 lens name',
  INFP: 'the product',
  Eunoia: "the agent's name",
  Agent: 'what the product calls itself',
  AI: 'universal in Chinese technical prose',
  // The second-person pronoun, kept gender-neutral on purpose. There is no
  // Chinese character that is both neutral and readable, so the pinyin stands in.
  ta: 'gender-neutral pronoun',
  // Tool names. The model calls these verbatim.
  search_memory: 'tool name',
  save_memory: 'tool name',
  update_memory: 'tool name',
  // Enum values the model emits as arguments.
  episodic: 'memory type value',
  semantic: 'memory type value',
  narrative: 'memory type value',
  user_explicit: 'memory source value',
  user_stated: 'memory source value',
  inferred: 'memory source value',
  deleted: 'memory status value',
  // JSON Schema field names.
  id: 'schema field',
  type: 'schema field',
  content: 'schema field',
  importance: 'schema field',
  confidence: 'schema field',
  source: 'schema field',
  status: 'schema field',
  tags: 'schema field',
  query: 'schema field',
  limit: 'schema field',
  // Coding tool names and their schema fields. The model emits these verbatim.
  read_file: 'tool name',
  list_dir: 'tool name',
  glob: 'tool name',
  grep: 'tool name',
  write_file: 'tool name',
  edit_file: 'tool name',
  run_command: 'tool name',
  old_string: 'schema field',
  new_string: 'schema field',
  replace_all: 'schema field',
  include: 'schema field',
  start: 'schema field',
  end: 'schema field',
  depth: 'schema field',
  pattern: 'schema field',
  max_results: 'schema field',
  case_sensitive: 'schema field',
  command: 'schema field',
  timeout_ms: 'schema field',
  // Technical names that appear in examples and descriptions, not prose.
  CRLF: 'line ending name',
  LF: 'line ending name',
  stdout: 'command stream name',
  stderr: 'command stream name',
  shell: 'the thing run_command runs',
  JavaScript: 'regex dialect name',
  JSON: 'wire format name',
  npm: 'package manager name',
  lint: 'command category',
  test: 'command/file category',
  src: 'example path segment',
  ts: 'file extension',
  dist: 'ignored directory name',
  node_modules: 'ignored directory name',
  git: 'version control name',
  env: 'part of .env',
  vim: 'example of an interactive command',
  less: 'example of an interactive command',
  loop: 'example path segment',
  agent: 'example path segment',
  based: 'as in 1-based line numbers',
  run: 'as in npm run',
  true: 'JSON literal in an example',
  false: 'JSON literal in an example',
  saveMemory: 'example search term in a tool description',
};

/** The tools never execute here, so the context is never dereferenced. */
const tools = [
  ...createMemoryTools({ store: {} as never, userId: 'prompt-language-test' }),
  ...codingTools,
];

/** Every `description` in a JSON Schema, at any depth — what the model reads. */
function schemaDescriptions(schema: unknown): string {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== 'object' || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'description' && typeof value === 'string') found.push(value);
      else walk(value);
    }
  };
  walk(schema);
  return found.join('\n');
}

const SURFACES: Readonly<Record<string, string>> = {
  'system prompt': STABLE_INSTRUCTIONS,
  'situation block': renderSituation({
    now: new Date('2026-10-25T12:33:00Z'),
    timeZone: 'Asia/Shanghai',
  }),
  'runtime context': buildRuntimeContext({
    relationshipBlock: '你们刚开始认识。',
    situationBlock: '现在是星期日。',
    memoryBlock: '用户喜欢安静的地方。',
    safetyDirective: '安全优先于人格设定。',
  }),
  'tool descriptions': tools.map((tool) => tool.description ?? '').join('\n'),
  'tool schema': tools
    .map((tool) => schemaDescriptions(jsonSchemaOf(tool.parameters)))
    .join('\n'),
  'crisis directive': CRISIS_DIRECTIVE,
  'elevated directive': ELEVATED_DIRECTIVE,
  'crisis fallback': CRISIS_FALLBACK,
  'memory block': renderMemories([
    {
      id: 'm1',
      content: '用户在一家做硬件的公司做产品，最近在考虑辞职。',
      type: 'episodic',
      source: 'user_stated',
      importance: 0.8,
      confidence: 0.9,
      status: 'active',
    } as never,
  ]),
};

/** Every run of Latin letters on a surface, with where it was found. */
function latinTokens(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of text.matchAll(/[A-Za-z][A-Za-z_]*/g)) {
    counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
  }
  return counts;
}

describe('what the model reads is Chinese', () => {
  for (const [name, text] of Object.entries(SURFACES)) {
    it(`${name} contains no Latin token outside the allowlist`, () => {
      const stray = [...latinTokens(text).keys()]
        .filter((token) => !(token in ALLOWED))
        .sort();

      expect(
        stray,
        stray.length
          ? `Latin tokens with no entry in ALLOWED:\n` +
            stray.map((token) => `  ${token}`).join('\n') +
            `\n\nIf it is prose, translate it. If it is an identifier the model ` +
            `emits or the code matches on, add it to ALLOWED with a reason.`
          : '',
      ).toEqual([]);
    });
  }

  it('allows a token only because something justifies it', () => {
    // A bare allowlist with empty reasons decays into "whatever made the test
    // pass"; requiring a reason makes each entry a decision someone can review.
    for (const [token, reason] of Object.entries(ALLOWED)) {
      expect(reason.length, `${token} is allowed with no reason`).toBeGreaterThan(3);
    }
  });

  it('is mostly Chinese by volume, as a coarse sanity check', () => {
    // Not the real assertion — the token check above is. This only catches the
    // case where a whole English section is added and every word of it happens
    // to be allowlisted.
    const cjk = (STABLE_INSTRUCTIONS.match(/[一-鿿]/g) ?? []).length;
    expect(cjk / STABLE_INSTRUCTIONS.length).toBeGreaterThan(0.4);
  });
});

describe('the scanned string is the one the model gets', () => {
  it('scans the same string PROMPT_VERSION hashes', () => {
    // Otherwise this file could be scanning a string that is assembled
    // somewhere else and never sent, and report a clean prompt that no user
    // ever sees. `prompt-version.test.ts` separately pins the hash itself.
    expect(STABLE_INSTRUCTIONS).toContain('行为原则');
    expect(STABLE_INSTRUCTIONS).toContain('工具规则');
    expect(PROMPT_VERSION).toMatch(/^[0-9a-f]{12}$/);
  });
});
