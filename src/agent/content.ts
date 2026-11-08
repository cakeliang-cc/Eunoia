/**
 * Ordered user content: text and images in one versioned structure.
 *
 * The order is the meaning. "第一张是设计稿，第二张是实现，请问区别" is a
 * different request from the same text with the images swapped, so neither the
 * store nor an adapter may collect the text and the images separately and put
 * them back in a different arrangement.
 *
 * A message keeps two representations, and only one of them is authoritative:
 *
 *   - `parts` — the versioned block list. This is the fact.
 *   - `content` — a plain-text projection, derived from the text blocks by the
 *     same storage operation. It exists for the old transcript endpoint, search
 *     and export, and a client must never be able to write it independently.
 *
 * Images are referenced by an opaque `assetId`. The bytes, the MIME type and the
 * provider's file id never appear here: those are media-storage and adapter
 * facts, and a stored `image_url` would make the transcript depend on a provider
 * this project intends to be replaceable.
 *
 * Leading and trailing whitespace on a text block is trimmed and blocks that
 * become empty are dropped. That keeps the legacy `message` behaviour (the old
 * request trimmed its text) without inventing a user message for an image-only
 * turn.
 */

/** An opaque media id. It is not a path and not a provider file id. */
export type AssetId = string;

export interface TextContentPart {
  readonly type: 'text';
  readonly text: string;
}

/**
 * Authorized display metadata for an image block on the *read* surface.
 *
 * It is absent in storage and ignored by canonical hashing. A client renders
 * what the server authorized; it never derives a preview URL or a capability
 * from the id.
 */
export interface MessageImageMeta {
  readonly id: AssetId;
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly status: string;
  readonly url?: string;
}

export interface ImageContentPart {
  readonly type: 'image';
  readonly assetId: AssetId;
  readonly image?: MessageImageMeta;
}

export type InputPart = TextContentPart | ImageContentPart;

export interface UserContentV1 {
  readonly version: 1;
  readonly parts: readonly InputPart[];
}

/** What the model port accepts for a user message. */
export type ModelMessageContent = string | readonly InputPart[];

export const USER_CONTENT_VERSION = 1;

export interface ContentLimits {
  /** Text across the whole message; the same number the legacy field used. */
  readonly maxTextChars: number;
  /** Images in one user message. */
  readonly maxImages: number;
}

export const DEFAULT_CONTENT_LIMITS: ContentLimits = {
  maxTextChars: 8_000,
  maxImages: 5,
};

export type ParsedContent =
  | { readonly ok: true; readonly value: UserContentV1 }
  | { readonly ok: false; readonly error: string; readonly code: ContentErrorCode };

export type ContentErrorCode =
  | 'CONTENT_INVALID'
  | 'CONTENT_VERSION_UNSUPPORTED'
  | 'CONTENT_EMPTY'
  | 'CONTENT_TOO_LARGE'
  | 'CONTENT_IMAGE_LIMIT'
  | 'CONTENT_ASSET_ID_INVALID';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAssetId(value: unknown): value is AssetId {
  return typeof value === 'string' && UUID.test(value);
}

/** Wrap plain text as a one-block content value. */
export function textContent(text: string): UserContentV1 {
  return { version: USER_CONTENT_VERSION, parts: [{ type: 'text', text }] };
}

/** A legacy stored message, deterministically interpreted as one text block. */
export function legacyContent(message: string): UserContentV1 {
  return textContent(message);
}

function fail(code: ContentErrorCode, error: string): ParsedContent {
  return { ok: false, code, error };
}

/**
 * Validate and normalise a client-supplied `content` object.
 *
 * This is structural validation only. Whether an asset exists, belongs to the
 * conversation and can be decoded is decided later, against storage; a parser
 * that claimed otherwise would be trusting the request.
 */
export function parseUserContent(
  raw: unknown,
  limits: ContentLimits = DEFAULT_CONTENT_LIMITS,
): ParsedContent {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail('CONTENT_INVALID', 'field "content" must be an object');
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== USER_CONTENT_VERSION) {
    return fail(
      'CONTENT_VERSION_UNSUPPORTED',
      `content.version must be ${USER_CONTENT_VERSION}`,
    );
  }
  if (!Array.isArray(record.parts)) {
    return fail('CONTENT_INVALID', 'content.parts must be an array');
  }

  const parts: InputPart[] = [];
  let textChars = 0;
  let images = 0;

  for (const [index, entry] of record.parts.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return fail('CONTENT_INVALID', `content.parts[${index}] must be an object`);
    }
    const part = entry as Record<string, unknown>;
    if (part.type === 'text') {
      if (typeof part.text !== 'string') {
        return fail('CONTENT_INVALID', `content.parts[${index}].text must be a string`);
      }
      const text = part.text.trim();
      if (text.length === 0) continue;
      textChars += text.length;
      if (textChars > limits.maxTextChars) {
        return fail('CONTENT_TOO_LARGE', `content text exceeds ${limits.maxTextChars} characters`);
      }
      parts.push({ type: 'text', text });
      continue;
    }
    if (part.type === 'image') {
      if (!isAssetId(part.assetId)) {
        return fail(
          'CONTENT_ASSET_ID_INVALID',
          `content.parts[${index}].assetId must be a media asset id`,
        );
      }
      images += 1;
      if (images > limits.maxImages) {
        return fail('CONTENT_IMAGE_LIMIT', `content allows at most ${limits.maxImages} images`);
      }
      parts.push({ type: 'image', assetId: part.assetId });
      continue;
    }
    return fail('CONTENT_INVALID', `content.parts[${index}].type must be "text" or "image"`);
  }

  if (parts.length === 0) {
    return fail('CONTENT_EMPTY', 'content must contain text or an image');
  }

  return { ok: true, value: { version: USER_CONTENT_VERSION, parts } };
}

/** The plain-text projection. Images contribute nothing: they are not text. */
export function contentText(content: UserContentV1): string {
  return content.parts
    .filter((part): part is TextContentPart => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

/** Ordered image references, duplicates preserved. */
export function contentImageIds(content: UserContentV1): AssetId[] {
  return content.parts
    .filter((part): part is ImageContentPart => part.type === 'image')
    .map((part) => part.assetId);
}

export function contentHasImages(content: UserContentV1): boolean {
  return content.parts.some((part) => part.type === 'image');
}

/**
 * The structured content of a stored message.
 *
 * A null column is an old row. It is interpreted deterministically as one text
 * block rather than as "no content", which is the only reading that keeps a
 * pre-multimodal transcript usable.
 */
export function messageContent(message: {
  readonly content: string;
  readonly contentParts?: UserContentV1 | null;
}): UserContentV1 {
  return message.contentParts ?? legacyContent(message.content);
}

/** The same canonical value a request digest is computed over. */
export function canonicalContent(content: UserContentV1): unknown {
  return {
    version: content.version,
    parts: content.parts.map((part) =>
      part.type === 'text' ? { type: 'text', text: part.text } : { type: 'image', assetId: part.assetId },
    ),
  };
}

/**
 * Convert a stored row to what the model port takes.
 *
 * Assistant and system rows stay plain strings: their role constraints are not
 * an arbitrary media array, and widening every role would be the change this
 * design deliberately avoids.
 */
export function modelContentFor(message: {
  readonly role: 'user' | 'assistant' | 'system';
  readonly content: string;
  readonly contentParts?: UserContentV1 | null;
}): ModelMessageContent {
  if (message.role !== 'user') return message.content;
  if (!message.contentParts) return message.content;
  return message.contentParts.parts;
}
