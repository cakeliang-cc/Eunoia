/**
 * Multi-file patches with an all-or-nothing preflight.
 *
 * A patch is parsed and verified against every target before a single byte is
 * written. Each hunk must match its file's current lines exactly; an ambiguous
 * match is refused rather than guessed. When a write does fail mid-way, the tool
 * restores the files it already changed and reports the rollback, so a partial
 * patch is never left as a silent success.
 *
 * The syntax is the small `*** Begin Patch` format rather than unified diff:
 * line numbers in a unified diff are a hypothesis about a file the model cannot
 * see exactly, while context matching fails loudly when it is wrong.
 *
 * See docs/adr/038-developer-toolkit.md.
 */

import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineTool, toolError, toolOk } from '../types.ts';
import type { ToolContext, ToolResult } from '../types.ts';

export type PatchOperation =
  | { readonly kind: 'add'; readonly path: string; readonly lines: readonly string[] }
  | {
      readonly kind: 'update';
      readonly path: string;
      readonly moveTo: string | null;
      readonly hunks: readonly PatchHunk[];
    }
  | { readonly kind: 'delete'; readonly path: string };

export interface PatchHunk {
  readonly context: readonly string[];
  readonly removed: readonly string[];
  readonly added: readonly string[];
}

export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatchError';
  }
}

const MAX_PATCH_BYTES = 1024 * 1024;
const MAX_FILES = 20;
const MAX_HUNKS = 200;

/** Parse the patch text. Every structural problem is a named error. */
export function parsePatch(input: string): PatchOperation[] {
  if (Buffer.byteLength(input, 'utf8') > MAX_PATCH_BYTES) {
    throw new PatchError(`patch 超过 ${MAX_PATCH_BYTES} 字节上限`);
  }
  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  let index = 0;
  while (index < lines.length && (lines[index] as string).trim().length === 0) index += 1;
  if ((lines[index] as string)?.trim() !== '*** Begin Patch') {
    throw new PatchError('patch 必须以 *** Begin Patch 开头');
  }
  index += 1;
  const operations: PatchOperation[] = [];
  while (index < lines.length) {
    const line = lines[index] as string;
    if (line.trim() === '*** End Patch') {
      index += 1;
      break;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      index += 1;
      const added: string[] = [];
      while (index < lines.length && !lines[index]?.startsWith('***')) {
        const entry = lines[index] as string;
        if (entry.length === 0) {
          added.push('');
        } else if (entry.startsWith('+')) {
          added.push(entry.slice(1));
        } else {
          throw new PatchError(`Add File ${path} 的行必须以 + 开头：${entry.slice(0, 80)}`);
        }
        index += 1;
      }
      operations.push({ kind: 'add', path, lines: added });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      operations.push({ kind: 'delete', path: line.slice('*** Delete File: '.length).trim() });
      index += 1;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      index += 1;
      let moveTo: string | null = null;
      if (lines[index]?.startsWith('*** Move to: ')) {
        moveTo = (lines[index] as string).slice('*** Move to: '.length).trim();
        index += 1;
      }
      const hunks: PatchHunk[] = [];
      while (index < lines.length && !lines[index]?.startsWith('***')) {
        const header = lines[index] as string;
        if (!header.startsWith('@@')) {
          throw new PatchError(`Update File ${path} 需要以 @@ 开始 hunk：${header.slice(0, 80)}`);
        }
        index += 1;
        const context: string[] = [];
        const removed: string[] = [];
        const added: string[] = [];
        let sawChange = false;
        while (index < lines.length && !lines[index]?.startsWith('@@') && !lines[index]?.startsWith('***')) {
          const entry = lines[index] as string;
          if (entry.startsWith(' ')) {
            context.push(entry.slice(1));
          } else if (entry.startsWith('-')) {
            removed.push(entry.slice(1));
            sawChange = true;
          } else if (entry.startsWith('+')) {
            added.push(entry.slice(1));
            sawChange = true;
          } else if (entry.length === 0) {
            context.push('');
          } else {
            throw new PatchError(`hunk 行格式不合法：${entry.slice(0, 80)}`);
          }
          index += 1;
        }
        if (!sawChange) throw new PatchError(`Update File ${path} 有一个没有改动的 hunk`);
        hunks.push({ context, removed, added });
      }
      if (hunks.length === 0 && moveTo === null) {
        throw new PatchError(`Update File ${path} 没有 hunk，也没有 Move to`);
      }
      operations.push({ kind: 'update', path, moveTo, hunks });
      continue;
    }
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }
    throw new PatchError(`无法识别的 patch 指令：${line.slice(0, 80)}`);
  }
  if (index > lines.length || (lines[index - 1] as string)?.trim() !== '*** End Patch') {
    throw new PatchError('patch 缺少 *** End Patch');
  }
  if (operations.length === 0) throw new PatchError('patch 没有文件操作');
  if (operations.length > MAX_FILES) throw new PatchError(`patch 涉及文件超过 ${MAX_FILES} 个`);
  const hunks = operations.reduce(
    (count, operation) => count + (operation.kind === 'update' ? operation.hunks.length : 0),
    0,
  );
  if (hunks > MAX_HUNKS) throw new PatchError(`patch hunk 超过 ${MAX_HUNKS} 个`);
  return dedupeTargets(operations);
}

