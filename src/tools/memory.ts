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

const SEARCH_DESCRIPTION = 'Search long-term memory and return possibly relevant fragments.';
const SAVE_DESCRIPTION = 'Save one fact worth remembering long-term. Most conversations should not call this; be honest about the source.';
const UPDATE_DESCRIPTION = 'Update or retire an existing memory. Search for its id first.';

export function createMemoryTools(deps: MemoryToolContext) {
  const search = defineTool({
    name: 'search_memory',
    description: SEARCH_DESCRIPTION,
    parameters: z.object({
      query: z.string().min(1).describe('What to search for, in natural language.'),
      limit: z.number().int().min(1).max(10).optional().describe('Maximum number of results. Defaults to 5.'),
    }),
    sideEffect: 'none',
    readOnly: true,
    guidelines: 'Search memory only when the topic may relate to the past; no result is a normal result.',
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
        .describe('One statement of fact about the person, not a transcript.'),
      importance: z.number().min(0).max(1).optional().describe('How important this is to the person. Defaults to 0.5.'),
      confidence: z.number().min(0).max(1).optional().describe('How certain you are. Defaults by source.'),
      source: MEMORY_SOURCE,
      tags: z.array(z.string()).max(6).optional().describe('Optional tags.'),
    }),
    sideEffect: 'memory_write',
    readOnly: false,
    guidelines: 'Prefer saving less; never store a guess as fact.',
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
      id: z.string().describe('The memory id to update, from search_memory.'),
      content: z.string().max(500).optional().describe('The new statement.'),
      importance: z.number().min(0).max(1).optional(),
      confidence: z.number().min(0).max(1).optional(),
      status: z
        .enum(['active', 'deleted'])
        .optional()
        .describe('"deleted" means it no longer applies.'),
    }),
    sideEffect: 'memory_write',
    readOnly: false,
    guidelines: 'When the person corrects an earlier statement, search first and update; do not create a conflicting memory.',
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
