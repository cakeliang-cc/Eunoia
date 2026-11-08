/**
 * A tool-returned image must be part of *the next model request*, not just of
 * the tool result the UI renders.
 *
 * The browser screenshot adapter (R06) appends a `ToolContentBlock` image after
 * the text; this test pins the loop-side half of that contract: the block is
 * collected as a tool result image, the media planner is asked to price it, and
 * the following request carries the call/result pair with its images.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runAgentLoop } from '../../src/agent/loop.ts';
import type { LoopInputItem } from '../../src/agent/model-port.ts';
import type { PreparedMediaPlan } from '../../src/agent/request-plan.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';
import { DEFAULT_TOOL_POLICY, defineTool, type ToolResult } from '../../src/tools/types.ts';
import { TurnReadLedger } from '../../src/tools/ledger.ts';

const ASSET_ID = '11111111-1111-4111-8111-111111111111';

function screenshotTool(): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'take_screenshot',
    description: 'Return text and one tool image, as the browser adapter does.',
    parameters: z.object({}),
    sideEffect: 'none',
    readOnly: true,
    execute: async (): Promise<ToolResult> => ({
      ok: true,
      output: '### Result\n- [Screenshot of viewport](page-1.png) — 已导入媒体库',
      content: [
        {
          type: 'text',
          text: '### Result\n- [Screenshot of viewport](page-1.png) — 已导入媒体库',
        },
        {
          type: 'image',
          source: 'tool',
          assetId: ASSET_ID,
          mediaType: 'image/png',
          width: 4,
          height: 3,
          bytes: 94,
          name: 'page-1.png',
        },
      ],
    }),
  });
}

describe('a tool image reaches the next model request', () => {
  it('collects the ToolContentBlock image into prepareMedia and the call/result pair', async () => {
    const requests: LoopInputItem[][] = [];
    const prepareCalls: (readonly string[])[] = [];
    let step = 0;
    const modelTurn = async function* (request: { readonly input: readonly LoopInputItem[] }) {
      requests.push([...request.input]);
      step += 1;
      if (step === 1) {
        yield {
          type: 'done' as const,
          output: [
            { type: 'function_call' as const, callId: 'c1', name: 'take_screenshot', arguments: '{}' },
          ],
        };
        return;
      }
      yield { type: 'text_delta' as const, text: '看过了' };
      yield {
        type: 'done' as const,
        output: [{ type: 'message' as const, role: 'assistant' as const, content: '看过了' }],
      };
    };

    const events = [];
    for await (const event of runAgentLoop({
      modelTurn,
      instructions: 'x',
      input: [{ type: 'message', role: 'user', content: '截个图看看' }],
      tools: new ToolRegistry([screenshotTool()]),
      toolContext: {
        workspace: null,
        executor: null,
        cwd: null,
        policy: DEFAULT_TOOL_POLICY,
        ledger: new TurnReadLedger(),
        now: new Date('2026-11-08T00:00:00.000Z'),
      },
      prepareMedia: async ({ imageIds }) => {
        prepareCalls.push([...imageIds]);
        // The store is not the subject here; the ids and the pair are.
        return undefined as PreparedMediaPlan | undefined;
      },
    })) {
      events.push(event);
    }

    // The first step has no images; the step after the tool call prices exactly
    // the asset the block named.
    expect(prepareCalls.at(-1)).toEqual([ASSET_ID]);
    expect(prepareCalls.every((ids) => ids.every((id) => id === ASSET_ID))).toBe(true);

    const second = requests[1] ?? [];
    const result = second.find((item) => item.type === 'function_call_result');
    expect(result).toMatchObject({
      type: 'function_call_result',
      callId: 'c1',
      name: 'take_screenshot',
    });
    expect(
      (result as Extract<LoopInputItem, { type: 'function_call_result' }>).images,
    ).toEqual([
      {
        assetId: ASSET_ID,
        mediaType: 'image/png',
        width: 4,
        height: 3,
        bytes: 94,
        name: 'page-1.png',
      },
    ]);

    const toolResult = events.find((event) => event.type === 'tool_result');
    expect(toolResult).toMatchObject({ type: 'tool_result', ok: true, images: 1 });
  });
});
