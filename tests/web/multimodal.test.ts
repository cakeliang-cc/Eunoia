/**
 * The composer's image path, driven through the real `web/app.js`.
 *
 * The DOM shim cannot prove layout, but it can prove the state machine: an
 * image is uploaded once, the send carries an ordered block list, a capability
 * mismatch blocks the send without deleting the picture, history renders image
 * metadata, and removing a draft releases it.
 */

import { describe, expect, it } from 'vitest';
import { boot } from './harness.ts';
import type { Frame } from './harness.ts';

const ASSET = '33333333-3333-4333-8333-333333333333';
const CONVERSATION = '44444444-4444-4444-8444-444444444444';

const CAPABILITIES = {
  version: 1,
  defaultModelId: 'deepseek-v4-pro',
  limits: {
    maxImagesPerMessage: 5,
    maxImageBytes: 10 * 1024 * 1024,
    maxMessageImageBytes: 20 * 1024 * 1024,
    maxDimension: 8192,
    maxPixels: 40000000,
    maxConcurrentDecodes: 2,
    requestLongEdge: 2048,
    maxRequestBodyBytes: 32 * 1024 * 1024,
  },
  supportedMediaTypes: ['image/jpeg', 'image/png', 'image/webp'],
  models: [
    {
      id: 'deepseek-v4-pro',
      displayName: 'DeepSeek V4 Pro',
      available: true,
      input: { text: 'supported', image: 'unsupported' },
      output: { text: 'supported' },
      tools: 'supported',
      imagePolicyId: null,
      policyRevision: 'text',
      image: null,
    },
    {
      id: 'deepseek-flash',
      displayName: 'DeepSeek Flash',
      available: true,
      input: { text: 'supported', image: 'supported' },
      output: { text: 'supported' },
      tools: 'supported',
      imagePolicyId: 'deepseek-flash-v41',
      policyRevision: 'vision',
      image: null,
    },
  ],
};

const ASSET_VIEW = {
  id: ASSET,
  name: 'a.png',
  mediaType: 'image/png',
  bytes: 1234,
  width: 320,
  height: 200,
  status: 'pending',
  url: `/api/media/images/${ASSET}`,
};

function pngFile(name = 'a.png'): File {
  return new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, {
    type: 'image/png',
  });
}

function routes(options: { imageModel?: boolean; defaultModel?: string } = {}) {
  return {
    'GET /api/media/capabilities': {
      json: {
        ...CAPABILITIES,
        ...(options.defaultModel ? { defaultModelId: options.defaultModel } : {}),
        models: options.imageModel
          ? CAPABILITIES.models
          : CAPABILITIES.models.map((model) => ({ ...model, input: { ...model.input, image: 'unsupported' } })),
      },
    },
    'POST /api/conversations': {
      json: { conversation: { id: CONVERSATION } },
    },
    [`POST /api/media/images?conversationId=${CONVERSATION}&name=a.png`]: {
      status: 201,
      json: { asset: ASSET_VIEW },
    },
    [`DELETE /api/media/images/${ASSET}`]: { json: { deleted: ASSET } },
    [`PATCH /api/conversations/${CONVERSATION}`]: {
      json: { conversation: { id: CONVERSATION, modelId: 'deepseek-flash' } },
    },
  };
}

async function pickImage(harness: Awaited<ReturnType<typeof boot>>): Promise<void> {
  const input = harness.element('image-input');
  input.files = [pngFile()];
  const listener = input.listeners.change?.[0];
  if (!listener) throw new Error('the image input no longer listens for change');
  listener({});
  await harness.settle();
  await harness.settle();
}

async function submit(harness: Awaited<ReturnType<typeof boot>>, text = ''): Promise<void> {
  harness.element('input').value = text;
  const submitHandler = harness.element('composer').listeners.submit?.[0];
  if (!submitHandler) throw new Error('the composer no longer listens for submit');
  submitHandler({ preventDefault() {} });
  await harness.settle();
  await harness.settle();
}

