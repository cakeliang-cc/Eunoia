/**
 * B10/B12/A16: real usage is recorded as reported, and provider errors are not
 * a reason to change what the message contains.
 *
 * The local image estimate is a planning number. Once the provider reports
 * `input_tokens`, that total is the fact — adding the estimate again would
 * double-count the image and make "cost" a number nobody measured.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { MemoryMediaBlobStore } from '../../src/media/blob-store.ts';
import { MediaService } from '../../src/media/service.ts';
import { DEFAULT_MEDIA_LIMITS } from '../../src/media/limits.ts';
import { DecodeGate } from '../../src/media/decode.ts';
import { defaultImagePolicies } from '../../src/provider/image-policy-registry.ts';
import { SessionService } from '../../src/session/service.ts';
import { sessionConfig } from '../../src/session/config.ts';
import { modelProfile } from '../../src/models/registry.ts';
import { MODEL_IDS } from '../../src/config.ts';
import { runTurn, type TurnRunner } from '../../src/service/chat.ts';
import { TurnCoordinator } from '../../src/service/turns.ts';
import type { AgentEvent } from '../../src/agent/events.ts';
import type { UserContentV1 } from '../../src/agent/content.ts';
import type { TurnRecord } from '../../src/session/turn-types.ts';
import { imageBytes } from '../helpers/images.ts';

let store: InMemoryStore;
let media: MediaService;
let userId: string;
let conversationId: string;
let content: UserContentV1;

function deps(runner: TurnRunner, turns: TurnCoordinator) {
  const config = sessionConfig({ SESSION_PROMPT_RESERVE_TOKENS: '0' });
  return {
    store,
    media,
    imagePolicies: defaultImagePolicies(),
    mediaLimits: DEFAULT_MEDIA_LIMITS,
    sessionConfig: config,
    modelProfileFor: modelProfile,
    turns,
    runner,
    sessions: new SessionService(store, {
      config,
      model: modelProfile(MODEL_IDS.fast),
      summaryModel: modelProfile(MODEL_IDS.fast),
      resolveModel: modelProfile,
    }),
  };
}

async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

beforeEach(async () => {
  store = new InMemoryStore();
  media = new MediaService({
    store,
    blobs: new MemoryMediaBlobStore(),
    limits: DEFAULT_MEDIA_LIMITS,
    gate: new DecodeGate(2),
  });
  userId = randomUUID();
  await store.ensureUser(userId);
  conversationId = (await store.createConversation(userId, null, MODEL_IDS.fast)).id;
  // Seed through the service so the request variant the planner reads exists.
  const viaService = await media.putImage({
    userId,
    conversationId,
    name: 'cost.png',
    declaredMediaType: 'image/png',
    bytes: await imageBytes(800, 800, { format: 'image/png' }),
  });
  content = { version: 1, parts: [{ type: 'image', assetId: viaService.id }] };
});

async function runWith(
  runner: TurnRunner,
): Promise<{ turn: TurnRecord; events: AgentEvent[] }> {
  const turns = new TurnCoordinator(store);
  const requestId = randomUUID();
  await turns.begin({
    requestId,
    userId,
    conversationId,
    requestHash: 'hash',
    model: MODEL_IDS.fast,
  });
  const events = await drain(
    runTurn(deps(runner, turns), {
      userId,
      conversationId,
      message: '',
      content,
      requestId,
      persist: true,
    }),
  );
  const turn = await turns.get(requestId);
  if (!turn) throw new Error('turn not found');
  return { turn, events };
}

describe('recording usage (B10, B12)', () => {
  it('records the provider total, not local image estimate added to it', async () => {
    let calls = 0;
    const runner: TurnRunner = async function* () {
      calls += 1;
      yield { type: 'text_delta', text: '看到了。' };
      yield {
        type: 'completed',
        text: '看到了。',
        usage: {
          inputTokens: 5_000,
          outputTokens: 20,
          totalTokens: 5_020,
          cachedTokens: 100,
          responseModel: 'deepseek-flash',
        },
      };
    };
    const { turn, events } = await runWith(runner);
    expect(calls).toBe(1);
    expect(events.at(-1)?.type).toBe('completed');
    expect(turn.usage).toEqual({
      inputTokens: 5_000,
      outputTokens: 20,
      totalTokens: 5_020,
      cachedTokens: 100,
      responseModel: 'deepseek-flash',
      imageTokensUnknown: true,
    });
    // The plan counted 422 tokens for the 800×800 image; that is a separate
    // estimate and must never be added to the provider's 5,000.
    expect(turn.usage?.inputTokens).not.toBe(5_000 + 422);
  });

  it('leaves usage null when the provider reports none, rather than zero', async () => {
    const runner: TurnRunner = async function* () {
      yield { type: 'text_delta', text: '好。' };
      yield { type: 'completed', text: '好。' };
    };
    const { turn } = await runWith(runner);
    expect(turn.usage).toBeNull();
  });
});

describe('provider failures keep the input and the image (A16, B12)', () => {
  for (const [label, message] of [
    ['image rejected', 'provider rejected image content'],
    ['429', '429 rate limited'],
    ['401', '401 invalid api key'],
    ['5xx', '503 upstream unavailable'],
  ] as const) {
    it(`${label}: ends failed, keeps the bound image, does not retry automatically`, async () => {
      let calls = 0;
      const runner: TurnRunner = async function* () {
        calls += 1;
        yield { type: 'text_delta', text: '部分' };
        yield { type: 'error', message, retryable: true };
      };
      const { turn, events } = await runWith(runner);
      expect(calls).toBe(1);
      expect(turn.status).toBe('failed');
      expect(turn.finishReason).toBe('failed');
      expect(turn.error).toContain(message);
      expect(events.some((event) => event.type === 'error')).toBe(true);

      const user = await store.lastUserMessage(userId, conversationId);
      expect(user?.contentParts).toEqual(content);
      const assetId = content.parts[0]?.type === 'image' ? content.parts[0].assetId : '';
      expect((await store.getMediaAsset(userId, assetId))?.status).toBe('bound');
    });
  }
});
