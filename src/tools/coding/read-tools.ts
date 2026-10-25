/**
 * Read-only coding tools: what the agent looks with.
 *
 * All four are `none` side effect and `readOnly`, so they run concurrently and
 * need no approval. The descriptions spend their length on *when* to call, not
 * on what the schema already says: a tool whose description only restates its
 * parameters gets called at the wrong moments.
 */

import { z } from 'zod';
import { defineTool, toolError, toolOk, type ToolContext, type ToolResult } from '../types.ts';
import { truncateHead } from '../truncate.ts';
import { WorkspaceError } from '../workspace.ts';

const PATH = z.string().min(1).describe('工作目录内的相对路径，例如 src/agent/loop.ts');
const MAX_READ_LINES = 2_000;
const MAX_READ_CHARS = 50_000;

export const readFileTool = defineTool({
  name: 'read_file',
  description: `读取工作目录里的一个文本文件，返回带行号的内容。

什么时候调用：
- 修改文件之前（必须先读到原文，不要凭记忆改）；
- 需要确认某个定义、导入或错误信息的具体写法；
- 用户点名要你看某个文件。

大文件用 start/end 读一段，不要一次读完整份。同一个文件、同一段已经在本轮读过时，会收到一条指针而不是重复内容——那说明内容就在上文，往上翻即可。

不要用它列目录（用 list_dir）或找内容（用 grep）。`,
  parameters: z.object({
    path: PATH,
    start: z.number().int().min(1).optional().describe('起始行，1-based，默认 1'),
    end: z.number().int().min(1).optional().describe('结束行，1-based，含这一行'),
  }),
  sideEffect: 'none',
  readOnly: true,
  guidelines: 'read_file：改之前先读；大文件用 start/end。',
  execute: async ({ path, start, end }, context) => {
    return guardToolResult(async () => {
      const workspace = requireWorkspace(context);
      const slice = await workspace.readLines(path, start ?? 1, end ?? 0);

      const hit = context.ledger.check({
        path: slice.path,
        start: slice.start,
        end: slice.end,
        mtimeMs: slice.mtimeMs,
        size: slice.size,
      });
      if (hit) {
        return toolOk(
          `# ${slice.path} 第 ${hit.start}-${hit.end} 行已经在本次对话的上文里（文件未改动），不再重复发送。向上翻到那次读取的结果即可。`,
          { summary: `已在上下文中：${slice.path}:${hit.start}-${hit.end}`, ledgerHit: true },
        );
      }

      const kept = truncateHead(slice.text.split('\n'), MAX_READ_LINES, MAX_READ_CHARS);
      const deliveredStart = slice.start + kept.first - 1;
      const deliveredEnd = slice.start + kept.last - 1;
      const complete = slice.complete && !kept.truncated;

      context.ledger.record({
        path: slice.path,
        start: deliveredStart,
        end: deliveredEnd,
        complete,
        chars: slice.chars,
        mtimeMs: slice.mtimeMs,
        size: slice.size,
      });

      const trailer = kept.truncated
        ? `\n… [只显示了第 ${deliveredStart}-${deliveredEnd} 行，共 ${slice.totalLines} 行；继续用 start=${deliveredEnd + 1} 读]`
        : '';
      return toolOk(`${kept.text}${trailer}`, {
        summary: `读取 ${slice.path}:${deliveredStart}-${deliveredEnd}${complete ? '（整份）' : ''}`,
        truncated: kept.truncated,
        read: {
          path: slice.path,
          start: deliveredStart,
          end: deliveredEnd,
          complete,
          chars: slice.chars,
          mtimeMs: slice.mtimeMs,
          size: slice.size,
        },
      });
    });
  },
});

export const listDirTool = defineTool({
  name: 'list_dir',
  description: `列出一个目录的结构，默认两层，最多四层。

什么时候调用：
- 刚开始一个任务，需要知道项目怎么组织；
- 猜不到文件在哪一层；
- 需要确认某个目录是否存在。

不要用它读文件内容（用 read_file），也不要用它找某个符号（用 grep）。结果超过 500 项会截断，路径窄一点再列。`,
  parameters: z.object({
    path: z.string().optional().describe('目录路径，默认工作目录根'),
    depth: z.number().int().min(1).max(4).optional().describe('递归层数，默认 2'),
  }),
  sideEffect: 'none',
  readOnly: true,
  guidelines: 'list_dir：先看结构，再决定读哪个文件。',
  execute: async ({ path, depth }, context) => {
    return guardToolResult(async () => {
      const workspace = requireWorkspace(context);
      const listing = await workspace.listDir(path ?? '.', depth ?? 2);
      return toolOk(listing.text, {
        summary: `查看 ${listing.path}（${listing.entries} 项${listing.truncated ? '，已截断' : ''}）`,
        entries: listing.entries,
        truncated: listing.truncated,
      });
    });
  },
});

