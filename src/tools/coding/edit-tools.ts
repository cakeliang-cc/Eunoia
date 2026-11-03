/**
 * Write tools: the only two definitions that can change the working tree.
 *
 * Their side effect is declared as `workspace_write`, which the loop checks
 * against the process policy before `execute` runs. No approval logic lives
 * here: a tool that could approve itself is not a sandbox.
 *
 * `write` and `edit` are separate on purpose. A single "write" that takes
 * either a whole document or a patch makes the common case — replacing one exact
 * string — look like a full rewrite, and makes the model's mistake (copying the
 * file from memory) indistinguishable from its intent.
 */

import { z } from 'zod';
import { defineTool, toolError, toolOk } from '../types.ts';
import { guardToolResult, requireWorkspace } from './read-tools.ts';

export const writeFileTool = defineTool({
  name: 'write',
  description: 'Create or fully replace a UTF-8 text file.',
  parameters: z.object({
    file_path: z.string().min(1).describe('Path to write, relative to the workspace root.'),
    content: z.string().describe('Full UTF-8 text content to write.'),
  }),
  sideEffect: 'workspace_write',
  readOnly: false,
  guidelines: 'Read the whole file before overwriting it with write; prefer edit for targeted changes.',
  execute: async ({ file_path, content }, context) => {
    return guardToolResult(async () => {
      const workspace = requireWorkspace(context);
      // Overwriting a file the model has never read is how a "small change"
      // becomes a lost document. A new path is a create and needs no read; an
      // existing one needs a complete read of the version still on disk.
      const target = await workspace.stat(file_path);
      if (target && !context.ledger.hasComplete(target.path, target)) {
        return toolError(
          `refusing to overwrite ${target.path}: read the whole file first, then write it. ` +
            'For a targeted change, use edit with the exact old_string instead.',
        );
      }
      const result = await workspace.writeText(file_path, content);
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
  name: 'edit',
  description: 'Edit an existing UTF-8 text file by replacing literal text.',
  parameters: z.object({
    file_path: z.string().min(1).describe('Path to edit, relative to the workspace root.'),
    old_string: z.string().min(1).describe('Literal text to replace.'),
    new_string: z.string().describe('Literal replacement text. Use an empty string to delete.'),
    replace_all: z
      .boolean()
      .optional()
      .describe('Replace all matches. Defaults to false; when false, old_string must appear exactly once.'),
  }),
  sideEffect: 'workspace_write',
  readOnly: false,
  guidelines: 'Read before editing; keep old_string unique or use replace_all.',
  execute: async ({ file_path, old_string, new_string, replace_all }, context) => {
    return guardToolResult(async () => {
      const workspace = requireWorkspace(context);
      const result = await workspace.editText({
        path: file_path,
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
