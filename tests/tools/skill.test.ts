/**
 * `skill` through its real execute path.
 *
 * The tool is the whole mechanism's load-bearing piece: it must return the body
 * (so the next model step has the procedure), list resources as paths the model
 * can actually read, and report permission mismatches instead of pretending the
 * skill is fully usable.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSkillTools } from '../../src/tools/skill.ts';
import { SkillRegistry } from '../../src/skills/registry.ts';
import type { Skill } from '../../src/skills/types.ts';
import { Workspace } from '../../src/tools/workspace.ts';
import { TurnReadLedger } from '../../src/tools/ledger.ts';
import { DEFAULT_TOOL_POLICY } from '../../src/tools/types.ts';
import type { ToolContext } from '../../src/tools/types.ts';

let root: string;
let workspace: Workspace;
let context: ToolContext;
let skill: Skill;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'eunoia-skill-tool-'));
  workspace = new Workspace({ root });
  context = {
    workspace,
    policy: { ...DEFAULT_TOOL_POLICY },
    ledger: new TurnReadLedger(),
    now: new Date('2026-10-25T12:00:00Z'),
  };
  skill = {
    manifest: {
      name: 'code-change-verification',
      description: '改动代码之后，按仓库顺序跑检查。',
      allowedTools: ['read', 'bash', 'write'],
      metadata: {},
    },
    root: join(workspace.root, 'skills', 'code-change-verification'),
    entry: join(workspace.root, 'skills', 'code-change-verification', 'SKILL.md'),
    body: '# 验证\n\n先读 package.json，再跑命令。',
    source: 'project',
    hash: 'abc123',
    references: ['references/matrix.md'],
    scripts: ['scripts/check.sh'],
    assets: [],
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('skill', () => {
  it('returns the body and the resource paths, and names permission gaps', async () => {
    const [tool] = createSkillTools(new SkillRegistry([skill]), {
      availableTools: new Set(['read', 'bash']),
    });
    expect(tool).toBeDefined();
    expect(tool?.readOnly).toBe(true);
    expect(tool?.sideEffect).toBe('none');

    const result = await tool!.execute({ name: 'code-change-verification' }, context);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('# 技能：code-change-verification');
    expect(result.output).toContain('先读 package.json');
    expect(result.output).toContain('skills/code-change-verification/references/matrix.md');
    expect(result.output).toContain('skills/code-change-verification/scripts/check.sh');
    expect(result.output).toContain('WORKSPACE_COMMANDS');
    expect(result.output).toContain('当前服务没有提供这个工具');
    expect(result.meta?.summary).toBe('加载技能 code-change-verification');
    expect(result.meta?.skill).toBe('code-change-verification');
  });

  it('reports the available names when the skill is unknown', async () => {
    const [tool] = createSkillTools(new SkillRegistry([skill]), { availableTools: new Set() });
    const result = await tool!.execute({ name: 'nope' }, context);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('unknown skill');
    expect(result.error).toContain('code-change-verification');
  });

  it('does not claim a builtin resource is readable when it is outside the workspace', async () => {
    const builtin: Skill = {
      ...skill,
      source: 'builtin',
      root: join(workspace.root, '..', 'builtin-skill'),
      references: ['references/guide.md'],
    };
    const [tool] = createSkillTools(new SkillRegistry([builtin]), { availableTools: new Set() });
    const result = await tool!.execute({ name: 'code-change-verification' }, context);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('不在工作目录');
  });
});