describe('image drafts and the send payload', () => {
  it('uploads a picked image and sends an ordered content block', async () => {
    const frames: Frame[] = [
      { type: 'text_delta', text: '看到了。' },
      { type: 'completed', text: '看到了。', conversationId: CONVERSATION, messageId: 'm1' },
    ];
    const harness = await boot({
      frames,
      routes: routes({ imageModel: true, defaultModel: 'deepseek-flash' }),
    });
    await pickImage(harness);

    const uploads = harness.requests.filter((request) => request.url.startsWith('/api/media/images?'));
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.method).toBe('POST');
    expect(uploads[0]?.headers['Content-Type'] ?? uploads[0]?.headers['content-type']).toBe(
      'image/png',
    );

    await submit(harness);

    const chat = harness.requests.find((request) => request.url === '/api/chat');
    expect(chat?.body?.message).toBeUndefined();
    expect(chat?.body?.content).toEqual({
      version: 1,
      parts: [{ type: 'image', assetId: ASSET }],
    });
    // The optimistic user turn shows the picture, not a filename placeholder.
    const userStrip = harness.transcript
      .children.filter((node) => node.classList.contains('turn') && node.classList.contains('user'))
      .at(-1)
      ?.querySelector('.msg-media');
    const img = userStrip?.children[0]?.children.find((node) => node.tagName === 'img');
    expect(img?.src).toBe(`/api/media/images/${ASSET}`);
  });

  it('keeps text and image in the order the client assembled them', async () => {
    const harness = await boot({
      frames: [{ type: 'completed', text: 'ok', conversationId: CONVERSATION }],
      routes: routes({ imageModel: true, defaultModel: 'deepseek-flash' }),
    });
    await pickImage(harness);
    await submit(harness, '这是什么');

    const chat = harness.requests.find((request) => request.url === '/api/chat');
    expect(chat?.body?.content).toEqual({
      version: 1,
      parts: [
        { type: 'text', text: '这是什么' },
        { type: 'image', assetId: ASSET },
      ],
    });
  });

  it('removing a ready draft releases it on the server', async () => {
    const harness = await boot({ routes: routes({ imageModel: true }) });
    await pickImage(harness);
    const card = harness.element('media-row').children[0];
    const target = card?.children.find((child) => child.tagName === 'button');
    expect(target).toBeTruthy();
    target?.onclick?.();
    await harness.settle();
    const deletes = harness.requests.filter((request) => request.url === `/api/media/images/${ASSET}`);
    expect(deletes.some((request) => request.method === 'DELETE')).toBe(true);
  });

  it('reuses the same request id and body when a failed send is retried (A17)', async () => {
    const harness = await boot({
      frames: [{ type: 'error', message: '网络中断', retryable: true }],
      routes: routes({ imageModel: true, defaultModel: 'deepseek-flash' }),
    });
    await submit(harness, '你好');
    const first = harness.requests.filter((request) => request.url === '/api/chat');
    expect(first).toHaveLength(1);

    const assistant = harness.transcript.children
      .filter((node) => node.classList.contains('turn') && node.classList.contains('assistant'))
      .at(-1);
    const body = assistant?.child('bubble')?.child('text');
    const retry = body?.children.find((node) => node.textContent === '重试');
    expect(retry).toBeTruthy();
    retry?.onclick?.();
    await harness.settle();
    await harness.settle();

    const all = harness.requests.filter((request) => request.url === '/api/chat');
    expect(all).toHaveLength(2);
    expect(all[0]?.body?.requestId).toBe(all[1]?.body?.requestId);
    expect(all[0]?.body?.message).toBe(all[1]?.body?.message);
  });

  it('clears the staged image when the person opens another conversation (A18)', async () => {
    const B = '55555555-5555-4555-8555-555555555555';
    const harness = await boot({
      routes: {
        ...routes({ imageModel: true, defaultModel: 'deepseek-flash' }),
        'GET /api/conversations': {
          json: {
            conversations: [
              { id: CONVERSATION, title: 'A', startedAt: new Date().toISOString() },
              { id: B, title: 'B', startedAt: new Date().toISOString() },
            ],
          },
        },
        [`GET /api/conversations/${CONVERSATION}/messages`]: {
          json: { messages: [{ id: 'a1', role: 'assistant', content: 'A', createdAt: new Date().toISOString() }] },
        },
        [`GET /api/conversations/${B}/messages`]: {
          json: { messages: [{ id: 'b1', role: 'assistant', content: 'B', createdAt: new Date().toISOString() }] },
        },
      },
    });
    await pickImage(harness);
    expect(harness.element('media-row').children.length).toBeGreaterThan(0);

    const rows = harness.element('history-list').find((node) =>
      node.classList.contains('thread'),
    );
    const rowB = rows.find((node) => node.textContent.includes('B'));
    expect(rowB).toBeTruthy();
    await rowB?.onclick?.();
    await harness.settle();
    expect(harness.element('media-row').hidden).toBe(true);
  });

  it('blocks a send on a text-only model and keeps the picture', async () => {
    const harness = await boot({ routes: routes({ imageModel: false }) });
    await pickImage(harness);
    expect(harness.element('media-row').querySelector('.media-warning')).toBeTruthy();
    await submit(harness);
    expect(harness.requests.some((request) => request.url === '/api/chat')).toBe(false);
    expect(harness.transcript.children.some((node) => node.classList.contains('notice'))).toBe(true);
    // The draft is still there: switching models must not require re-selecting.
    expect(harness.element('media-row').querySelector('.media-card')).toBeTruthy();
  });
});

describe('history and preview', () => {
  it('renders stored image blocks with authorized metadata', async () => {
    const harness = await boot({
      stored: CONVERSATION,
      routes: {
        ...routes({ imageModel: true }),
        [`GET /api/conversations/${CONVERSATION}/messages`]: {
          json: {
            modelId: 'deepseek-flash',
            messages: [
              {
                id: 'm1',
                role: 'user',
                content: '',
                createdAt: new Date().toISOString(),
                contentParts: {
                  version: 1,
                  parts: [
                    {
                      type: 'image',
                      assetId: ASSET,
                      image: ASSET_VIEW,
                    },
                  ],
                },
              },
              {
                id: 'm2',
                role: 'assistant',
                content: '看到了。',
                createdAt: new Date().toISOString(),
              },
            ],
          },
        },
      },
    });
    const strip = harness.transcript.querySelector('.msg-media');
    const image = strip?.children[0]?.children.find((node) => node.tagName === 'img');
    expect(image?.src).toBe(`/api/media/images/${ASSET}`);
    expect(image?.alt).toBe('a.png');
  });

  it('opens a same-origin preview and closes it', async () => {
    const harness = await boot({
      stored: CONVERSATION,
      routes: {
        ...routes({ imageModel: true }),
        [`GET /api/conversations/${CONVERSATION}/messages`]: {
          json: {
            messages: [
              {
                id: 'm1',
                role: 'user',
                content: '',
                createdAt: new Date().toISOString(),
                contentParts: {
                  version: 1,
                  parts: [{ type: 'image', assetId: ASSET, image: ASSET_VIEW }],
                },
              },
            ],
          },
        },
      },
    });
    const button = harness.transcript.querySelector('.msg-media')?.children[0];
    button?.onclick?.();
    const overlay = harness.body.querySelector('.image-preview');
    expect(overlay).toBeTruthy();
    const close = overlay?.querySelector('.preview-close');
    close?.onclick?.();
    expect(harness.body.querySelector('.image-preview')).toBeNull();
  });
});
