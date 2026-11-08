/**
 * S01–S03: the real DeepSeek Flash vision path, opt-in.
 *
 *     RUN_SMOKE=1 DEEPSEEK_API_KEY=... npx vitest run tests/smoke/live-vision.test.ts
 *
 * These are wiring checks, not a visual benchmark. They prove three things the
 * offline suite cannot: an uploaded image reaches the provider as image content,
 * a reordered pair produces a reordered answer, and regeneration after a process
 * restart resolves the same stored asset. A wrong answer is reported as a model
 * response, not as "the frontend is done".
 *
 * No Base64, key or host path is written to the result file.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createApp } from '../../src/api/server.ts';
import { openSqliteStore } from '../../src/db/sqlite-store.ts';
import { FileMediaBlobStore } from '../../src/media/blob-store.ts';
import { MediaService } from '../../src/media/service.ts';
import { DEFAULT_MEDIA_LIMITS } from '../../src/media/limits.ts';
import { DecodeGate } from '../../src/media/decode.ts';
import { defaultImagePolicies } from '../../src/provider/image-policy-registry.ts';
import { providerFor } from '../../src/provider/index.ts';
import { SessionService } from '../../src/session/service.ts';
import { sessionConfig } from '../../src/session/config.ts';
import { MODEL_IDS } from '../../src/config.ts';
import { modelProfile } from '../../src/models/registry.ts';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const enabled = process.env.RUN_SMOKE === '1' && Boolean(process.env.DEEPSEEK_API_KEY);

const COLORS = [
  { name: '蓝色', css: '#1e6fd9' },
  { name: '绿色', css: '#1f9d55' },
  { name: '红色', css: '#d93a3a' },
] as const;

async function digitImage(digit: number, color = '#111111'): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="420">
    <rect width="420" height="420" fill="#ffffff"/>
    <text x="210" y="320" text-anchor="middle" font-family="Helvetica, Arial, sans-serif"
      font-size="360" font-weight="700" fill="${color}">${digit}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function codeImage(code: string, color: string): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="420">
    <rect width="800" height="420" fill="${color}"/>
    <text x="400" y="300" text-anchor="middle" font-family="Helvetica, Arial, sans-serif"
      font-size="240" font-weight="700" fill="#ffffff">${code}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function makeServer(root: string): Promise<{
  server: Server;
  base: string;
  close: () => Promise<void>;
}> {
  const store = openSqliteStore(join(root, 'live.sqlite'));
  const config = sessionConfig({ SESSION_PROMPT_RESERVE_TOKENS: '0' });
  const media = new MediaService({
    store,
    blobs: new FileMediaBlobStore(join(root, 'media')),
    limits: DEFAULT_MEDIA_LIMITS,
    gate: new DecodeGate(2),
  });
  const server = createApp({
    store,
    sessions: new SessionService(store, {
      config,
      model: modelProfile(MODEL_IDS.fast),
      summaryModel: modelProfile(MODEL_IDS.fast),
      resolveModel: modelProfile,
    }),
    media,
    imagePolicies: defaultImagePolicies(),
    mediaLimits: DEFAULT_MEDIA_LIMITS,
    sessionConfig: config,
    modelProvider: providerFor('deepseek').createModelProvider(),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    base: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      await store.close();
    },
  };
}

/**
 * A stable caller identity.
 *
 * `SINGLE_USER_ID` is commonly set in a local `.env`, in which case the server
 * deliberately does not mint a cookie and every request is that one person. The
 * header form is honoured either way, so the smoke does not depend on which mode
 * the deployment is in.
 */
async function identity(): Promise<string> {
  return `x-user-id=${randomUUID()}`;
}

function authHeader(identityValue: string): Record<string, string> {
  if (identityValue.startsWith('x-user-id=')) {
    return { 'x-user-id': identityValue.slice('x-user-id='.length) };
  }
  return { cookie: identityValue };
}

