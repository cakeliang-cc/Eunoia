/**
 * The multimodal HTTP surface, over a real socket: upload, preview, authorization,
 * chat preflight, history hydration, regeneration and idempotency.
 *
 * The model is a capturing runner, so a 422 can be asserted to have made zero
 * model calls and a 201 image can be asserted to arrive as planned bytes rather
 * than a filename.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { createApp } from '../../src/api/server.ts';
import { MODEL_IDS } from '../../src/config.ts';
import { modelProfile } from '../../src/models/registry.ts';
import { FileMediaBlobStore } from '../../src/media/blob-store.ts';
import { MediaService } from '../../src/media/service.ts';
import { DEFAULT_MEDIA_LIMITS } from '../../src/media/limits.ts';
import { DecodeGate } from '../../src/media/decode.ts';
import { defaultImagePolicies } from '../../src/provider/image-policy-registry.ts';
import { ImagePolicyRegistry } from '../../src/provider/image-policy.ts';
import { FAKE_VISION_MODEL_ID, fakeVisionProfile, createFakeVisionCapture, createFakeVisionTurn } from '../../src/provider/fake.ts';
import { sessionConfig } from '../../src/session/config.ts';
import { SessionService } from '../../src/session/service.ts';
import type { TurnRunner } from '../../src/service/chat.ts';
import type { UserContentV1 } from '../../src/agent/content.ts';
import type { PreparedMediaPlan } from '../../src/agent/request-plan.ts';
import { imageBytes } from '../helpers/images.ts';

interface CapturedTurn {
  readonly message: string;
  readonly content?: UserContentV1;
  readonly media?: PreparedMediaPlan;
}

function capturingRunner(reply = '看到了。'): {
  runner: TurnRunner;
  calls: CapturedTurn[];
} {
  const calls: CapturedTurn[] = [];
  const runner: TurnRunner = async function* (_agent, message, options) {
    calls.push({ message, content: options?.content, media: options?.media });
    yield { type: 'text_delta', text: reply };
    yield { type: 'completed', text: reply };
  };
  return { runner, calls };
}

interface Fixture {
  store: InMemoryStore;
  media: MediaService;
  root: string;
  server: Server;
  base: string;
  close(): Promise<void>;
}

async function fixture(options: {
  runner?: TurnRunner;
  policies?: ImagePolicyRegistry;
  limits?: typeof DEFAULT_MEDIA_LIMITS;
  config?: ReturnType<typeof sessionConfig>;
  modelProfiles?: (id: string) => ReturnType<typeof modelProfile>;
} = {}): Promise<Fixture> {
  const store = new InMemoryStore();
  const root = await mkdtemp(join(tmpdir(), 'eunoia-api-media-'));
  const blobs = new FileMediaBlobStore(root);
  const limits = options.limits ?? DEFAULT_MEDIA_LIMITS;
  const media = new MediaService({
    store,
    blobs,
    limits,
    gate: new DecodeGate(limits.maxConcurrentDecodes),
  });
  const server = createApp({
    store,
    ...(options.modelProfiles
      ? {
          sessions: new SessionService(store, {
            config: options.config ?? sessionConfig({ SESSION_PROMPT_RESERVE_TOKENS: '0' }),
            resolveModel: options.modelProfiles,
          }),
        }
      : {}),
    media,
    imagePolicies: options.policies ?? defaultImagePolicies(),
    mediaLimits: limits,
    sessionConfig: options.config ?? sessionConfig({ SESSION_PROMPT_RESERVE_TOKENS: '0' }),
    ...(options.runner ? { runner: options.runner } : {}),
    ...(options.modelProfiles ? { modelProfiles: options.modelProfiles } : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  return {
    store,
    media,
    root,
    server,
    base,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function identity(base: string): Promise<string> {
  const response = await fetch(`${base}/api/conversations`);
  const cookie = response.headers.get('set-cookie');
  expect(cookie).toBeTruthy();
  return (cookie as string).split(';')[0] as string;
}

async function json(
  base: string,
  path: string,
  init: RequestInit & { cookie?: string } = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const { cookie, ...rest } = init;
  const response = await fetch(`${base}${path}`, {
    ...rest,
    headers: {
      ...(rest.headers ?? {}),
      ...(cookie ? { cookie } : {}),
      ...(rest.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.length > 0 ? JSON.parse(text) : null,
    headers: response.headers,
  };
}

async function createConversation(
  base: string,
  cookie: string,
  modelId: string | null = null,
): Promise<string> {
  const response = await json(base, '/api/conversations', {
    method: 'POST',
    cookie,
    body: JSON.stringify(modelId ? { modelId } : {}),
  });
  expect(response.status).toBe(201);
  return response.body.conversation.id as string;
}

async function upload(
  base: string,
  cookie: string,
  conversationId: string,
  bytes: Uint8Array,
  options: { name?: string; type?: string } = {},
): Promise<{ status: number; body: any }> {
  const query =
    `conversationId=${encodeURIComponent(conversationId)}` +
    `&name=${encodeURIComponent(options.name ?? 'image.png')}`;
  const response = await fetch(`${base}/api/media/images?${query}`, {
    method: 'POST',
    headers: {
      cookie,
      'content-type': options.type ?? 'image/png',
    },
    body: bytes,
  });
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
}

async function chat(
  base: string,
  cookie: string,
  body: Record<string, unknown>,
): Promise<{ status: number; frames: { event: string; data: any }[]; body: any; headers: Headers }> {
  const response = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const parsed = await response.json().catch(() => null);
    return { status: response.status, frames: [], body: parsed, headers: response.headers };
  }
  const raw = await response.text();
  const frames = raw
    .split('\n\n')
    .filter((block) => block.trim().length > 0 && !block.startsWith(':'))
    .map((block) => ({
      event: /^event: (.*)$/m.exec(block)?.[1] ?? '',
      data: JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? '{}'),
    }));
  return { status: response.status, frames, body: null, headers: response.headers };
}

function userIdFromCookie(cookie: string): string {
  return decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1));
}

function imageContent(...ids: string[]): UserContentV1 {
  return { version: 1, parts: ids.map((assetId) => ({ type: 'image', assetId })) };
}

describe('media HTTP surface', () => {
  let app: Fixture | null = null;

  beforeEach(async () => {
    app = null;
  });

  afterEach(async () => {
    if (app) await app.close();
    app = null;
  });

  it('uploads, previews and deletes a draft without a sandbox (A03)', async () => {
    app = await fixture();
    const cookie = await identity(app.base);
    const conversationId = await createConversation(app.base, cookie, MODEL_IDS.fast);
    const png = await imageBytes(320, 200);
    const uploaded = await upload(app.base, cookie, conversationId, png, { name: '设计稿.png' });
    expect(uploaded.status).toBe(201);
    expect(uploaded.body.asset).toMatchObject({
      name: '设计稿.png',
      mediaType: 'image/png',
      width: 320,
      height: 200,
      status: 'pending',
    });
    expect(uploaded.body.asset.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(uploaded.body)).not.toContain(app.root);

    const preview = await fetch(
      `${app.base}/api/media/images/${uploaded.body.asset.id}`,
      { headers: { cookie } },
    );
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-type')).toBe('image/png');
    expect(preview.headers.get('x-content-type-options')).toBe('nosniff');
    expect(preview.headers.get('cache-control')).toContain('no-store');
    expect(Buffer.from(await preview.arrayBuffer()).length).toBeGreaterThan(0);

    const deleted = await json(app.base, `/api/media/images/${uploaded.body.asset.id}`, {
      method: 'DELETE',
      cookie,
    });
    expect(deleted.status).toBe(200);
    const gone = await fetch(`${app.base}/api/media/images/${uploaded.body.asset.id}`, {
      headers: { cookie },
    });
    expect(gone.status).toBe(404);
  });

  it('refuses another user and another conversation (A07)', async () => {
    app = await fixture();
    const alice = await identity(app.base);
    const bob = await identity(app.base);
    const conversation = await createConversation(app.base, alice, MODEL_IDS.fast);
    const png = await imageBytes(64, 64);
    const uploaded = await upload(app.base, alice, conversation, png);
    expect(uploaded.status).toBe(201);

    const bobPreview = await fetch(`${app.base}/api/media/images/${uploaded.body.asset.id}`, {
      headers: { cookie: bob },
    });
    expect(bobPreview.status).toBe(404);
    const bobDelete = await json(app.base, `/api/media/images/${uploaded.body.asset.id}`, {
      method: 'DELETE',
      cookie: bob,
    });
    expect(bobDelete.status).toBe(404);

    const bobChat = await chat(app.base, bob, {
      content: imageContent(uploaded.body.asset.id),
      conversationId: conversation,
    });
    expect(bobChat.status).toBe(404);
    expect(bobChat.body?.error?.code ?? bobChat.body?.error).toBeTruthy();
  });

  it('sends an image-only message as decodable bytes and replays it in history (A11/A12/A13)', async () => {
    const captured = capturingRunner();
    app = await fixture({ runner: captured.runner });
    const cookie = await identity(app.base);
    const conversationId = await createConversation(app.base, cookie, MODEL_IDS.fast);
    const png = await imageBytes(640, 480, { format: 'image/jpeg' });
    const uploaded = await upload(app.base, cookie, conversationId, png, {
      name: 'only.jpg',
      type: 'image/jpeg',
    });
    expect(uploaded.status).toBe(201);

    const sent = await chat(app.base, cookie, {
      content: imageContent(uploaded.body.asset.id),
      conversationId,
      requestId: randomUUID(),
      turnId: randomUUID(),
    });
    expect(sent.status).toBe(200);
    expect(sent.frames.at(-1)?.event).toBe('completed');
    expect(captured.calls).toHaveLength(1);
    expect(captured.calls[0]?.message).toBe('');
    expect(captured.calls[0]?.content?.parts).toHaveLength(1);
    const planned = captured.calls[0]?.media?.images.get(uploaded.body.asset.id);
    expect(planned?.data?.length).toBeGreaterThan(0);
    expect(planned?.width).toBe(640);

    const history = await json(app.base, `/api/conversations/${conversationId}/messages`, {
      cookie,
    });
    expect(history.status).toBe(200);
    const user = history.body.messages.find((message: any) => message.role === 'user');
    expect(user.content).toBe('');
    expect(user.contentParts.parts[0]).toMatchObject({
      type: 'image',
      assetId: uploaded.body.asset.id,
      image: { status: 'bound', url: `/api/media/images/${uploaded.body.asset.id}` },
    });

    // Regeneration reads the same asset from the transcript and streams.
    const regenResponse = await fetch(`${app.base}/api/chat/regenerate`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        conversationId,
        requestId: randomUUID(),
        turnId: randomUUID(),
      }),
    });
    expect(regenResponse.status).toBe(200);
    const regenText = await regenResponse.text();
    expect(regenText).toContain('event: completed');
    expect(captured.calls).toHaveLength(2);
    expect(captured.calls[1]?.media?.images.get(uploaded.body.asset.id)?.data?.length).toBeGreaterThan(0);
  });

  it('carries the stored history image into a continuation turn (A13)', async () => {
    const captured = capturingRunner();
    app = await fixture({ runner: captured.runner });
    const cookie = await identity(app.base);
    const conversationId = await createConversation(app.base, cookie, MODEL_IDS.fast);
    const uploaded = await upload(app.base, cookie, conversationId, await imageBytes(36, 24));
    const first = await chat(app.base, cookie, {
      content: imageContent(uploaded.body.asset.id),
      conversationId,
      requestId: randomUUID(),
    });
    expect(first.status).toBe(200);
    const resume = await chat(app.base, cookie, {
      message: '继续说说',
      continue: true,
      conversationId,
      requestId: randomUUID(),
    });
    expect(resume.status).toBe(200);
    expect(captured.calls).toHaveLength(2);
    const planned = captured.calls[1]?.media?.images.get(uploaded.body.asset.id);
    expect(planned?.data?.length).toBeGreaterThan(0);
  });

  it('keeps the old reply when regeneration is refused before rewind (A13/A14)', async () => {
    const captured = capturingRunner();
    app = await fixture({ runner: captured.runner });
    const cookie = await identity(app.base);
    const conversationId = await createConversation(app.base, cookie, MODEL_IDS.fast);
    const uploaded = await upload(app.base, cookie, conversationId, await imageBytes(32, 32));
    const first = await chat(app.base, cookie, {
      content: imageContent(uploaded.body.asset.id),
      conversationId,
      requestId: randomUUID(),
    });
    expect(first.status).toBe(200);
    await json(app.base, `/api/conversations/${conversationId}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ modelId: MODEL_IDS.companion }),
    });

    const before = await json(app.base, `/api/conversations/${conversationId}/messages`, {
      cookie,
    });
    const response = await fetch(`${app.base}/api/chat/regenerate`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId, requestId: randomUUID(), turnId: randomUUID() }),
    });
    expect(response.status).toBe(422);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe('MODEL_INPUT_UNSUPPORTED');
    const after = await json(app.base, `/api/conversations/${conversationId}/messages`, {
      cookie,
    });
    expect(after.body.messages).toHaveLength(before.body.messages.length);
    expect(captured.calls).toHaveLength(1);
  });

  it('rejects an image on a text model with zero model calls and no message (A09)', async () => {
    const captured = capturingRunner();
    app = await fixture({ runner: captured.runner });
    const cookie = await identity(app.base);
    const conversationId = await createConversation(app.base, cookie, MODEL_IDS.companion);
    const png = await imageBytes(40, 40);
    const uploaded = await upload(app.base, cookie, conversationId, png);
    const sent = await chat(app.base, cookie, {
      content: imageContent(uploaded.body.asset.id),
      conversationId,
      requestId: randomUUID(),
    });
    expect(sent.status).toBe(422);
    expect(sent.body.error.code).toBe('MODEL_INPUT_UNSUPPORTED');
    expect(sent.body.error.details.scope).toBe('current');
    expect(captured.calls).toHaveLength(0);

    const history = await json(app.base, `/api/conversations/${conversationId}/messages`, {
      cookie,
    });
    expect(history.body.messages).toHaveLength(0);
    expect(await app.store.activeTurn(conversationId)).toBeNull();
  });

  it('refuses text after switching to a text model when history has an image (A14)', async () => {
    const captured = capturingRunner();
    app = await fixture({ runner: captured.runner });
    const cookie = await identity(app.base);
    const conversationId = await createConversation(app.base, cookie, MODEL_IDS.fast);
    const png = await imageBytes(30, 30);
    const uploaded = await upload(app.base, cookie, conversationId, png);
    const first = await chat(app.base, cookie, {
      content: imageContent(uploaded.body.asset.id),
      conversationId,
      requestId: randomUUID(),
    });
    expect(first.status).toBe(200);
    await json(app.base, `/api/conversations/${conversationId}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ modelId: MODEL_IDS.companion }),
    });
    const second = await chat(app.base, cookie, {
      message: '那是什么颜色',
      conversationId,
      requestId: randomUUID(),
    });
    expect(second.status).toBe(422);
    expect(second.body.error.code).toBe('MODEL_INPUT_UNSUPPORTED');
    expect(second.body.error.details.scope).toBe('history');
    expect(captured.calls).toHaveLength(1);
  });

  it('refuses a supported route with no token policy (A10)', async () => {
    const captured = capturingRunner();
    app = await fixture({
      runner: captured.runner,
      policies: new ImagePolicyRegistry(),
    });
    const cookie = await identity(app.base);
    const conversationId = await createConversation(app.base, cookie, MODEL_IDS.fast);
    const uploaded = await upload(app.base, cookie, conversationId, await imageBytes(20, 20));
    const sent = await chat(app.base, cookie, {
      content: imageContent(uploaded.body.asset.id),
      conversationId,
      requestId: randomUUID(),
    });
    expect(sent.status).toBe(422);
    expect(sent.body.error.code).toBe('MODEL_CAPABILITY_UNKNOWN');
    expect(captured.calls).toHaveLength(0);
  });

  it('rejects an oversized encoded body as 413, not as a context error (B09)', async () => {
    const captured = capturingRunner();
    app = await fixture({
      runner: captured.runner,
      limits: { ...DEFAULT_MEDIA_LIMITS, maxRequestBodyBytes: 2_000 },
    });
    const cookie = await identity(app.base);
    const conversationId = await createConversation(app.base, cookie, MODEL_IDS.fast);
    const noisy = await imageBytes(500, 500, { format: 'image/png', noise: true });
    const uploaded = await upload(app.base, cookie, conversationId, noisy, { name: 'noise.png' });
    const sent = await chat(app.base, cookie, {
      content: imageContent(uploaded.body.asset.id),
      conversationId,
      requestId: randomUUID(),
    });
    expect(sent.status).toBe(413);
    expect(sent.body.error.code).toBe('REQUEST_BODY_TOO_LARGE');
    expect(captured.calls).toHaveLength(0);
  });

  it('idempotency: same id with different content conflicts, an exact retry replays (A19)', async () => {
    const captured = capturingRunner();
    app = await fixture({ runner: captured.runner });
    const cookie = await identity(app.base);
    const conversationId = await createConversation(app.base, cookie, MODEL_IDS.fast);
    const png = await imageBytes(48, 48);
    const uploaded = await upload(app.base, cookie, conversationId, png);
    const requestId = randomUUID();
    const first = await chat(app.base, cookie, {
      content: imageContent(uploaded.body.asset.id),
      conversationId,
      requestId,
      turnId: randomUUID(),
    });
    expect(first.status).toBe(200);
    expect(captured.calls).toHaveLength(1);

    const retry = await chat(app.base, cookie, {
      content: imageContent(uploaded.body.asset.id),
      conversationId,
      requestId,
      turnId: randomUUID(),
    });
    expect(retry.status).toBe(200);
    expect(retry.frames.at(-1)?.data.replayed).toBe(true);
    expect(captured.calls).toHaveLength(1);

    const conflict = await chat(app.base, cookie, {
      message: '完全不同的内容',
      conversationId,
      requestId,
      turnId: randomUUID(),
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('request_conflict');
    expect(captured.calls).toHaveLength(1);
  });

  it('a 422 retry after switching models can succeed with the same id (A17)', async () => {
    const captured = capturingRunner();
    app = await fixture({ runner: captured.runner });
    const cookie = await identity(app.base);
    const conversationId = await createConversation(app.base, cookie, MODEL_IDS.companion);
    const uploaded = await upload(app.base, cookie, conversationId, await imageBytes(26, 26));
    const requestId = randomUUID();
    const rejected = await chat(app.base, cookie, {
      content: imageContent(uploaded.body.asset.id),
      conversationId,
      requestId,
    });
    expect(rejected.status).toBe(422);
    await json(app.base, `/api/conversations/${conversationId}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ modelId: MODEL_IDS.fast }),
    });
    const accepted = await chat(app.base, cookie, {
      content: imageContent(uploaded.body.asset.id),
      conversationId,
      requestId,
    });
    expect(accepted.status).toBe(200);
    expect(captured.calls).toHaveLength(1);
  });

  it('keeps a bound image through message deletion rules and refuses a bound draft delete (A20)', async () => {
    const captured = capturingRunner();
    app = await fixture({ runner: captured.runner });
    const cookie = await identity(app.base);
    const conversationId = await createConversation(app.base, cookie, MODEL_IDS.fast);
    const uploaded = await upload(app.base, cookie, conversationId, await imageBytes(30, 20));
    await chat(app.base, cookie, {
      content: imageContent(uploaded.body.asset.id),
      conversationId,
      requestId: randomUUID(),
    });
    const refused = await json(app.base, `/api/media/images/${uploaded.body.asset.id}`, {
      method: 'DELETE',
      cookie,
    });
    expect(refused.status).toBe(409);

    const deleted = await json(app.base, `/api/conversations/${conversationId}`, {
      method: 'DELETE',
      cookie,
    });
    expect(deleted.status).toBe(200);
    expect(await app.store.getMediaAsset(userIdFromCookie(cookie), uploaded.body.asset.id)).toBeNull();
  });

  it('shows a filename as data, not markup, and rejects path-shaped ids (A21)', async () => {
    app = await fixture();
    const cookie = await identity(app.base);
    const conversationId = await createConversation(app.base, cookie, MODEL_IDS.fast);
    const name = '<img src=x onerror=alert(1)>.png';
    const uploaded = await upload(app.base, cookie, conversationId, await imageBytes(12, 12), {
      name,
    });
    expect(uploaded.status).toBe(201);
    expect(uploaded.body.asset.name).toBe(name);
    const preview = await fetch(
      `${app.base}/api/media/images/${uploaded.body.asset.id}`,
      { headers: { cookie } },
    );
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-disposition')).toContain('filename*=');
    expect(preview.headers.get('content-disposition')).not.toContain('<img');

    const traversal = await fetch(`${app.base}/api/media/images/..%2F..%2Fetc%2Fpasswd`, {
      headers: { cookie },
    });
    expect(traversal.status).toBe(404);
  });

  it('runs the same canonical message through the offline second route (A22)', async () => {
    const capture = createFakeVisionCapture();
    const runner: TurnRunner = async function* (agent, message, options) {
      // The service has already planned; the fake route encodes its own wire.
      for await (const event of createFakeVisionTurn({ capture })({
        instructions: agent.instructions,
        input: [
          {
            type: 'message',
            role: 'user',
            content: options?.content?.parts ?? message,
          },
        ],
        tools: [],
        ...(options?.media ? { media: options.media } : {}),
      })) {
        if (event.type === 'text_delta') yield { type: 'text_delta', text: event.text };
        if (event.type === 'done') {
          const text = event.output
            .filter((item) => item.type === 'message')
            .map((item) => item.content)
            .join('');
          yield { type: 'completed', text };
        }
      }
    };
    app = await fixture({
      runner,
      modelProfiles: (id) =>
        id === FAKE_VISION_MODEL_ID ? fakeVisionProfile() : modelProfile(id),
      config: sessionConfig({
        SESSION_PROMPT_RESERVE_TOKENS: '0',
        SESSION_INPUT_BUDGET_TOKENS: '7000',
      }),
    });
    const cookie = await identity(app.base);
    const userId = userIdFromCookie(cookie);
    const conversationId = await createConversation(app.base, cookie, MODEL_IDS.fast);
    // The API deliberately refuses to pin a route that is not in the public
    // catalog; this fixture writes the row directly.
    await app.store.updateConversation(userId, conversationId, {
      modelId: FAKE_VISION_MODEL_ID,
    });
    const uploaded = await upload(app.base, cookie, conversationId, await imageBytes(80, 40));
    const sent = await chat(app.base, cookie, {
      content: imageContent(uploaded.body.asset.id),
      conversationId,
      requestId: randomUUID(),
    });
    expect(sent.status).toBe(200);
    expect(capture.requests).toHaveLength(1);
    expect(capture.requests[0]?.protocol).toBe('fake-tiles/1');
    expect(capture.requests[0]?.tiles[0]?.decodedWidth).toBe(80);
  });
});
