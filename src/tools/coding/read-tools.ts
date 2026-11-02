/**
 * Read-only coding tools: what the agent looks with.
 *
 * All four are `none` side effect and `readOnly`, so they run concurrently and
 * need no approval. The descriptions are contracts, not tutorials: what the
 * tool returns and the one or two constraints the schema cannot express. The
 * "when to call" rules live in the system prompt (ADR 023).
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

const MAX_READ_LINES = 2_000;
const MAX_READ_CHARS = 50_000;

export const readFileTool = defineTool({
  name: 'read',
  description: 'Read a UTF-8 text file and return line-numbered content.',
  parameters: z.object({
    file_path: z.string().min(1).describe('Path to read, relative to the workspace root.'),
    offset: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('1-based first line to return. Defaults to 1.'),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Maximum number of lines to return. Defaults to the rest of the file.'),
  }),
  sideEffect: 'none',
  readOnly: true,
  guidelines: 'Read text with read — not with bash.',
  execute: async ({ file_path, offset, limit }, context) => {
    return guardToolResult(async () => {
      const workspace = requireWorkspace(context);
      const start = offset ?? 1;
      const end = limit === undefined ? 0 : start + limit - 1;
      const slice = await workspace.readLines(file_path, start, end);

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
        ? `\n… [只显示了第 ${deliveredStart}-${deliveredEnd} 行，共 ${slice.totalLines} 行；继续用 offset=${deliveredEnd + 1} 读]`
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
  description:
    "List a directory's structure, two levels by default and at most four. Results truncate at 500 entries.",
  parameters: z.object({
    path: z.string().optional().describe('Directory path. Defaults to the workspace root.'),
    depth: z.number().int().min(1).max(4).optional().describe('Recursion depth. Defaults to 2.'),
  }),
  sideEffect: 'none',
  readOnly: true,
  guidelines: 'List the tree before choosing a file to read.',
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
  description:
    'Find files, not directories, whose paths match a glob pattern, including hidden files. Skips ignored directories and credential files. Returns up to 200 paths, sorted by path.',
  parameters: z.object({
    pattern: z
      .string()
      .min(1)
      .describe('Glob pattern to match file paths against (e.g. "**/*.ts", "src/**/loop.ts").'),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe('Maximum number of paths to return. Defaults to 200.'),
  }),
  sideEffect: 'none',
  readOnly: true,
  guidelines: 'Discover files by path pattern with glob — not with find.',
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
  description:
    'Search file contents with a JavaScript regular expression. Returns up to 100 matching lines with line numbers, grouped by file. Skips binary files, ignored directories and credential files.',
  parameters: z.object({
    pattern: z.string().min(1).describe('JavaScript regular expression to search for.'),
    path: z
      .string()
      .optional()
      .describe('File or directory to search. Defaults to the workspace root.'),
    include: z
      .string()
      .optional()
      .describe('One glob filter for which files to search (e.g. "*.ts"). Not a list.'),
    case_sensitive: z.boolean().optional().describe('Case-sensitive match. Defaults to true.'),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe('Maximum number of matches to return. Defaults to 100.'),
  }),
  sideEffect: 'none',
  readOnly: true,
  guidelines: 'Search contents with grep — not with shell grep.',
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