function dedupeTargets(operations: readonly PatchOperation[]): PatchOperation[] {
  const paths = new Set<string>();
  const targets = new Set<string>();
  for (const operation of operations) {
    const target = operation.kind === 'update' ? (operation.moveTo ?? operation.path) : operation.path;
    if (targets.has(target)) throw new PatchError(`patch 重复操作同一路径：${target}`);
    targets.add(target);
    paths.add(operation.path);
  }
  return [...operations];
}

export interface PatchFilePlan {
  readonly path: string;
  readonly kind: 'add' | 'update' | 'delete' | 'move';
  readonly movedTo?: string;
  readonly added: number;
  readonly removed: number;
  readonly beforeLines: number;
  readonly afterLines: number;
}

export interface PatchPlan {
  readonly files: readonly PatchFilePlan[];
  /** Full new content per written path; delete targets are absent. */
  readonly writes: ReadonlyMap<string, string>;
  readonly deletes: readonly string[];
  readonly moves: readonly { readonly from: string; readonly to: string }[];
}

/**
 * Apply hunks to one file's text.
 *
 * Context is matched exactly. A hunk whose old block occurs more than once in
 * the remaining file is rejected: picking one occurrence would be a guess.
 */
export function applyHunks(
  path: string,
  original: string,
  hunks: readonly PatchHunk[],
): { readonly text: string; readonly added: number; readonly removed: number } {
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r?\n/);
  const output: string[] = [];
  let cursor = 0;
  let addedCount = 0;
  let removedCount = 0;
  for (const [hunkIndex, hunk] of hunks.entries()) {
    const oldBlock = [...hunk.context, ...hunk.removed];
    const newBlock = [...hunk.context, ...hunk.added];
    if (oldBlock.length === 0) {
      // Pure insertion at the previous hunk's end.
      output.push(...lines.slice(cursor));
      cursor = lines.length;
      output.push(...newBlock);
      addedCount += hunk.added.length;
      continue;
    }
    const matches: number[] = [];
    for (let start = cursor; start <= lines.length - oldBlock.length; start += 1) {
      let equal = true;
      for (let offset = 0; offset < oldBlock.length; offset += 1) {
        if (lines[start + offset] !== oldBlock[offset]) {
          equal = false;
          break;
        }
      }
      if (equal) matches.push(start);
    }
    if (matches.length === 0) {
      throw new PatchError(
        `${path} 的 hunk ${hunkIndex + 1} 与当前内容不匹配（可能文件已变化或上下文不足）`,
      );
    }
    if (matches.length > 1) {
      throw new PatchError(
        `${path} 的 hunk ${hunkIndex + 1} 匹配到 ${matches.length} 处，无法安全判断应改哪一处；请增加上下文`,
      );
    }
    const start = matches[0] as number;
    output.push(...lines.slice(cursor, start), ...newBlock);
    cursor = start + oldBlock.length;
    addedCount += hunk.added.length;
    removedCount += hunk.removed.length;
  }
  output.push(...lines.slice(cursor));
  return { text: output.join(eol), added: addedCount, removed: removedCount };
}

