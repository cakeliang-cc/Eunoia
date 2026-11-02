/**
 * The memory tools, declared for the project's tool registry instead of the
 * vendor SDK's.
 *
 * Behaviour lives in `memory-tools.ts` and is unchanged: same scoring, same
 * write policy, same refusal messages. What moved is only the declaration — a
 * JSON Schema is now derived from the same Zod object the loop validates with,
 * and the side effect is declared next to the tool rather than in a lookup
 * table three files away.
 *
 * Memory writes are `memory_write`, not `workspace_write`: they are reversible
 * from the memory panel and are the companion's core job. Requiring a filesystem
 * permission for them would either make every memory turn need an approval or
 * make file writes inherit an approval given for a memory.
 */

import { z } from 'zod';
import { defineTool, toolOk } from './types.ts';
import {
  saveMemory,
  searchMemory,
  updateMemory,
  type ToolContext as MemoryToolContext,
} from './memory-tools.ts';

const MEMORY_TYPE = z
  .enum(['episodic', 'semantic', 'narrative'])
  .describe(
    'episodic=发生过的具体事件；semantic=关于这个人稳定的偏好或事实；' +
      'narrative=他/她正在经历的、持续的一段处境或主题',
  );

const MEMORY_SOURCE = z
  .enum(['user_explicit', 'user_stated', 'inferred'])
  .describe(
    'user_explicit=用户明确要求你记住；user_stated=用户自己陈述的事实；' +
      'inferred=你自己推测出来的。标成 inferred 需要很高的 confidence，' +
      '否则会被拒绝——如果你不确定，就不要存，直接问用户。',
  );

const SEARCH_DESCRIPTION = '检索长期记忆，返回可能相关的片段。';
const SAVE_DESCRIPTION = '保存一条值得长期记住的事实。大多数对话不应该调用；来源必须诚实。';
const UPDATE_DESCRIPTION = '修改或废弃一条已有记忆；先搜到 id 再改。';

export function createMemoryTools(deps: MemoryToolContext) {
  const search = defineTool({
    name: 'search_memory',
    description: SEARCH_DESCRIPTION,
    parameters: z.object({
      query: z.string().min(1).describe('要检索的内容，用自然语言描述当前话题。'),
      limit: z.number().int().min(1).max(10).optional().describe('最多返回几条，默认 5。'),
    }),
    sideEffect: 'none',
    readOnly: true,
    guidelines: 'search_memory：只在话题可能和过去有关时检索；检索不到是正常结果。',
    execute: async (args) => {
      const result = await searchMemory(deps, args);
      return toolOk(JSON.stringify(result), {
        summary: `检索到 ${result.found} 条记忆`,
        found: result.found,
      });
    },
  });

  const save = defineTool({
    name: 'save_memory',
    description: SAVE_DESCRIPTION,
    parameters: z.object({
      type: MEMORY_TYPE,
      content: z
        .string()
        .min(1)
        .max(500)
        .describe('用一句陈述句描述这件事，写成关于这个人的事实。'),
      importance: z.number().min(0).max(1).optional().describe('对这个人有多重要，默认 0.5。'),
      confidence: z.number().min(0).max(1).optional().describe('你有多确定，默认按 source 决定。'),
      source: MEMORY_SOURCE,
      tags: z.array(z.string()).max(6).optional().describe('可选标签。'),
    }),
    sideEffect: 'memory_write',
    readOnly: false,
    guidelines: 'save_memory：宁可少存，也不要把推测当事实。',
    execute: async (args) => {
      const result = await saveMemory(deps, args);
      return toolOk(JSON.stringify(result), {
        summary:
          result.action === 'rejected'
            ? `拒绝写入：${result.explanation}`
            : result.action === 'updated'
              ? '更新了一条已有记忆'
              : '已记住',
        action: result.action,
      });
    },
  });

  const update = defineTool({
    name: 'update_memory',
    description: UPDATE_DESCRIPTION,
    parameters: z.object({
      id: z.string().describe('要更新的记忆 id，从 search_memory 的结果里获得。'),
      content: z.string().max(500).optional().describe('新的说法。'),
      importance: z.number().min(0).max(1).optional(),
      confidence: z.number().min(0).max(1).optional(),
      status: z
        .enum(['active', 'deleted'])
        .optional()
        .describe('"deleted" 表示这条不再适用了。'),
    }),
    sideEffect: 'memory_write',
    readOnly: false,
    guidelines: 'update_memory：用户纠正过去的说法时用；先 search 再改，不要新建冲突记忆。',
    execute: async (args) => {
      const result = await updateMemory(deps, args);
      return toolOk(JSON.stringify(result), {
        summary: result.ok ? (args.status === 'deleted' ? '已标记为不再适用' : '已更新记忆') : `更新失败：${result.explanation}`,
        updated: result.ok,
      });
    },
  });

  return [search, save, update] as const;
}
