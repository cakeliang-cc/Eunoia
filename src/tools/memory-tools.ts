/**
 * The memory tools' behaviour (spec §9), with no SDK and no schema library.
 *
 * These are plain async functions over domain types. `src/agent/tools.ts` wraps
 * them in the SDK's `tool()` with zod schemas; this file is what those wrappers
 * call. The split is not ceremony — it is what lets the whole tool surface be
 * tested directly, including the rejection paths, without standing up an agent
 * or a model call.
 *
 * Three tools, one job each. The temptation with a companion is a single
 * `manage_memory` that takes an action, which reads well in a schema and is
 * untestable in practice: every branch becomes a string comparison on a field,
 * and the model's mistakes become indistinguishable from its intentions.
 */

import type { MemoryStore } from '../memory/store.ts';
import type { MemorySource, MemoryType } from '../memory/types.ts';
import { MEMORY_TYPES } from '../memory/types.ts';
import { selectMemories, type RetrievalBudget } from '../memory/retrieval.ts';
import { writeMemory, MAX_CONTENT_CHARS } from '../memory/writer.ts';

export interface ToolContext {
  readonly store: MemoryStore;
  readonly userId: string;
  /** The message being replied to, recorded as the memory's origin. */
  readonly sourceMessageId?: string | null;
  readonly now?: Date;
}

/** What a tool returns. Always JSON-serialisable: it is going back to the model. */
export interface SearchMemoryResult {
  readonly found: number;
  readonly memories: readonly {
    readonly id: string;
    readonly type: MemoryType;
    readonly content: string;
    readonly importance: number;
    readonly confidence: number;
    readonly source: MemorySource;
    readonly unconfirmed: boolean;
  }[];
  readonly note: string;
}

export interface SaveMemoryResult {
  readonly ok: boolean;
  readonly action: 'created' | 'updated' | 'rejected';
  readonly id: string | null;
  readonly explanation: string;
}

export interface UpdateMemoryResult {
  readonly ok: boolean;
  readonly id: string | null;
  readonly explanation: string;
}

/**
 * Search, scored and budgeted — the model-initiated path.
 *
 * There is also an automatic path (`src/service/context.ts`), which runs a
 * smaller retrieval before every turn and puts the result in the prompt. The two
 * exist for different reasons and are budgeted differently:
 *
 *   - the automatic path guarantees that memory is actually consulted, rather
 *     than depending on the model choosing to look;
 *   - this path is how the model follows up, and it is deliberately wider — more
 *     results, no overlap gate — because the model asked a specific question and
 *     is the one who can judge whether the answer fits.
 *
 * The cost of the automatic path is that it can put something irrelevant in
 * front of the model. That is what `AUTO_INJECT_BUDGET`'s overlap gate is for.
 */
export async function searchMemory(
  ctx: ToolContext,
  args: { query: string; limit?: number; types?: readonly string[] },
): Promise<SearchMemoryResult> {
  const query = args.query?.trim() ?? '';
  if (query.length === 0) {
    return { found: 0, memories: [], note: 'query was empty; nothing was searched for' };
  }

  const limit = clampInt(args.limit ?? 5, 1, 10);
  const budget: Partial<RetrievalBudget> = { maxItems: limit };

  const candidates = await ctx.store.listMemories(ctx.userId, { limit: 200, types: args.types });
  const { selected } = selectMemories(candidates, query, { budget, now: ctx.now });

  if (selected.length > 0) {
    await ctx.store.markAccessed(
      ctx.userId,
      selected.map((entry) => entry.memory.id),
    );
  }

  return {
    found: selected.length,
    memories: selected.map(({ memory }) => ({
      id: memory.id,
      type: memory.type,
      content: memory.content,
      importance: round2(memory.importance),
      confidence: round2(memory.confidence),
      source: memory.source,
      unconfirmed: memory.status === 'unconfirmed',
    })),
    note:
      selected.length === 0
        ? '没有找到相关的记忆。这不代表你不了解对方，只代表这次检索没有命中。'
        : `从 ${candidates.length} 条记忆里选出 ${selected.length} 条。这些是候选，不是必须提及的内容。`,
  };
}

