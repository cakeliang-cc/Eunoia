/**
 * The prompt is a document, and the module that loads it holds no prose.
 *
 * The standing system prompt lives in `src/agent/prompts/companion.md` and is
 * read at startup. The reason is not tidiness: the prompt is the product's
 * behaviour, it is edited far more often than the code around it, and it should
 * be editable by someone who does not want to open a module that also hashes,
 * caches and versions it.
 *
 * That is easy to lose by accident — a section pasted back into the loader
 * because it was "easier to interpolate", a fallback string kept "just in case
 * the file is missing" — and each of those recreates the two-copies problem this
 * structure removed. So the loader's emptiness is checked.
 *
 * ## What deliberately stays in code
 *
 * - **Tool descriptions** (`src/tools/memory.ts`, `src/tools/coding/`).
 *   They sit next to the schema they describe, and the SDK reads them from it. A
 *   lookup table would put a tool's description somewhere other than the tool.
 * - **The per-turn safety directives** (`src/safety/response.ts`). These are
 *   selected by a branch, and they are read together with the checks that verify
 *   the model complied with them; editing the wording without the check is the
 *   real hazard here, and one file makes that harder to do. Safety text that
 *   fails to load is also the one load failure worth designing out entirely.
 * - **Labels and reasons** keyed by an enum, which are data matched by code.
 *
 * The line is "the standing prompt" rather than "anything the model reads",
 * because the second would be a rule about a boundary no one is trying to cross.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROJECT_ROOT } from '../helpers/sources.ts';

const PROMPT_DOCUMENT = join(PROJECT_ROOT, 'src', 'agent', 'prompts', 'companion.md');
const LOADER = join(PROJECT_ROOT, 'src', 'agent', 'instructions.ts');
const CONTRACT = join(PROJECT_ROOT, 'src', 'agent', 'prompt-contract.ts');

const CJK = /[一-鿿]/;

/** Comments are prose for people, and they are allowed to be Chinese. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

/** Code lines carrying Chinese, with their line numbers. */
function chineseCodeLines(source: string): { number: number; line: string }[] {
  return withoutComments(source)
    .split('\n')
    .map((line, index) => ({ number: index + 1, line }))
    .filter(({ line }) => CJK.test(line));
}

describe('the prompt document', () => {
  it('exists, and is the whole standing prompt', async () => {
    const document = await readFile(PROMPT_DOCUMENT, 'utf8');
    expect(document.length).toBeGreaterThan(2000);
    for (const heading of ['# 身份', '# 行为原则', '# 四种视角', '# 工具规则']) {
      expect(document).toContain(heading);
    }
  });
});

describe('the loader', () => {
  it('carries no prompt text of its own', async () => {
    const offenders = chineseCodeLines(await readFile(LOADER, 'utf8'));
    // Anything here is either prose that belongs in the document or a user-facing
    // string that belongs in another layer. Neither belongs in the loader.
    expect(
      offenders.map(({ number, line }) => `instructions.ts:${number} (${line.trim()})`),
    ).toEqual([]);
  });

  it('would catch a section moved back into the code', () => {
    // A guard that cannot fail is not a guard. If someone pastes the identity
    // section into the loader, this is the shape of what the check above sees.
    const synthetic = 'export const IDENTITY = `# 身份\\n\\n你是一个长期陪伴型的 AI 伙伴。`;';
    expect(chineseCodeLines(synthetic)).toHaveLength(1);
    expect(chineseCodeLines('// 这里是注释，允许中文\nexport const x = 1;')).toEqual([]);
  });
});

describe('the contract', () => {
  it('holds names, not rules', async () => {
    // The file exists so a test can check the document against the spec. The
    // moment a rule's prose lives there too, there are two copies of it again —
    // which is the thing this structure was built to remove.
    const source = await readFile(CONTRACT, 'utf8');

    // The exact check: the fields that used to hold the policy are gone.
    for (const field of ['rule', 'boundary', 'attendTo', 'avoid']) {
      expect(source, `prompt-contract.ts has grown a "${field}" field again`).not.toMatch(
        new RegExp(`\\b${field}\\s*:`),
      );
    }

    // And the fuzzy one: a label is a few characters, a rule is a sentence. The
    // longest unbroken run of Chinese on a line is a proxy for that, and a proxy
    // is all it claims to be — the structural check above is the real one.
    for (const { number, line } of chineseCodeLines(source)) {
      const longestRun = Math.max(0, ...(line.match(/[一-鿿]+/g) ?? []).map((r) => r.length));
      expect(longestRun, `prompt-contract.ts:${number} looks like prose: ${line.trim()}`)
        .toBeLessThan(20);
    }
  });
});