export const globTool = defineTool({
  name: 'glob',
  description: `按路径模式查找文件，例如 **/*.test.ts 或 src/**/loop.ts。

什么时候调用：
- 知道文件名的一部分，但不知道它在哪；
- 需要列出某一类文件（测试、迁移、路由）。

它会跳过 node_modules、dist、.git 等目录，以及 .env 这类凭据文件。最多返回 200 个结果。`,
  parameters: z.object({
    pattern: z.string().min(1).describe('glob 模式，例如 **/*.ts'),
    max_results: z.number().int().min(1).max(1000).optional().describe('最多返回几个，默认 200'),
  }),
  sideEffect: 'none',
  readOnly: true,
  guidelines: 'glob：按文件名模式找文件，不读内容。',
  execute: async ({ pattern, max_results }, context) => {
    return guardToolResult(async () => {
      const workspace = requireWorkspace(context);
      const found = await workspace.glob(pattern, max_results ?? 200);
      const text =
        found.paths.length === 0
          ? `(没有匹配 ${pattern} 的文件)`
          : `${found.paths.join('\n')}${found.truncated ? `\n… [结果达到上限，缩小模式再找]` : ''}`;
      return toolOk(text, {
        summary: `找到 ${found.paths.length} 个文件${found.truncated ? '（已截断）' : ''}`,
        matches: found.paths.length,
        files: found.paths.slice(0, 50),
        truncated: found.truncated,
      });
    });
  },
});

export const grepTool = defineTool({
  name: 'grep',
  description: `在工作目录里按正则搜索文本，返回 路径:行号: 内容。

什么时候调用：
- 找某个函数、常量、错误信息在哪；
- 确认一个改动会影响哪些地方；
- 找用户提到的那段文字。

用 include 缩小范围（例如 include: "*.ts"）。它会跳过二进制文件、被忽略的目录和凭据文件。正则语法错误会直接报错，不会静默返回空结果。`,
  parameters: z.object({
    pattern: z.string().min(1).describe('JavaScript 正则，例如 saveMemory\\('),
    path: z.string().optional().describe('从哪个文件或目录开始，默认工作目录根'),
    include: z.string().optional().describe('文件名过滤，例如 *.ts'),
    case_sensitive: z.boolean().optional().describe('是否区分大小写，默认 true'),
    max_results: z.number().int().min(1).max(500).optional().describe('最多返回几处，默认 100'),
  }),
  sideEffect: 'none',
  readOnly: true,
  guidelines: 'grep：按内容找位置；用 include 缩小范围。',
  execute: async ({ pattern, path, include, case_sensitive, max_results }, context) => {
    return guardToolResult(async () => {
      const workspace = requireWorkspace(context);
      const result = await workspace.grep({
        pattern,
        ...(path ? { path } : {}),
        ...(include ? { include } : {}),
        ...(case_sensitive === undefined ? {} : { caseSensitive: case_sensitive }),
        ...(max_results ? { maxResults: max_results } : {}),
      });
      return toolOk(
        `${result.text}${result.truncated ? '\n… [结果达到上限，缩小模式或路径再找]' : ''}`,
        {
          summary: `命中 ${result.matches} 处（扫描 ${result.filesScanned} 个文件）`,
          matches: result.matches,
          truncated: result.truncated,
        },
      );
    });
  },
});

export const readOnlyCodingTools = [readFileTool, listDirTool, globTool, grepTool] as const;

export function requireWorkspace(context: ToolContext) {
  if (!context.workspace) {
    throw new WorkspaceError('当前没有配置工作目录，无法访问文件。请告诉用户需要配置 WORKSPACE_ROOT。');
  }
  return context.workspace;
}

/**
 * Turn a workspace error into a model-visible result.
 *
 * A thrown error would end the turn; a refused path is a normal answer the
 * model can correct from, so the distinction has to survive the tool boundary.
 */
export async function guardToolResult(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof WorkspaceError) return toolError(error.message);
    return toolError(error instanceof Error ? error.message : String(error));
  }
}