export async function saveMemory(
  ctx: ToolContext,
  args: {
    type: MemoryType;
    content: string;
    importance?: number;
    confidence?: number;
    source: MemorySource;
    tags?: readonly string[];
  },
): Promise<SaveMemoryResult> {
  if (!MEMORY_TYPES.includes(args.type)) {
    return {
      ok: false,
      action: 'rejected',
      id: null,
      explanation: `type 必须是 ${MEMORY_TYPES.join(' / ')} 之一`,
    };
  }

  const decision = await writeMemory(ctx.store, {
    userId: ctx.userId,
    type: args.type,
    content: args.content ?? '',
    importance: args.importance,
    confidence: args.confidence,
    source: args.source,
    tags: args.tags,
    sourceMessageId: ctx.sourceMessageId ?? null,
  });

  if (decision.action === 'rejected') {
    return { ok: false, action: 'rejected', id: null, explanation: decision.reason ?? '拒绝写入' };
  }

  return {
    ok: true,
    action: decision.action,
    id: decision.memory?.id ?? null,
    explanation:
      decision.action === 'updated'
        ? '已经有一条几乎一样的记忆，所以更新了那一条，没有新增。'
        : '已记住。',
  };
}

/**
 * Correct or retire an existing memory.
 *
 * Deliberately not a general-purpose edit: the model may change what a memory
 * says, how much it matters, or that it no longer applies. It may not change
 * `source` — a fact does not become something the user said because the model
 * later decided it was right.
 */
export async function updateMemory(
  ctx: ToolContext,
  args: {
    id: string;
    content?: string;
    importance?: number;
    confidence?: number;
    status?: 'active' | 'deleted';
  },
): Promise<UpdateMemoryResult> {
  const id = args.id?.trim() ?? '';
  if (id.length === 0) return { ok: false, id: null, explanation: 'id 不能为空' };

  if (args.content !== undefined) {
    const content = args.content.trim();
    if (content.length === 0) return { ok: false, id, explanation: 'content 不能是空的' };
    if (content.length > MAX_CONTENT_CHARS) {
      return { ok: false, id, explanation: `content 超过 ${MAX_CONTENT_CHARS} 字上限` };
    }
  }

  const existing = await ctx.store.getMemory(ctx.userId, id);
  if (!existing) {
    return { ok: false, id, explanation: '没有找到这条记忆，可能已经被删除或者 id 不对。' };
  }

  const updated = await ctx.store.updateMemory(ctx.userId, id, {
    content: args.content?.trim(),
    importance: args.importance,
    confidence: args.confidence,
    status: args.status,
  });

  if (!updated) return { ok: false, id, explanation: '更新失败' };

  await ctx.store.logMemoryEvent({
    memoryId: id,
    userId: ctx.userId,
    action: args.status === 'deleted' ? 'deleted' : 'updated',
    actor: 'agent',
    detail: { fields: Object.keys(args).filter((key) => key !== 'id') },
  });

  return {
    ok: true,
    id,
    explanation: args.status === 'deleted' ? '已标记为不再适用。' : '已更新。',
  };
}

/**
 * Tools that write are reversible by design: every memory can be edited or
 * deleted by the person, and nothing here leaves the system or touches the world
 * outside it (spec §16). This list exists so that adding a tool with a real side
 * effect — sending something, spending something — is a visible change to a
 * declared set rather than an unremarked addition.
 */
export type ToolSideEffect = 'none' | 'writes_local' | 'external';

export const TOOL_SIDE_EFFECTS: Readonly<Record<string, ToolSideEffect>> = {
  search_memory: 'none',
  save_memory: 'writes_local',
  update_memory: 'writes_local',
};

/** Anything not in this set must be approved before it runs. */
export function requiresApproval(toolName: string): boolean {
  const effect = TOOL_SIDE_EFFECTS[toolName];
  return effect === undefined || effect === 'external';
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