/** Verify every operation against the current files; no writes happen here. */
export function planPatch(
  operations: readonly PatchOperation[],
  read: (path: string) => string | null,
): PatchPlan {
  const writes = new Map<string, string>();
  const deletes: string[] = [];
  const moves: { from: string; to: string }[] = [];
  const files: PatchFilePlan[] = [];
  for (const operation of operations) {
    if (operation.kind === 'add') {
      if (read(operation.path) !== null) throw new PatchError(`文件已存在，不能 Add：${operation.path}`);
      const text = operation.lines.join('\n') + (operation.lines.length > 0 ? '\n' : '');
      writes.set(operation.path, text);
      files.push({
        path: operation.path,
        kind: 'add',
        added: operation.lines.length,
        removed: 0,
        beforeLines: 0,
        afterLines: operation.lines.length,
      });
      continue;
    }
    const original = read(operation.path);
    if (original === null) throw new PatchError(`文件不存在：${operation.path}`);
    if (original.includes('\u0000')) throw new PatchError(`不支持二进制文件：${operation.path}`);
    if (operation.kind === 'delete') {
      deletes.push(operation.path);
      files.push({
        path: operation.path,
        kind: 'delete',
        added: 0,
        removed: original.split(/\r?\n/).length,
        beforeLines: original.split(/\r?\n/).length,
        afterLines: 0,
      });
      continue;
    }
    const applied = applyHunks(operation.path, original, operation.hunks);
    const target = operation.moveTo ?? operation.path;
    if (operation.moveTo) {
      if (read(operation.moveTo) !== null) {
        throw new PatchError(`移动目标已存在：${operation.moveTo}`);
      }
      moves.push({ from: operation.path, to: operation.moveTo });
      deletes.push(operation.path);
    }
    writes.set(target, applied.text);
    files.push({
      path: operation.path,
      kind: operation.moveTo ? 'move' : 'update',
      ...(operation.moveTo ? { movedTo: operation.moveTo } : {}),
      added: applied.added,
      removed: applied.removed,
      beforeLines: original.split(/\r?\n/).length,
      afterLines: applied.text.split(/\r?\n/).length,
    });
  }
  return { files, writes, deletes, moves };
}

/** Read text through the workspace port, preserving nothing but the bytes. */
async function readText(context: ToolContext, path: string): Promise<string | null> {
  if (!context.workspace) return null;
  const info = await context.workspace.stat(path).catch(() => null);
  if (!info) return null;
  if (info.size > 2 * 1024 * 1024) throw new PatchError(`文件过大，不能打补丁：${path}`);
  const slice = await context.workspace.readLines(path, 1, 0);
  return slice.text
    .split('\n')
    .map((line) => line.replace(/^\s*\d+\t/, ''))
    .join('\n');
}

function digest(text: string): string {
  return createHash('sha256')
    .update(text.replace(/\r\n/g, '\n'), 'utf8')
    .digest('hex');
}

