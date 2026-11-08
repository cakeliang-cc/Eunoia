/**
 * A11/A22/A23: the bytes actually handed to an adapter.
 *
 * A plan says "one 640×480 image"; these tests decode what the adapter received
 * and compare. A filename, a URL or a text placeholder would pass a looser test
 * and fail the only claim that matters — that the model got pixels in order.
 */

import { describe, expect, it } from 'vitest';
import type { Model, StreamEvent } from '@openai/agents';
import sharp from 'sharp';
import type { UserContentV1 } from '../../src/agent/content.ts';
import { createSdkModelTurn } from '../../src/agent/model-turn.ts';
import type { LoopInputItem } from '../../src/agent/model-port.ts';
import {
  planMediaRequest,
  withImageData,
  type PreparedMediaPlan,
} from '../../src/agent/request-plan.ts';
import { MODEL_CATALOG } from '../../src/models/catalog.ts';
import { MODEL_IDS } from '../../src/config.ts';
import { DEFAULT_MEDIA_LIMITS } from '../../src/media/limits.ts';
import { DEEPSEEK_FLASH_IMAGE_POLICY } from '../../src/provider/deepseek/image-policy.ts';
import { createFakeVisionCapture, createFakeVisionTurn, fakeVisionProfile, FAKE_IMAGE_POLICY } from '../../src/provider/fake.ts';
import { imageBytes, makeAsset } from '../helpers/images.ts';
import { runAgentLoop } from '../../src/agent/loop.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';
import { DEFAULT_TOOL_POLICY, defineTool, toolOk } from '../../src/tools/types.ts';
import { TurnReadLedger } from '../../src/tools/ledger.ts';
import { z } from 'zod';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

async function preparedPlan(
  widthA: number,
  heightA: number,
  widthB: number,
  heightB: number,
): Promise<PreparedMediaPlan> {
  const content: UserContentV1 = {
    version: 1,
    parts: [
      { type: 'image', assetId: ID_A },
      { type: 'image', assetId: ID_B },
    ],
  };
  const aBytes = await imageBytes(widthA, heightA, { format: 'image/png' });
  const bBytes = await imageBytes(widthB, heightB, { format: 'image/png' });
  const a = makeAsset({
    id: ID_A,
    width: widthA,
    height: heightA,
    request: {
      key: 'a',
      width: widthA,
      height: heightA,
      bytes: aBytes.length,
      sha256: 'a',
      processorVersion: 'test',
      policyRevision: 'request-variant/1',
    },
  });
  const b = makeAsset({
    id: ID_B,
    width: widthB,
    height: heightB,
    request: {
      key: 'b',
      width: widthB,
      height: heightB,
      bytes: bBytes.length,
      sha256: 'b',
      processorVersion: 'test',
      policyRevision: 'request-variant/1',
    },
  });
  const result = planMediaRequest({
    profile: MODEL_CATALOG[MODEL_IDS.fast]!,
    policy: DEEPSEEK_FLASH_IMAGE_POLICY,
    current: content,
    history: [],
    assets: [a, b],
    limits: DEFAULT_MEDIA_LIMITS,
  });
  if (!result.ok) throw new Error(result.error.message);
  return withImageData(
    result.plan,
    new Map([
      [ID_A, aBytes],
      [ID_B, bBytes],
    ]),
  );
}

const done: StreamEvent = {
  type: 'response_done',
  response: {
    id: 'resp',
    usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    output: [
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'ok' }],
      },
    ],
  },
} as unknown as StreamEvent;

function capturingModel(seen: { requests: unknown[] }): Model {
  return {
    getResponse: async () => {
      throw new Error('not used');
    },
    getStreamedResponse: (request) => {
      seen.requests.push(request);
      return (async function* stream() {
        yield done;
      })();
    },
  } as Model;
}

describe('SDK adapter image encoding (A11)', () => {
  it('sends decodable images in content order', async () => {
    const plan = await preparedPlan(640, 480, 120, 90);
    const seen = { requests: [] as unknown[] };
    const turn = createSdkModelTurn(capturingModel(seen));
    const input: LoopInputItem[] = [
      {
        type: 'message',
        role: 'user',
        content: plan.images.get(ID_A)
          ? [
              { type: 'text', text: '先看第一张' },
              { type: 'image', assetId: ID_A },
              { type: 'text', text: '再看第二张' },
              { type: 'image', assetId: ID_B },
            ]
          : [],
      },
    ];
    let events = 0;
    for await (const event of turn({ instructions: 'x', input, tools: [], media: plan })) {
      if (event.type === 'done') events += 1;
    }
    expect(events).toBe(1);
    const request = seen.requests[0] as {
      input: { content: { type: string; image?: string; text?: string }[] }[];
    };
    const parts = request.input[0]?.content ?? [];
    expect(parts.map((part) => part.type)).toEqual([
      'input_text',
      'input_image',
      'input_text',
      'input_image',
    ]);
    const first = Buffer.from((parts[1]?.image ?? '').split(',')[1] ?? '', 'base64');
    const second = Buffer.from((parts[3]?.image ?? '').split(',')[1] ?? '', 'base64');
    expect(await sharp(first).metadata().then((meta) => [meta.width, meta.height])).toEqual([
      640, 480,
    ]);
    expect(await sharp(second).metadata().then((meta) => [meta.width, meta.height])).toEqual([
      120, 90,
    ]);
  });

  it('throws rather than sending a placeholder when bytes are missing', async () => {
    const plan = await preparedPlan(64, 64, 32, 32);
    const withoutData: PreparedMediaPlan = {
      ...plan,
      images: new Map(
        [...plan.images].map(([id, image]) => [id, { ...image, data: undefined }]),
      ),
    };
    const turn = createSdkModelTurn(capturingModel({ requests: [] }));
    await expect(async () => {
      for await (const event of turn({
        instructions: 'x',
        input: [{ type: 'message', role: 'user', content: [{ type: 'image', assetId: ID_A }] }],
        tools: [],
        media: withoutData,
      })) {
        void event.type;
      }
    }).rejects.toThrow(/no planned image bytes/);
  });
});

