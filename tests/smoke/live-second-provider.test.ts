/**
 * Optional real second-provider smoke.
 *
 * The local protocol contract (`tests/provider/protocol-contract.test.ts`) is
 * the required evidence: it exercises both wire protocols against real HTTP/SSE
 * fixtures. This file only closes the external wiring item when a real second
 * vendor credential is available:
 *
 *     RUN_SECOND_PROVIDER_SMOKE=1 \
 *     SECOND_PROVIDER_BASE_URL=https://…/v1 \
 *     SECOND_PROVIDER_API_KEY=… \
 *     SECOND_PROVIDER_MODEL=… \
 *     SECOND_PROVIDER_PROTOCOL=chat-completions \
 *     npx vitest run tests/smoke/live-second-provider.test.ts
 *
 * It is skipped by default and never required by `npm test`. A missing
 * credential is an external BLOCKED item, not a failure the offline suite can
 * paper over.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { createSdkModelTurn } from '../../src/agent/model-turn.ts';
import type { ModelTurnEvent } from '../../src/agent/model-port.ts';
import {
  closeProviders,
  defaultProviderId,
  providerFor,
  providerProtocol,
} from '../../src/provider/index.ts';

const baseURL = process.env.SECOND_PROVIDER_BASE_URL?.trim() ?? '';
const apiKey = process.env.SECOND_PROVIDER_API_KEY?.trim() ?? '';
const modelId = process.env.SECOND_PROVIDER_MODEL?.trim() ?? '';
const providerId = process.env.SECOND_PROVIDER_ID?.trim() || 'second-provider';
const apiKeyEnv = process.env.SECOND_PROVIDER_API_KEY_ENV?.trim() || 'SECOND_PROVIDER_API_KEY';
const rawProtocol = process.env.SECOND_PROVIDER_PROTOCOL?.trim().toLowerCase();
const protocol = rawProtocol === 'chat-completions' ? 'chat-completions' : 'responses';
const enabled =
  process.env.RUN_SECOND_PROVIDER_SMOKE === '1' &&
  baseURL.length > 0 &&
  apiKey.length > 0 &&
  modelId.length > 0 &&
  (rawProtocol === undefined || rawProtocol === '' || rawProtocol === 'responses' || rawProtocol === 'chat-completions');

const live = enabled ? describe : describe.skip;

async function collect(events: AsyncIterable<ModelTurnEvent>): Promise<ModelTurnEvent[]> {
  const out: ModelTurnEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

live('second provider smoke', () => {
  it('answers one text turn through the configured protocol', async () => {
    process.env[apiKeyEnv] = apiKey;
    const configs = JSON.parse(process.env.MODEL_PROVIDER_CONFIGS ?? '{}') as Record<string, unknown>;
    configs[providerId] = {
      id: providerId,
      baseURL,
      apiKeyEnv,
      protocol,
      requestTimeoutMs: 60_000,
    };
    process.env.MODEL_PROVIDER_CONFIGS = JSON.stringify(configs);
    expect(providerProtocol(providerId)).toBe(protocol);
    expect(defaultProviderId()).not.toBe('');

    const adapter = providerFor(providerId);
    const model = await adapter.createModelProvider().getModel(modelId);
    const events = await collect(
      createSdkModelTurn(model)({
        instructions: 'Answer briefly. Do not use tools.',
        input: [{ type: 'message', role: 'user', content: 'Reply with the single word: ok' }],
        tools: [],
      }),
    );
    const done = events.find((event) => event.type === 'done');
    expect(done).toBeDefined();
    if (!done || done.type !== 'done') throw new Error('no done event');
    const message = done.output.find((item) => item.type === 'message');
    expect(message?.type === 'message' ? message.content.trim().length : 0).toBeGreaterThan(0);
    // Printed as evidence for the acceptance report; no key or host is logged.
    console.log(
      JSON.stringify({
        providerId,
        protocol,
        modelId,
        usage: done.usage ?? null,
        textChars: message?.type === 'message' ? message.content.length : 0,
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await closeProviders();
  });
});
