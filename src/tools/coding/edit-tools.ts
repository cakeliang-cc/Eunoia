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
  description: `写入一整份文件，覆盖原内容。父目录不存在时会创建。

什么时候调用：
- 新建一个文件；
- 全文替换一个你已经完整读过、并且确实需要整体重写的文件。

对已有文件做局部修改时优先用 edit_file：整份重写更容易把没读到的内容弄丢，也会让差异难以审阅。

文件路径必须留在工作目录内。不要写 .env 或密钥文件。`,
  parameters: z.object({
    path: z.string().min(1).describe('工作目录内的相对路径'),
    content: z.string().describe('完整的新内容'),
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
  description: `把文件里的一个精确字符串替换成另一个。

什么时候调用：
- 修改已有代码的最小改动；
- 重命名、调整一段逻辑、修一行错误。

规则：
- old_string 必须与文件里的内容完全一致（包括缩进），并且在文件里唯一；如果不唯一，多带几行上下文，或者设 replace_all=true。
- 改之前先用 read_file 确认原文，不要凭记忆写 old_string。
- old_string 不能为空；new_string 可以为空（表示删除）。

换行符（CRLF/LF）会按原文件保留；匹配失败时会明确告诉你没找到，而不是静默什么都不做。`,
  parameters: z.object({
    path: z.string().min(1).describe('工作目录内的相对路径'),
    old_string: z.string().min(1).describe('要替换的原文，必须精确且唯一'),
    new_string: z.string().describe('替换成的内容；空字符串表示删除'),
    replace_all: z.boolean().optional().describe('是否替换所有匹配，默认 false'),
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
