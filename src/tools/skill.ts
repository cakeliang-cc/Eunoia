/**
 * `load_skill`: the one tool the skill layer adds.
 *
 * A skill is not a tool, so it does not get one tool per skill. It gets one
 * loader: the index carries `name` + `description`, and this tool brings the
 * body into the conversation only when the model decides the skill is relevant.
 * That is progressive disclosure with the machinery the loop already has — a
 * tool result is appended to the next model step exactly like a file read.
 *
 * The tool never executes a script and never grants a permission. It reports
 * which tools a skill asks for, and which of those the *process* currently
 * allows; a mismatch is something the model must surface to the user, not route
 * around.
 */

import { join } from 'node:path';
import { z } from 'zod';
import type { SkillRegistry } from '../skills/registry.ts';
import type { Skill } from '../skills/types.ts';
import { log } from '../observability/logging.ts';
import { defineTool, toolError, toolOk } from './types.ts';
import type { ToolContext, ToolDefinition, ToolPolicy } from './types.ts';

export interface SkillToolOptions {
  /** Tool names the loop can actually offer, from the composed registry. */
  readonly availableTools: ReadonlySet<string>;
}

export function createSkillTools(
  registry: SkillRegistry,
  options: SkillToolOptions,
): readonly ToolDefinition[] {
  return [
    defineTool({
      name: 'load_skill',
      description: `加载一个技能的完整说明。

技能索引里只有名字和描述；当用户的请求匹配某个技能的描述时，用这个工具把它的步骤读进来，再按步骤做。

不要凭技能名猜流程，也不要把技能当成工具：技能是一段可重复的工作流程，里面的每一步仍然要用你真正拥有的工具完成。

技能声明的工具如果当前被关闭，会在这里明确写出来。遇到这种情况停下来告诉用户，不要绕过。`,
      parameters: z.object({
        name: z.string().min(1).describe('技能名，必须来自技能索引，例如 code-change-verification'),
      }),
      sideEffect: 'none',
      readOnly: true,
      timeoutMs: 10_000,
      guidelines: 'load_skill：请求匹配技能索引里的 description 时先加载，再照做；不要假装使用未加载的技能。',
      execute: async ({ name }, context) => {
        const loaded = registry.load(name);
        if (!loaded.ok) {
          return toolError(
            `${loaded.error}. Available: ${loaded.available.length > 0 ? loaded.available.join(', ') : '(none)'}`,
          );
        }

        const skill = loaded.skill;
        const missing = missingTools(skill, options.availableTools, context.policy);
        const text = formatSkill(skill, missing, context);

        log.info('skill.loaded', {
          skill: skill.manifest.name,
          source: skill.source,
          hash: skill.hash,
          missing_tools: missing.length,
        });

        return toolOk(text, {
          summary: `加载技能 ${skill.manifest.name}`,
          skill: skill.manifest.name,
          source: skill.source,
          hash: skill.hash,
          missing_tools: missing.map((entry) => entry.tool),
        });
      },
    }),
  ];
}

interface MissingTool {
  readonly tool: string;
  readonly reason: string;
}

function missingTools(
  skill: Skill,
  available: ReadonlySet<string>,
  policy: ToolPolicy,
): readonly MissingTool[] {
  const missing: MissingTool[] = [];
  for (const tool of skill.manifest.allowedTools) {
    if (!available.has(tool)) {
      missing.push({ tool, reason: '当前服务没有提供这个工具' });
      continue;
    }
    if (tool === 'run_command' && !policy.allowCommands) {
      missing.push({ tool, reason: '命令执行未开启（WORKSPACE_COMMANDS）' });
      continue;
    }
    if ((tool === 'write_file' || tool === 'edit_file') && !policy.allowWorkspaceWrites) {
      missing.push({ tool, reason: '文件写入未开启（WORKSPACE_WRITES）' });
    }
  }
  return missing;
}

function formatSkill(
  skill: Skill,
  missing: readonly MissingTool[],
  context: ToolContext,
): string {
  const lines: string[] = [
    `# 技能：${skill.manifest.name}`,
    `来源：${sourceLabel(skill.source)}`,
    `说明：${skill.manifest.description}`,
  ];
  if (skill.manifest.allowedTools.length > 0) {
    lines.push(`需要工具：${skill.manifest.allowedTools.join(', ')}`);
  }
  if (missing.length > 0) {
    lines.push(
      '## 当前不可用',
      '下面这些工具被当前服务的策略关掉了。按技能需要的步骤做之前，先告诉用户需要开启什么；不要绕过，也不要用别的工具模拟。',
      ...missing.map((entry) => `- ${entry.tool}：${entry.reason}`),
    );
  }

  lines.push('## 步骤', skill.body);

  const references = resourcePaths(skill, skill.references, context);
  if (references.length > 0) {
    lines.push(
      '## 参考资料（按需读取，不要一次全读）',
      ...references.map((entry) => `- ${entry}`),
    );
  }

  const scripts = resourcePaths(skill, skill.scripts, context);
  if (scripts.length > 0) {
    lines.push(
      '## 脚本（不会自动执行）',
      '需要时用 run_command 运行；不要先把脚本内容读进上下文，除非运行失败需要调试。',
      ...scripts.map((entry) => `- ${entry}`),
    );
  }

  const assets = resourcePaths(skill, skill.assets, context);
  if (assets.length > 0) {
    lines.push('## 资产', ...assets.map((entry) => `- ${entry}`));
  }

  return lines.join('\n');
}

/**
 * Turn resource paths into paths the model can actually pass to `read_file`.
 *
 * Project skills live under `WORKSPACE_ROOT`, so `references/x.md` becomes
 * `.eunoia/skills/name/references/x.md`. Built-in skills live beside the server,
 * outside the sandbox; listing them as readable would be a lie, so the label
 * says so.
 */
function resourcePaths(
  skill: Skill,
  entries: readonly string[],
  context: ToolContext,
): readonly string[] {
  return entries.map((entry) => {
    const absolute = join(skill.root, entry);
    if (!context.workspace) return `${entry}（没有工作目录，无法用 read_file 读取）`;
    const relativePath = context.workspace.relative(absolute);
    if (relativePath === '..' || relativePath.startsWith('../')) {
      return `${entry}（在 server 目录内，不在工作目录，无法用 read_file 读取）`;
    }
    return relativePath;
  });
}

function sourceLabel(source: Skill['source']): string {
  switch (source) {
    case 'project':
      return '项目 .eunoia/skills';
    case 'agents':
      return '兼容目录 .agents/skills';
    case 'builtin':
      return '内置';
  }
}