export const applyPatchTool = defineTool({
  name: 'apply_patch',
  description:
    'Apply a multi-file patch with a full preflight and per-file atomic replacement. Supports Add File, Update File (with context hunks and optional Move to) and Delete File. ' +
    'The batch is not a filesystem transaction: if a later file fails, the applied files are rolled back only while they still match this patch, and a journal records the partial state. Use dry_run to preview.',
  parameters: z.object({
    patch: z.string().min(1).max(MAX_PATCH_BYTES),
    dry_run: z.boolean().optional(),
  }),
  sideEffect: 'workspace_write',
  readOnly: false,
  guidelines:
    'apply_patch verifies all files before writing. Use enough context in each hunk to be unambiguous; a hunk matching more than once is refused. Prefer it over several independent edits when a change spans files.',
  timeoutMs: 30_000,
  async execute({ patch, dry_run }, context): Promise<ToolResult> {
    if (!context.workspace) return toolError('没有配置工作区，不能打补丁。');
    let operations: PatchOperation[];
    try {
      operations = parsePatch(patch);
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error), {
        code: 'PATCH_INVALID',
      });
    }
    let plan: PatchPlan;
    const cache = new Map<string, string | null>();
    try {
      const read = (path: string): string | null => {
        if (!cache.has(path)) {
          // planPatch is synchronous; preload happens before it below.
          throw new Error(`unprepared path ${path}`);
        }
        return cache.get(path) ?? null;
      };
      for (const operation of operations) {
        cache.set(operation.path, null);
        if (operation.kind === 'update' && operation.moveTo) cache.set(operation.moveTo, null);
      }
      for (const path of cache.keys()) {
        cache.set(path, await readText(context, path));
      }
      plan = planPatch(operations, read);
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error), {
        code: error instanceof PatchError ? 'PATCH_CONFLICT' : 'PATCH_FAILED',
      });
    }
    const summary = plan.files
      .map((file) =>
        `${file.kind} ${file.path}${file.movedTo ? ` → ${file.movedTo}` : ''} (+${file.added}/-${file.removed})`,
      )
      .join('\n');
    if (dry_run) {
      return toolOk(`dry-run：补丁可以应用。\n${summary}`, {
        summary: `dry-run ${plan.files.length} 个文件`,
        files: plan.files.length,
      });
    }

    const paths = [...new Set([...plan.writes.keys(), ...plan.deletes])].sort();
    const batchId = `patch_${randomUUID()}`;
    const beforeDigests: Record<string, string | null> = {};
    const afterDigests: Record<string, string | null> = {};
    for (const path of paths) {
      const before = cache.get(path) ?? null;
      beforeDigests[path] = before === null ? null : digest(before);
      afterDigests[path] = plan.writes.get(path) === undefined ? null : digest(plan.writes.get(path) as string);
    }
    await context.changes
      ?.beginBatch?.({ batchId, paths, before: beforeDigests, after: afterDigests })
      .catch(() => undefined);
    // Journal every touched file before writing, so turn undo has exact before
    // content. A missing journal only removes the undo offer, not the patch.
    for (const path of paths) {
      await context.changes?.beforeWrite(path).catch(() => undefined);
    }
    const written: string[] = [];
    const deleted: string[] = [];
    const apply = async (): Promise<void> => {
      // Re-read and re-plan while holding the workspace lock. The earlier plan
      // was a preparation, not an authorization: a file changed between the
      // read and the write must be refused, not overwritten.
      const verifiedCache = new Map<string, string | null>();
      for (const path of cache.keys()) verifiedCache.set(path, await readText(context, path));
      plan = planPatch(operations, (path) => verifiedCache.get(path) ?? null);
      for (const [path, before] of verifiedCache) {
        cache.set(path, before);
        const after = plan.writes.get(path) ?? null;
        beforeDigests[path] = before === null ? null : digest(before);
        afterDigests[path] = after === null ? null : digest(after);
      }
      for (const [path, text] of plan.writes) {
        await context.workspace!.writeText(path, text);
        written.push(path);
        await context.changes
          ?.markBatchApplied?.(batchId, path, digest(text))
          .catch(() => undefined);
      }
      for (const path of plan.deletes) {
        if (!context.workspace!.deleteFile) {
          throw new PatchError('工作区不支持删除文件，补丁回滚');
        }
        await context.workspace!.deleteFile(path);
        deleted.push(path);
        await context.changes?.markBatchApplied?.(batchId, path, null).catch(() => undefined);
      }
    };
    try {
      if (context.changes?.lockPaths) {
        await context.changes.lockPaths(paths, apply);
      } else {
        await apply();
      }
      await context.changes?.completeBatch?.(batchId).catch(() => undefined);
    } catch (error) {
      // Restore exactly what this patch already changed. The before bytes came
      // from the preflight cache, so a half-written multi-file patch is not left
      // behind as a "successful" partial edit.
      const rollbackErrors: string[] = [];
      for (const path of [...written, ...deleted]) {
        const before = cache.get(path);
        try {
          if (before === null || before === undefined) {
            await context.workspace.deleteFile?.(path);
          } else {
            await context.workspace.writeText(path, before);
          }
        } catch (rollbackError) {
          rollbackErrors.push(
            `${path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          );
        }
      }
      await context.changes
        ?.markBatchReconciliation?.(batchId, [
          error instanceof Error ? error.message : String(error),
          ...rollbackErrors,
        ])
        .catch(() => undefined);
      return toolError(
        `补丁应用失败，已回滚：${error instanceof Error ? error.message : String(error)}` +
          (rollbackErrors.length > 0 ? `\n回滚失败：${rollbackErrors.join('；')}` : ''),
        {
          code: 'PATCH_FAILED',
          written: written.length,
          deleted: deleted.length,
          rollbackErrors: rollbackErrors.length,
        },
      );
    }
    return toolOk(`补丁已应用（${plan.files.length} 个文件）：\n${summary}`, {
      summary: `${plan.files.length} 个文件`,
      files: plan.files.length,
    });
  },
});
