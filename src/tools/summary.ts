/**
 * Human-readable summaries for the tool trace.
 *
 * The trace exists because a coding turn is mostly things the model does not
 * narrate: which file it read, what it ran, what came back. A UI that only shows
 * the prose leaves the person guessing whether anything happened at all.
 *
 * Only summaries go on the wire, never tool output or full arguments. A path and
 * a line range are what a person needs to recognise the step; the content of a
 * file already passed through the model and does not need a second life in an
 * event stream.
 */

import type { ToolResult } from './types.ts';

export function summarizeToolCall(name: string, args: Record<string, unknown>): string {
  const path = stringArg(args, 'path');
  switch (name) {
    case 'read_file': {
      const start = numberArg(args, 'start');
      const end = numberArg(args, 'end');
      const range = start > 0 || end > 0 ? `:${start > 0 ? start : 1}-${end > 0 ? end : ''}` : '';
      return `读取 ${path || '文件'}${range}`;
    }
    case 'list_dir':
      return `查看 ${path || '.'}/`;
    case 'glob':
      return `查找 ${stringArg(args, 'pattern') || '*'}${path ? ` 在 ${path}` : ''}`;
    case 'grep': {
      const query = stringArg(args, 'pattern');
      return `搜索 ${query ? JSON.stringify(clip(query, 40)) : '内容'}${path ? ` 在 ${path}` : ''}`;
    }
    case 'write_file': {
      const content = stringArg(args, 'content');
      return `写入 ${path || '文件'}${content ? `（${formatBytes(Buffer.byteLength(content, 'utf8'))}）` : ''}`;
    }
    case 'edit_file':
      return `修改 ${path || '文件'}`;
    case 'run_command':
      return `运行 ${clip(stringArg(args, 'command'), 80) || '命令'}`;
    case 'search_memory':
      return `检索记忆 ${clip(stringArg(args, 'query'), 40)}`;
    case 'save_memory':
      return `保存记忆 ${clip(stringArg(args, 'content'), 40)}`;
    case 'update_memory':
      return `更新记忆 ${clip(stringArg(args, 'id'), 20)}`;
    default:
      return name;
  }
}

export function summarizeToolResult(name: string, result: ToolResult): string {
  const supplied = result.meta?.summary;
  if (typeof supplied === 'string' && supplied.length > 0) return supplied;
  if (!result.ok) return clip(result.error ?? '失败', 160);

  const read = result.meta?.read as
    | { start?: number; end?: number; complete?: boolean }
    | undefined;
  if (name === 'read_file' && read) {
    return `读取 ${read.start ?? 1}-${read.end ?? '?'} 行${read.complete ? '（整份）' : ''}`;
  }
  if (name === 'run_command') {
    const exit = result.meta?.exitCode;
    const duration = result.meta?.durationMs;
    const suffix = typeof duration === 'number' ? ` · ${(duration / 1000).toFixed(1)}s` : '';
    return `退出码 ${typeof exit === 'number' ? exit : '?'}${suffix}`;
  }
  return result.output.length > 0 ? clip(result.output.split('\n')[0] as string, 160) : '完成';
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function numberArg(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
