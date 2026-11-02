/**
 * Read-only coding tools: what the agent looks with.
 *
 * All four are `none` side effect and `readOnly`, so they run concurrently and
 * need no approval. The descriptions spend their length on *when* to call, not
 * on what the schema already says: a tool whose description only restates its
 * parameters gets called at the wrong moments.
 */

import { z } from 'zod';
import {
  defineTool,
  toolError,
  toolOk,
  type ToolContext,
  type ToolResult,
  type ToolWorkspacePort,
} from '../types.ts';
import { truncateHead } from '../truncate.ts';
import { WorkspaceError } from '../workspace.ts';

const PATH = z.string().min(1).describe('要读的路径；相对路径从工作区根目录算。');
const MAX_READ_LINES = 2_000;
const MAX_READ_CHARS = 50_000;

export const readFileTool = defineTool({
  name: 'read_file',
  description: '读取一个文本文件并返回带行号的内容。大文件用 start/end 分段读；同一段在本轮重复读取时返回指针，而不是再发一遍全文。',
  parameters: z.object({
    path: PATH,
    start: z.number().int().min(1).optional().describe('起始行，从 1 开始，默认 1。'),
    end: z.number().int().min(1).optional().describe('结束行，含这一行；省略则读到文件结尾。'),
  }),
  sideEffect: 'none',
  readOnly: true,
  guidelines: 'read_file：读文本用 read_file，不要用 run_command 读文件。',
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
  description: '列出一个目录的结构，默认两层、最多四层；超过 500 项会截断。',
  parameters: z.object({
    path: z.string().optional().describe('目录路径，默认工作区根目录。'),
    depth: z.number().int().min(1).max(4).optional().describe('递归层数，默认 2，最多 4。'),
  }),
  sideEffect: 'none',
  readOnly: true,
  guidelines: 'list_dir：先看目录结构，再决定读哪个文件。',
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
  description: '按 glob 模式查找文件（只返回文件，不返回目录）。跳过被忽略的目录和凭据文件；结果按路径排序，最多 200 条。',
  parameters: z.object({
    pattern: z.string().min(1).describe('glob 模式，例如 **/*.ts 或 src/**/loop.ts。'),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe('最多返回几个，默认 200，上限 1000。'),
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
  description: '用 JavaScript 正则搜索文件内容，返回按文件分组的 路径:行号: 内容，最多 100 处。跳过二进制、被忽略的目录和凭据文件。',
  parameters: z.object({
    pattern: z.string().min(1).describe('JavaScript 正则。'),
    path: z.string().optional().describe('从哪个文件或目录开始，默认工作区根目录。'),
    include: z.string().optional().describe('只搜匹配这个 glob 的文件，例如 *.ts。'),
    case_sensitive: z.boolean().optional().describe('是否区分大小写，默认 true。'),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe('最多返回几处，默认 100，上限 500。'),
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

export function requireWorkspace(context: ToolContext): ToolWorkspacePort {
  if (!context.workspace) {
    throw new WorkspaceError(
      '当前没有配置沙箱工作目录，无法访问文件。请告诉用户需要配置 WORKSPACE_ROOT 并启用 Sandbox。',
    );
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
    // An approval request is not a tool failure the model can correct: it is a
    // call waiting on a person. The ids travel in `meta` so the transport can
    // draw an approve button, and the message stays model-readable.
    const approval = approvalIds(error);
    if (approval) return toolError(messageOf(error), { approval });
    return toolError(messageOf(error));
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read the approval ids off a `SandboxApprovalRequiredError` without importing
 * the sandbox module.
 *
 * The tools layer must not depend on the sandbox's implementation, and the
 * sandbox cannot depend on a tool: the stable contract is the error `name` and
 * its two id fields, which the error class documents. Matching on those keeps
 * the dependency arrow pointing one way.
 */
function approvalIds(
  error: unknown,
): { readonly requestId: string | null; readonly approvalRequestId: string | null } | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as {
    name?: unknown;
    requestId?: unknown;
    approvalRequestId?: unknown;
  };
  if (candidate.name !== 'SandboxApprovalRequiredError') return null;
  const requestId = typeof candidate.requestId === 'string' ? candidate.requestId : null;
  const approvalRequestId =
    typeof candidate.approvalRequestId === 'string' ? candidate.approvalRequestId : null;
  if (requestId === null && approvalRequestId === null) return null;
  return { requestId, approvalRequestId };
}
