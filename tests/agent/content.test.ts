/**
 * Ordered content blocks.
 *
 * The order is what a request means, so the parser and the projection are
 * pinned: text is trimmed, empty blocks disappear, images keep their position,
 * and an unknown version is refused rather than treated as empty text.
 */

import { describe, expect, it } from 'vitest';
import type { UserContentV1 } from '../../src/agent/content.ts';
import {
  canonicalContent,
  contentHasImages,
  contentImageIds,
  contentText,
  legacyContent,
  messageContent,
  parseUserContent,
  textContent,
} from '../../src/agent/content.ts';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

describe('user content v1', () => {
  it('keeps an interleaved order exactly', () => {
    const parsed = parseUserContent({
      version: 1,
      parts: [
        { type: 'text', text: '第一张' },
        { type: 'image', assetId: ID_A },
        { type: 'text', text: '第二张' },
        { type: 'image', assetId: ID_B },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.parts.map((part) => part.type)).toEqual([
      'text',
      'image',
      'text',
      'image',
    ]);
    expect(contentImageIds(parsed.value)).toEqual([ID_A, ID_B]);
    // The projection contains text only; it never cites an id or base64.
    expect(contentText(parsed.value)).toBe('第一张\n第二张');
    expect(contentHasImages(parsed.value)).toBe(true);
  });

  it('accepts an image-only message and derives an empty projection', () => {
    const parsed = parseUserContent({
      version: 1,
      parts: [{ type: 'image', assetId: ID_A }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(contentText(parsed.value)).toBe('');
    expect(parsed.value.parts).toHaveLength(1);
  });

  it('trims text blocks and drops the ones that become empty', () => {
    const parsed = parseUserContent({
      version: 1,
      parts: [
        { type: 'text', text: '   ' },
        { type: 'text', text: '  你好  ' },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.parts).toEqual([{ type: 'text', text: '你好' }]);
  });

  it('refuses an unsupported version, a bad id, and an empty structure', () => {
    expect(parseUserContent({ version: 2, parts: [] })).toMatchObject({
      ok: false,
      code: 'CONTENT_VERSION_UNSUPPORTED',
    });
    expect(
      parseUserContent({ version: 1, parts: [{ type: 'image', assetId: '../../etc/passwd' }] }),
    ).toMatchObject({ ok: false, code: 'CONTENT_ASSET_ID_INVALID' });
    expect(parseUserContent({ version: 1, parts: [] })).toMatchObject({
      ok: false,
      code: 'CONTENT_EMPTY',
    });
    expect(
      parseUserContent({ version: 1, parts: [{ type: 'system', text: 'x' }] }),
    ).toMatchObject({ ok: false, code: 'CONTENT_INVALID' });
  });

  it('enforces the text and image limits', () => {
    expect(
      parseUserContent(
        { version: 1, parts: [{ type: 'text', text: 'x'.repeat(11) }] },
        { maxTextChars: 10, maxImages: 1 },
      ),
    ).toMatchObject({ ok: false, code: 'CONTENT_TOO_LARGE' });
    expect(
      parseUserContent(
        {
          version: 1,
          parts: [
            { type: 'image', assetId: ID_A },
            { type: 'image', assetId: ID_B },
          ],
        },
        { maxTextChars: 10, maxImages: 1 },
      ),
    ).toMatchObject({ ok: false, code: 'CONTENT_IMAGE_LIMIT' });
  });

  it('reads an old null column as one text block, deterministically', () => {
    const old = messageContent({ content: '旧消息', contentParts: null });
    expect(old).toEqual(legacyContent('旧消息'));
    const structured = messageContent({
      content: 'ignored projection',
      contentParts: textContent('结构化'),
    });
    expect(contentText(structured)).toBe('结构化');
  });

  it('hashes only the canonical blocks, not display metadata', () => {
    const content: UserContentV1 = {
      version: 1,
      parts: [
        { type: 'text', text: 'hi' },
        {
          type: 'image',
          assetId: ID_A,
          image: {
            id: ID_A,
            name: 'display only',
            mediaType: 'image/png',
            bytes: 1,
            width: 1,
            height: 1,
            status: 'bound',
            url: '/api/media/images/x',
          },
        },
      ],
    };
    expect(JSON.stringify(canonicalContent(content))).not.toContain('display only');
    expect(JSON.stringify(canonicalContent(content))).not.toContain('/api/media');
  });
});
