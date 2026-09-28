/**
 * The prompt document against the spec's requirements on it.
 *
 * The prompt is prose, and prose is checked by reading it — but a few things the
 * spec insists on are checkable, and those are what this file covers: the five
 * principles (§3) are all present, the four lenses (§2) each keep the boundary
 * that stops them being harmful, and safety outranks personality (§10).
 *
 * **Section-scoped, not global.** `expect(prompt).toContain('焦虑')` passes on a
 * prompt that mentions anxiety anywhere — including in an example that says to
 * allow it. The Ne lens is the thing that must not manufacture it, so the
 * assertion is made inside Ne's own section. That distinction is the difference
 * between a test that protects the boundary and one that decorates it.
 *
 * The requirements themselves live in `src/agent/prompt-contract.ts`. If a
 * heading here fails, the fix is usually the document, not this file.
 */

import { describe, expect, it } from 'vitest';
import {
  REQUIRED_HEURISTICS,
  REQUIRED_PRINCIPLES,
} from '../../src/agent/prompt-contract.ts';
import { STABLE_INSTRUCTIONS } from '../../src/agent/instructions.ts';

/**
 * The document, split into sections keyed by heading text.
 *
 * A section runs from its heading to the next heading of the same or higher
 * level, which is how the document is actually organised: `#` for the top-level
 * rules, `##` for the four lenses inside 四种视角.
 */
function sections(markdown: string): Map<string, string> {
  const found = new Map<string, string>();
  const lines = markdown.split('\n');
  let heading: string | null = null;
  let body: string[] = [];

  const flush = () => {
    if (heading !== null) found.set(heading, body.join('\n').trim());
  };

  for (const line of lines) {
    const match = /^(#{1,2}) (.+)$/.exec(line);
    if (match) {
      flush();
      heading = match[2] as string;
      body = [];
      continue;
    }
    body.push(line);
  }
  flush();
  return found;
}

const document = sections(STABLE_INSTRUCTIONS);

/** The section for a heading, or a failure that names what was missing. */
function section(heading: string): string {
  const body = document.get(heading);
  expect(body, `the prompt has no "${heading}" section`).toBeDefined();
  return body as string;
}

describe('the prompt document', () => {
  it('is markdown with the sections spec §11 asks for', () => {
    const required = [
      '身份',
      '核心使命',
      '行为原则',
      '四种视角',
      '记忆规则',
      '检索到的记忆',
      '对话规则',
      '安全规则',
      '工具规则',
      '示例',
    ];
    for (const heading of required) {
      expect(document.has(heading), `missing section: # ${heading}`).toBe(true);
    }
  });

  it('carries no section that is effectively empty', () => {
    // A heading with nothing under it reads to a model as a rule it was not
    // given, which is worse than no heading: it implies the rule exists.
    for (const [heading, body] of document) {
      expect(body.length, `# ${heading} is effectively empty`).toBeGreaterThan(50);
    }
  });

  it('holds no HTML comment, so the editor’s note is never sent', () => {
    // The document opens with a note to whoever edits it. It is stripped on load;
    // this is the assertion that the stripping still happens.
    expect(STABLE_INSTRUCTIONS).not.toContain('<!--');
    expect(STABLE_INSTRUCTIONS).not.toContain('-->');
  });
});

describe('the interaction principles (spec §3)', () => {
  it('states all five, in the spec’s order', () => {
    const body = section('行为原则');
    let cursor = -1;

    for (const [index, principle] of REQUIRED_PRINCIPLES.entries()) {
      const at = body.indexOf(`**${principle.label}**`);
      expect(at, `principle missing from the prompt: ${principle.id} (${principle.label})`)
        .toBeGreaterThan(-1);
      expect(at, `${principle.id} is out of order`).toBeGreaterThan(cursor);
      cursor = at;
      // Numbered, so it reads as one of a set rather than a list of remarks.
      expect(body).toContain(`${index + 1}. **${principle.label}**`);
    }
  });

  it('gives every principle a concrete "不要" line', () => {
    // The rule alone tells the model what to do; the avoid list is what makes it
    // checkable. Each of the five is followed by one before the next principle.
    const body = section('行为原则');
    const blocks = body.split(/\n\n(?=\d\. )/).slice(1);

    expect(blocks).toHaveLength(REQUIRED_PRINCIPLES.length);
    for (const block of blocks) {
      expect(block).toContain('不要：');
      expect(block.split('不要：')[1]?.trim().length ?? 0).toBeGreaterThan(4);
    }
  });
});

describe('the four lenses (spec §2)', () => {
  it('defines exactly Fi, Ne, Si, Te as lenses, not agents', () => {
    for (const heuristic of REQUIRED_HEURISTICS) {
      const body = section(heuristic.heading);
      expect(body, `${heuristic.id} does not ask its question`).toContain(heuristic.coreQuestion);
    }

    // The failure this guards is reification: four lenses read as four personas,
    // which is the multi-agent design ADR 001 rejects.
    expect(section('四种视角')).toContain('不是四个角色');
  });

  it('keeps each lens bounded by the failure mode the spec names', () => {
    for (const heuristic of REQUIRED_HEURISTICS) {
      const body = section(heuristic.heading);
      expect(body, `${heuristic.id} has no 边界 line`).toContain('边界：');
      for (const phrase of heuristic.mustMention) {
        expect(body, `${heuristic.id} lost the boundary "${phrase}"`).toContain(phrase);
      }
    }
  });

  it('names each lens in the script the spec uses, not a translation', () => {
    for (const heuristic of REQUIRED_HEURISTICS) {
      expect(STABLE_INSTRUCTIONS).toContain(`## ${heuristic.heading}`);
    }
  });
});

describe('safety (spec §10)', () => {
  it('says safety outranks the personality rules', () => {
    expect(section('安全规则')).toContain('安全永远优先于人格设定');
  });

  it('forbids storing a guess as a fact', () => {
    // The memory rules and the tool rules both have to say it: the model reads
    // one before it decides to save, and the other when it decides how to label.
    expect(section('记忆规则')).toContain('推测不是事实');
    expect(section('工具规则')).toContain('inferred');
  });
});
