/**
 * Write tools: the only two definitions that can change the working tree.
 *
 * Their side effect is declared as `workspace_write`, which the loop checks
 * against the process policy before `execute` runs. No approval logic lives
 * here: a tool that could approve itself is not a sandbox.
 *
 * `write_file` and `edit_file` are separate on purpose. A single "write" that
 * takes either a whole document or a patch makes the common case — replacing one
 * exact string — look like a full rewrite, and makes the model's mistake
 * (copying the file from memory) indistinguishable from its intent.
 */

import { z } from 'zod';
import { defineTool, toolOk } from '../types.ts';
import { guardToolResult, requireWorkspace } from './read-tools.ts';

export const writeFileTool = defineTool({
  name: 'write_file',
  description: '创建或整份覆盖一个文本文件；父目录不存在时会创建。覆盖已有文件之前先读，局部修改用 edit_file。',
  parameters: z.object({
    path: z.string().min(1).describe('要写入的路径；相对路径从工作区根目录算。'),
    content: z.string().describe('完整的文件内容。'),
  }),
  sideEffect: 'workspace_write',
  readOnly: false,
  guidelines: 'write_file：新建或整份重写；局部修改用 edit_file。',
  execute: async ({ path, content }, context) => {
    return guardToolResult(async () => {
      const workspace = requireWorkspace(context);
      const result = await workspace.writeText(path, content);
      return toolOk(
        `已${result.created ? '创建' : '写入'} ${result.path}（${result.bytes} 字节，${result.lines} 行）。`,
        {
          summary: `${result.created ? '创建' : '写入'} ${result.path}（${formatBytes(result.bytes)}）`,
          path: result.path,
          bytes: result.bytes,
          created: result.created,
        },
      );
    });
  },
});

export const editFileTool = defineTool({
  name: 'edit_file',
  description: '用精确字符串替换来编辑已有文件。old_string 必须与原文完全一致且在文件里唯一；要替换多处时设 replace_all。',
  parameters: z.object({
    path: z.string().min(1).describe('要编辑的路径；相对路径从工作区根目录算。'),
    old_string: z.string().min(1).describe('要被替换的字面文本。'),
    new_string: z.string().describe('替换后的文本；空字符串表示删除。'),
    replace_all: z
      .boolean()
      .optional()
      .describe('替换所有匹配，默认 false；为 false 时 old_string 必须只出现一次。'),
  }),
  sideEffect: 'workspace_write',
  readOnly: false,
  guidelines: 'edit_file：先读再改；old_string 要唯一，否则多带上下文或用 replace_all。',
  execute: async ({ path, old_string, new_string, replace_all }, context) => {
    return guardToolResult(async () => {
      const workspace = requireWorkspace(context);
      const result = await workspace.editText({
        path,
        oldString: old_string,
        newString: new_string,
        ...(replace_all === undefined ? {} : { replaceAll: replace_all }),
      });
      if (result.replacements === 0) {
        return toolOk(`${result.path} 没有变化（新内容与原文相同）。`, {
          summary: `${result.path} 无变化`,
          path: result.path,
          replacements: 0,
        });
      }
      return toolOk(`已修改 ${result.path}（替换 ${result.replacements} 处）。`, {
        summary: `修改 ${result.path}（${result.replacements} 处）`,
        path: result.path,
        replacements: result.replacements,
        bytes: result.bytes,
      });
    });
  },
});

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
