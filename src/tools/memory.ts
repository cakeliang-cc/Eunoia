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

const SEARCH_DESCRIPTION = `在你已经了解这个人的事情可能和当前话题有关时，检索长期记忆。

什么时候调用：
- 用户提到"之前""那次""还记得吗"这类指涉过去的话；
- 你打算说出一件关于用户的具体事实，但不确定自己是否真的记得；
- 当前话题和这个人长期在意的事情可能有关。

什么时候不调用：日常寒暄、用户只是需要被听到、话题明显和过去无关。
检索不到是正常结果——不要因为没检索到就编一个。`;

const SAVE_DESCRIPTION = `把一件值得长期记住的事写进记忆。

**大多数对话不应该调用这个工具。** 值得记住的是：稳定的偏好、重要的价值观、
反复出现的模式、重大的生活事件、用户明确要求记住的事。

不要保存：琐碎内容、暂时情绪（"今天很累"）、对用户人格的推测、敏感信息
（除非用户明确要求且确有必要）。

拿不准的时候不要存。一条错误的长期记忆会在未来每一次对话里误导你。`;

const UPDATE_DESCRIPTION = `修正、更新或废弃一条已经存在的记忆。

用 search_memory 找到 id，再改。当用户说"我已经不……了""那个不对""别再提这个"时，
用这个工具更新或标记为 deleted——不要新建一条和旧说法冲突的记忆。`;

export function createMemoryTools(deps: MemoryToolContext) {
  const search = defineTool({
    name: 'search_memory',
    description: SEARCH_DESCRIPTION,
    parameters: z.object({
      query: z.string().min(1).describe('要检索的内容，用自然语言描述当前话题'),
      limit: z.number().int().min(1).max(10).optional().describe('最多返回几条，默认 5'),
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
        .describe('用一句陈述句描述这件事。写成关于这个人的事实，不要写对话记录。'),
      importance: z.number().min(0).max(1).optional().describe('对这个人有多重要，默认 0.5'),
      confidence: z.number().min(0).max(1).optional().describe('你有多确定，默认按 source 决定'),
      source: MEMORY_SOURCE,
      tags: z.array(z.string()).max(6).optional().describe('可选标签'),
    }),
    sideEffect: 'memory_write',
    readOnly: false,
    guidelines: 'save_memory：大多数对话不该调用；宁可少存，也不要把推测当事实。',
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
      id: z.string().describe('要更新的记忆 id，从 search_memory 的结果里获得'),
      content: z.string().max(500).optional().describe('新的说法'),
      importance: z.number().min(0).max(1).optional(),
      confidence: z.number().min(0).max(1).optional(),
      status: z
        .enum(['active', 'deleted'])
        .optional()
        .describe('"deleted" 表示这条不再适用了'),
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