describe('the offline second route (A22)', () => {
  it('receives the same canonical message through its own protocol', async () => {
    const bytes = await imageBytes(150, 75, { format: 'image/jpeg' });
    const asset = makeAsset({
      id: ID_A,
      mediaType: 'image/jpeg',
      width: 200,
      height: 100,
      request: {
        key: 'r',
        width: 150,
        height: 75,
        bytes: bytes.length,
        sha256: 'variant',
        processorVersion: 'test',
        policyRevision: 'request-variant/1',
      },
    });
    const content: UserContentV1 = {
      version: 1,
      parts: [
        { type: 'text', text: '这是什么' },
        { type: 'image', assetId: ID_A },
      ],
    };
    const planResult = planMediaRequest({
      profile: fakeVisionProfile(),
      policy: FAKE_IMAGE_POLICY,
      current: content,
      history: [],
      assets: [asset],
      limits: DEFAULT_MEDIA_LIMITS,
      inputBudgetTokens: 8_000,
    });
    if (!planResult.ok) throw new Error(planResult.error.message);
    const plan = withImageData(planResult.plan, new Map([[ID_A, bytes]]));
    const capture = createFakeVisionCapture();
    const turn = createFakeVisionTurn({ capture });
    const events = [];
    for await (const event of turn({
      instructions: 'x',
      input: [{ type: 'message', role: 'user', content: content.parts }],
      tools: [],
      media: plan,
    })) {
      events.push(event);
    }
    expect(capture.requests).toHaveLength(1);
    const wire = capture.requests[0]!;
    expect(wire.protocol).toBe('fake-tiles/1');
    expect(wire.tiles).toHaveLength(1);
    expect(wire.tiles[0]).toMatchObject({
      kind: 'fake_image_tile',
      mime: 'image/jpeg',
      width: 150,
      height: 75,
      decodedWidth: 150,
      decodedHeight: 75,
      detail: 'low',
    });
    expect(wire.text).toContain('这是什么');
    // The fake route's formula is not DeepSeek's.
    expect(plan.imageTokens).toBe(Math.ceil((150 * 75) / 4096) + 48);
    expect(events.at(-1)?.type).toBe('done');
  });
});

describe('every loop step carries the images (A23)', () => {
  it('counts the occurrences on step two as a new visual input', async () => {
    const plan = await preparedPlan(320, 240, 160, 120);
    const seenInputs: (readonly LoopInputItem[])[] = [];
    let step = 0;
    const modelTurn = async function* (request: { input: readonly LoopInputItem[] }) {
      seenInputs.push(request.input);
      step += 1;
      if (step === 1) {
        yield {
          type: 'done' as const,
          output: [
            {
              type: 'function_call' as const,
              callId: 'c1',
              name: 'noop',
              arguments: '{}',
            },
          ],
        };
        return;
      }
      yield { type: 'text_delta' as const, text: 'done' };
      yield {
        type: 'done' as const,
        output: [{ type: 'message' as const, role: 'assistant' as const, content: 'done' }],
      };
    };
    const tools = new ToolRegistry([
      defineTool({
        name: 'noop',
        description: 'noop',
        parameters: z.object({}),
        sideEffect: 'none',
        readOnly: true,
        execute: async () => toolOk('ok'),
      }),
    ]);
    const events = [];
    for await (const event of runAgentLoop({
      modelTurn,
      instructions: 'x',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'text', text: '看两张' },
            { type: 'image', assetId: ID_A },
            { type: 'image', assetId: ID_B },
          ],
        },
      ],
      tools,
      toolContext: {
        workspace: null,
        executor: null,
        cwd: null,
        policy: DEFAULT_TOOL_POLICY,
        ledger: new TurnReadLedger(),
        now: new Date(),
      },
      media: plan,
      contextBudget: {
        windowTokens: 100_000,
        outputReserveTokens: 1_000,
        safetyBufferTokens: 100,
        estimator: 'mixed',
      },
    })) {
      events.push(event);
    }
    expect(seenInputs).toHaveLength(2);
    for (const input of seenInputs) {
      const user = input[0] as Extract<LoopInputItem, { type: 'message' }>;
      expect(Array.isArray(user.content)).toBe(true);
      expect(
        (user.content as readonly { type: string }[]).filter((part) => part.type === 'image'),
      ).toHaveLength(2);
    }
    expect(events.at(-1)?.type).toBe('completed');
  });
});