async function createConversation(base: string, cookie: string, modelId: string): Promise<string> {
  const response = await fetch(`${base}/api/conversations`, {
    method: 'POST',
    headers: { ...authHeader(cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ modelId }),
  });
  return ((await response.json()) as { conversation: { id: string } }).conversation.id;
}

async function upload(
  base: string,
  cookie: string,
  conversationId: string,
  bytes: Buffer,
  name: string,
): Promise<string> {
  const response = await fetch(
    `${base}/api/media/images?conversationId=${conversationId}&name=${encodeURIComponent(name)}`,
    { method: 'POST', headers: { ...authHeader(cookie), 'content-type': 'image/png' }, body: bytes },
  );
  const text = await response.text();
  expect(response.status, text).toBe(201);
  return (JSON.parse(text) as { asset: { id: string } }).asset.id;
}

interface Frame {
  readonly event: string;
  readonly data: Record<string, unknown>;
}

async function chat(
  base: string,
  cookie: string,
  body: Record<string, unknown>,
): Promise<{ status: number; text: string; frames: Frame[]; body: unknown; usage: unknown }> {
  const response = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { ...authHeader(cookie), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    return {
      status: response.status,
      text: '',
      frames: [],
      body: await response.json(),
      usage: null,
    };
  }
  const raw = await response.text();
  const frames = raw
    .split('\n\n')
    .filter((block) => block.trim().length > 0 && !block.startsWith(':'))
    .map((block) => ({
      event: /^event: (.*)$/m.exec(block)?.[1] ?? '',
      data: JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? '{}') as Record<string, unknown>,
    }));
  const completed = frames.find((frame) => frame.event === 'completed');
  return {
    status: response.status,
    text: String(completed?.data.text ?? ''),
    frames,
    body: null,
    usage: completed?.data.usage ?? null,
  };
}

async function regenerate(
  base: string,
  cookie: string,
  conversationId: string,
): Promise<{ status: number; text: string }> {
  const response = await fetch(`${base}/api/chat/regenerate`, {
    method: 'POST',
    headers: { ...authHeader(cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId, requestId: randomUUID(), turnId: randomUUID() }),
  });
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    return { status: response.status, text: '' };
  }
  const raw = await response.text();
  expect(raw).toContain('event: completed');
  const match = /"text":"((?:[^"\\]|\\.)*)"/.exec(raw.split('event: completed')[1] ?? '');
  return { status: response.status, text: match ? JSON.parse(`"${match[1]}"`) : '' };
}

let scratch: string | null = null;
const evidence: Record<string, unknown>[] = [];

afterAll(async () => {
  if (evidence.length > 0) {
    await mkdir('docs/captures', { recursive: true });
    await writeFile('docs/captures/live-vision.json', `${JSON.stringify(evidence, null, 2)}\n`);
  }
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = null;
});

