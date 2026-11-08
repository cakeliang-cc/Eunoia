/**
 * The media layer's durable vocabulary.
 *
 * An image asset is private, immutable storage plus metadata. "Immutable" is the
 * property the replay path depends on: regenerating a turn must send the bytes
 * that were uploaded, not whatever a same-named file in the workspace says
 * today. The original bytes are kept as received; derived variants are separate
 * records with their own digest, dimensions and processing policy, so a budget
 * calculation can never be about one image while the request sends another.
 *
 * The record deliberately contains storage keys rather than URLs. A public URL
 * for a private image is a capability leak; the only address a client sees is an
 * opaque id behind an authorization check.
 */

/** The static formats phase one accepts. SVG, animation, PDF and A/V do not pass. */
export const IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

export function isImageMediaType(value: unknown): value is ImageMediaType {
  return typeof value === 'string' && (IMAGE_MEDIA_TYPES as readonly string[]).includes(value);
}

/**
 * `pending`  — uploaded, not referenced by a message. A draft can be deleted.
 * `bound`    — referenced by at least one message.
 * `released` — its last message was deleted; bytes are kept for the grace window
 *              so a cleanup can be retried, then removed.
 */
export type MediaAssetStatus = 'pending' | 'bound' | 'released';

export interface ImageVariant {
  /** Storage key under the media root. Never sent to a client. */
  readonly key: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly sha256: string;
  /** Decoder/encoder revision, so a cache can be invalidated honestly. */
  readonly processorVersion: string;
  /** Request-size policy revision. */
  readonly policyRevision: string;
}

export interface ImageAsset {
  readonly id: string;
  readonly userId: string;
  readonly conversationId: string;
  /** The display name the person chose. Sanitised, never a path. */
  readonly name: string;
  readonly mediaType: ImageMediaType;
  /** Raw uploaded bytes. */
  readonly bytes: number;
  /** Oriented (EXIF applied) dimensions of the original. */
  readonly width: number;
  readonly height: number;
  /** SHA-256 of the raw bytes. This is the immutable identity. */
  readonly sha256: string;
  /** Key of the raw original. */
  readonly storageKey: string;
  /** Orientation-applied, metadata-stripped full-size image. */
  readonly normalized: ImageVariant;
  /** What a model request actually carries; dimensions drive token counting. */
  readonly request: ImageVariant;
  readonly status: MediaAssetStatus;
  readonly leaseExpiresAt: Date | null;
  readonly createdAt: Date;
}

/** The subset a client may see. No keys, no paths, no digests. */
export interface ImageAssetView {
  readonly id: string;
  readonly name: string;
  readonly mediaType: ImageMediaType;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly status: MediaAssetStatus;
  /** Same-origin preview path, present only on the message-read surface. */
  readonly url?: string;
}

/** The limits the server publishes to the client. */
export interface MediaLimits {
  readonly maxImagesPerMessage: number;
  /** Raw bytes per uploaded image. */
  readonly maxImageBytes: number;
  /** Raw bytes of all images in one message. */
  readonly maxMessageImageBytes: number;
  readonly maxDimension: number;
  readonly maxPixels: number;
  /** How many decodes may run at once. */
  readonly maxConcurrentDecodes: number;
  /** Request variant long edge. Not a token rule; a transport/product rule. */
  readonly requestLongEdge: number;
  /** Final JSON request body ceiling for an inline-image request. */
  readonly maxRequestBodyBytes: number;
  /** Unreferenced drafts and released assets older than this are collectable. */
  readonly unboundGraceMs: number;
  /** How long a request holds a resource before a crash can free it. */
  readonly leaseMs: number;
}

export function toAssetView(asset: ImageAsset, options: { readonly withUrl?: boolean } = {}): ImageAssetView {
  return {
    id: asset.id,
    name: asset.name,
    mediaType: asset.mediaType,
    bytes: asset.bytes,
    width: asset.width,
    height: asset.height,
    status: asset.status,
    ...(options.withUrl ? { url: `/api/media/images/${asset.id}` } : {}),
  };
}
