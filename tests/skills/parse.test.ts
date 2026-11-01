/**
 * SKILL.md parsing.
 *
 * The frontmatter is routing metadata, so the failures worth pinning are the
 * ones that make a skill invisible or mis-triggered: a missing name, a
 * description that is too long for the index, an XML tag, or a body that has
 * quietly become a second prompt.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_BODY_CHARS,
  MAX_DESCRIPTION_CHARS,
  parseSkillDocument,
  SkillParseError,
} from '../../src/skills/parse.ts';

const VALID = `---
name: code-change-verification
description: 改动代码之后，按仓库顺序跑类型检查、lint 和测试；在全部通过前不要声称完成。
allowed-tools: [read_file, grep, run_command]
version: 1.0.0
license: MIT
metadata:
  owner: platform
---

# 验证

先读 package.json，再跑命令。
`;

describe('parseSkillDocument', () => {
  it('parses the standard frontmatter and body', () => {
    const parsed = parseSkillDocument(VALID, 'code-change-verification');
    expect(parsed.manifest).toMatchObject({
      name: 'code-change-verification',
      allowedTools: ['read_file', 'grep', 'run_command'],
      version: '1.0.0',
      license: 'MIT',
      metadata: { owner: 'platform' },
    });
    expect(parsed.manifest.description).toContain('类型检查');
    expect(parsed.body).toContain('先读 package.json');
    expect(parsed.body).not.toContain('---');
    expect(parsed.warnings).toEqual([]);
  });

  it('defaults the name to the directory when frontmatter omits it', () => {
    const parsed = parseSkillDocument(
      `---
description: 在准备发版时使用。
---
# body
`,
      'release-review',
    );
    expect(parsed.manifest.name).toBe('release-review');
  });

  it('warns when the advertised name does not match the directory', () => {
    const parsed = parseSkillDocument(
      `---
name: other-name
description: 做某件事。
---
# body
`,
      'directory-name',
    );
    expect(parsed.manifest.name).toBe('other-name');
    expect(parsed.warnings.join('\n')).toContain('does not match directory');
  });

  it('accepts a comma-separated allowed-tools string', () => {
    const parsed = parseSkillDocument(
      `---
description: 做某件事。
allowed-tools: read_file, grep, run_command
---
# body
`,
      'demo',
    );
    expect(parsed.manifest.allowedTools).toEqual(['read_file', 'grep', 'run_command']);
  });

  it('maps Claude tool spellings to this project\'s tool names', () => {
    const parsed = parseSkillDocument(
      `---
description: 做某件事。
allowed-tools: Read, Bash(git status *), Grep
---
# body
`,
      'demo',
    );
    expect(parsed.manifest.allowedTools).toEqual(['read_file', 'run_command', 'grep']);
  });

  it('collapses whitespace in the description, which is index text', () => {
    const parsed = parseSkillDocument(
      `---
description: >
  做某件事。   在用户说

  “做一下”时使用。
---
# body
`,
      'demo',
    );
    expect(parsed.manifest.description).toBe('做某件事。 在用户说 “做一下”时使用。');
  });

  it('refuses a document without frontmatter', () => {
    expect(() => parseSkillDocument('# just a body\n', 'demo')).toThrow(SkillParseError);
  });

  it('refuses an invalid name', () => {
    expect(() =>
      parseSkillDocument(`---\nname: Bad Name\ndescription: 做某件事。\n---\n# body\n`, 'Bad Name'),
    ).toThrow(/lowercase/);
  });

  it('refuses an over-long description', () => {
    const long = 'a'.repeat(MAX_DESCRIPTION_CHARS + 1);
    expect(() =>
      parseSkillDocument(`---\ndescription: ${long}\n---\n# body\n`, 'demo'),
    ).toThrow(/limit/);
  });

  it('refuses XML tags in the description', () => {
    expect(() =>
      parseSkillDocument(`---\ndescription: 用 <b>这个</b> 做某事。\n---\n# body\n`, 'demo'),
    ).toThrow(/XML/);
  });

  it('refuses an empty body', () => {
    expect(() =>
      parseSkillDocument(`---\ndescription: 做某件事。\n---\n\n`, 'demo'),
    ).toThrow(/no body/);
  });

  it('refuses a body that has become a second prompt', () => {
    const body = 'x'.repeat(MAX_BODY_CHARS + 1);
    expect(() =>
      parseSkillDocument(`---\ndescription: 做某件事。\n---\n${body}\n`, 'demo'),
    ).toThrow(/limit/);
  });

  it('warns above the recommended body size without refusing it', () => {
    const body = 'x'.repeat(25_000);
    const parsed = parseSkillDocument(`---\ndescription: 做某件事。\n---\n${body}\n`, 'demo');
    expect(parsed.warnings.join('\n')).toContain('recommended limit');
  });
});