describe.skipIf(!enabled)('live vision smoke (S01–S03)', () => {
  it(
    'S01 reads digits and a large colour block from a generated image',
    async () => {
      scratch = await mkdtemp(join(tmpdir(), 'eunoia-live-vision-'));
      const app = await makeServer(scratch);
      try {
        const cookie = await identity();
        const conversationId = await createConversation(app.base, cookie, MODEL_IDS.fast);
        const code = String(1000 + Math.floor(Math.random() * 9000));
        const color = COLORS[Math.floor(Math.random() * COLORS.length)]!;
        const id = await upload(
          app.base,
          cookie,
          conversationId,
          await codeImage(code, color.css),
          'challenge.png',
        );
        const result = await chat(app.base, cookie, {
          content: {
            version: 1,
            parts: [
              { type: 'text', text: '图里的四位数字是什么？背景主要是什么颜色？只回答数字和颜色。' },
              { type: 'image', assetId: id },
            ],
          },
          conversationId,
          requestId: randomUUID(),
        });
        expect(result.status).toBe(200);
        evidence.push({
          test: 'S01',
          model: MODEL_IDS.fast,
          code,
          color: color.name,
          reply: result.text,
          usage: result.usage,
        });
        expect(result.text, 'the digits must appear in the answer').toContain(code);
        expect(result.text.toLowerCase()).toMatch(/蓝|blue|绿|green|红|red/);
      } finally {
        await app.close();
      }
    },
    180_000,
  );

  it(
    'S02 changes the answer when two images are reordered',
    async () => {
      scratch = await mkdtemp(join(tmpdir(), 'eunoia-live-order-'));
      const app = await makeServer(scratch);
      try {
        const cookie = await identity();
        const pair = async (firstDigit: number, secondDigit: number) => {
          // A fresh conversation per order: otherwise the previous pair remains
          // in the replay window and the answer legitimately contains four
          // digits, which tests history rather than order.
          const conversation = await createConversation(app.base, cookie, MODEL_IDS.fast);
          const first = await upload(app.base, cookie, conversation, await digitImage(firstDigit), 'a.png');
          const second = await upload(app.base, cookie, conversation, await digitImage(secondDigit), 'b.png');
          const result = await chat(app.base, cookie, {
            content: {
              version: 1,
              parts: [
                { type: 'text', text: '按顺序说出两张图里的数字，只用数字和顺序。' },
                { type: 'image', assetId: first },
                { type: 'image', assetId: second },
              ],
            },
            conversationId: conversation,
            requestId: randomUUID(),
          });
          expect(result.status).toBe(200);
          return result;
        };
        const forward = await pair(2, 7);
        const swapped = await pair(7, 2);
        evidence.push({
          test: 'S02',
          model: MODEL_IDS.fast,
          forward: forward.text,
          swapped: swapped.text,
          usageForward: forward.usage,
          usageSwapped: swapped.usage,
        });
        const digits = (value: string) => value.replace(/[^0-9]/g, '');
        expect(digits(forward.text).startsWith('27')).toBe(true);
        expect(digits(swapped.text).startsWith('72')).toBe(true);
      } finally {
        await app.close();
      }
    },
    240_000,
  );

  it(
    'S03 regenerates an image turn after a process restart, then a text route refuses it',
    async () => {
      scratch = await mkdtemp(join(tmpdir(), 'eunoia-live-restart-'));
      const first = await makeServer(scratch);
      let conversationId = '';
      let cookie = '';
      let assetId = '';
      try {
        cookie = await identity();
        conversationId = await createConversation(first.base, cookie, MODEL_IDS.fast);
        assetId = await upload(
          first.base,
          cookie,
          conversationId,
          await digitImage(7, '#1f9d55'),
          'seven.png',
        );
        const sent = await chat(first.base, cookie, {
          content: {
            version: 1,
            parts: [
              { type: 'text', text: '这张图里是哪个数字？' },
              { type: 'image', assetId },
            ],
          },
          conversationId,
          requestId: randomUUID(),
        });
        expect(sent.status).toBe(200);
        expect(sent.text).toContain('7');
      } finally {
        await first.close();
      }

      const second = await makeServer(scratch);
      try {
        const regenerated = await regenerate(second.base, cookie, conversationId);
        expect(regenerated.status).toBe(200);
        // The image must be in the rerun, not merely a non-empty answer. A text
        // answer claiming no picture is the failure this asserts against.
        expect(regenerated.text).toContain('7');
        expect(regenerated.text).not.toMatch(/没有图片|没收到图片|只有文字/);

        // The same asset is still resolvable, and a text-only route must refuse
        // the history image with a structured 422 rather than dropping it.
        await fetch(`${second.base}/api/conversations/${conversationId}`, {
          method: 'PATCH',
          headers: { ...authHeader(cookie), 'content-type': 'application/json' },
          body: JSON.stringify({ modelId: MODEL_IDS.companion }),
        });
        const refused = await chat(second.base, cookie, {
          message: '继续说说',
          conversationId,
          requestId: randomUUID(),
        });
        expect(refused.status).toBe(422);
        evidence.push({
          test: 'S03',
          reply: regenerated.text,
          refusedStatus: refused.status,
          refusedBody: refused.body,
        });
      } finally {
        await second.close();
      }
    },
    240_000,
  );
});
