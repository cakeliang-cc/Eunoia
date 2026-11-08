/**
 * The media service: upload, authorize, lease, collect.
 *
 * It is the only module that combines all three facts a valid image needs — the
 * decoded bytes, the database row and the owner/conversation scope. Keeping that
 * combination here is what lets the request planner stay pure and the transport
 * stay a thin adapter.
 *
 * Two invariants are worth stating because they are easy to lose:
 *
 *   - **A draft is not a reference.** Uploading makes an asset `pending`, which
 *     anyone may delete before it is sent. Binding happens with the message, in
 *     the message's transaction, so there is no window in which a message exists
 *     without its images or an image is bound to a message that was rolled back.
 *   - **A request takes a lease.** The collector skips leased assets, and a
 *     crashed process leaves only an expiry, not a permanent pin.
 */

import { randomUUID } from 'node:crypto';
import { decodeImage, DecodeGate, PROCESS_DECODE_GATE, sha256 } from './decode.ts';
import type { BlobPaths, MediaBlobStore } from './blob-store.ts';
import { assetDirectory } from './blob-store.ts';
import { MediaError } from './errors.ts';
import type { MediaLimits } from './types.ts';
import type { ImageAsset } from './types.ts';
import type { MediaAssetStore } from './store.ts';
import { MEDIA_PROCESSOR_VERSION, REQUEST_VARIANT_POLICY } from './limits.ts';

export interface MediaServiceDeps {
  readonly store: MediaAssetStore;
  readonly blobs: MediaBlobStore;
  readonly limits: MediaLimits;
  /** Shared with the decoder so the concurrency limit is process-wide. */
  readonly gate?: DecodeGate;
  readonly now?: () => Date;
}

export interface PutImageInput {
  readonly userId: string;
  readonly conversationId: string;
  readonly name: string;
  readonly declaredMediaType?: string | null;
  readonly bytes: Uint8Array;
}

export interface LoadedImage {
  readonly asset: ImageAsset;
  /** The request variant, exactly the bytes a model request will carry. */
  readonly bytes: Buffer;
}

export class MediaService {
  readonly #store: MediaAssetStore;
  readonly #blobs: MediaBlobStore;
  readonly #limits: MediaLimits;
  readonly #gate: DecodeGate;
  readonly #now: () => Date;

  constructor(deps: MediaServiceDeps) {
    this.#store = deps.store;
    this.#blobs = deps.blobs;
    this.#limits = deps.limits;
    this.#gate = deps.gate ?? PROCESS_DECODE_GATE;
    this.#now = deps.now ?? (() => new Date());
  }

  get limits(): MediaLimits {
    return this.#limits;
  }

  async putImage(input: PutImageInput): Promise<ImageAsset> {
    if (input.bytes.length === 0) {
      throw new MediaError('MEDIA_CORRUPT', '图片是空的', 415);
    }
    if (input.bytes.length > this.#limits.maxImageBytes) {
      throw new MediaError('MEDIA_TOO_LARGE', `图片超过 ${this.#limits.maxImageBytes} 字节上限`, 413);
    }

    const decoded = await decodeImage(
      input.bytes,
      {
        limits: this.#limits,
        declaredMediaType: input.declaredMediaType ?? null,
      },
      this.#gate,
    );

    const id = randomUUID();
    const extension = decoded.mediaType === 'image/jpeg' ? 'jpg' : decoded.mediaType === 'image/png' ? 'png' : 'webp';
    const directory = `${input.userId}/${input.conversationId}/${id}`;
    const paths: BlobPaths = {
      original: `${directory}/original.${extension}`,
      normalized: `${directory}/normalized.${extension}`,
      request: `${directory}/request.${extension}`,
    };
    const createdAt = this.#now();

    await this.#blobs.put(paths, {
      original: input.bytes,
      normalized: decoded.normalized.data,
      request: decoded.request.data,
    });

    const asset: ImageAsset = {
      id,
      userId: input.userId,
      conversationId: input.conversationId,
      name: clampName(input.name),
      mediaType: decoded.mediaType,
      bytes: input.bytes.length,
      width: decoded.width,
      height: decoded.height,
      sha256: decoded.sha256,
      storageKey: paths.original,
      normalized: {
        key: paths.normalized,
        width: decoded.normalized.width,
        height: decoded.normalized.height,
        bytes: decoded.normalized.data.length,
        sha256: decoded.normalized.sha256,
        processorVersion: decoded.processorVersion,
        policyRevision: decoded.policyRevision,
      },
      request: {
        key: paths.request,
        width: decoded.request.width,
        height: decoded.request.height,
        bytes: decoded.request.data.length,
        sha256: decoded.request.sha256,
        processorVersion: decoded.processorVersion,
        policyRevision: decoded.policyRevision,
      },
      status: 'pending',
      leaseExpiresAt: null,
      createdAt,
    };

    try {
      await this.#store.createMediaAsset(asset);
    } catch (error) {
      // A row that never committed must not leave bytes behind.
      await this.#blobs.remove(paths).catch(() => undefined);
      throw new MediaError('MEDIA_STORE_FAILED', '图片登记失败', 500, {
        retryable: true,
        details: { reason: error instanceof Error ? error.message : String(error) },
      });
    }
    return asset;
  }

  /**
   * Import bytes a tool returned as a private, bound asset.
   *
   * Binding happens with the import, not with a message: a tool result is a
   * durable fact of its own and the collector must not treat the image as an
   * unreferenced draft. Callers that fail after this point may leave a bound
   * asset; deleting the conversation removes it, and that is the honest
   * ownership rule.
   */
  async putToolImage(input: PutImageInput): Promise<ImageAsset> {
    const asset = await this.putImage(input);
    await this.#store.bindMediaAsset(input.userId, asset.id);
    return { ...asset, status: 'bound' };
  }

  /**
   * Validate that a set of ids is usable by this conversation.
   *
   * Returns the unique assets in the order first referenced. A missing id, an
   * id owned by somebody else, an id from another conversation and a released id
   * all produce the same 404-shaped error: distinguishing them would leak which
   * ids exist.
   */
  async resolve(
    userId: string,
    conversationId: string,
    assetIds: readonly string[],
  ): Promise<ImageAsset[]> {
    const unique = [...new Set(assetIds)];
    if (unique.length === 0) return [];
    const rows = await this.#store.listMediaAssets(userId, unique);
    const byId = new Map(rows.map((asset) => [asset.id, asset]));
    const resolved: ImageAsset[] = [];
    for (const id of unique) {
      const asset = byId.get(id);
      if (
        !asset ||
        asset.userId !== userId ||
        asset.conversationId !== conversationId ||
        asset.status === 'released'
      ) {
        throw new MediaError('MEDIA_NOT_FOUND', '图片不存在或不可访问', 404, {
          details: { assetId: id },
        });
      }
      resolved.push(asset);
    }
    return resolved;
  }

  /** Enforce the product limits that span a whole message. */
  assertMessageImages(assets: readonly ImageAsset[]): void {
    if (assets.length > this.#limits.maxImagesPerMessage) {
      throw new MediaError(
        'MEDIA_COUNT_EXCEEDED',
        `一次最多发送 ${this.#limits.maxImagesPerMessage} 张图片`,
        400,
        { details: { maxImages: this.#limits.maxImagesPerMessage } },
      );
    }
    const total = assets.reduce((sum, asset) => sum + asset.bytes, 0);
    if (total > this.#limits.maxMessageImageBytes) {
      throw new MediaError(
        'MEDIA_TOTAL_TOO_LARGE',
        `一次发送的图片合计不能超过 ${this.#limits.maxMessageImageBytes} 字节`,
        413,
        { details: { totalBytes: total, maxBytes: this.#limits.maxMessageImageBytes } },
      );
    }
  }

  /**
   * Read request variants by id and take a lease.
   *
   * The lease is taken before the first read and released by `releaseLease` when
   * the turn settles, so a request that is reading pixels is never collected
   * underneath itself.
   */
  async loadPlanImages(
    userId: string,
    assetIds: readonly string[],
  ): Promise<{ assetId: string; bytes: Buffer }[]> {
    if (assetIds.length === 0) return [];
    const assets = await this.#store.listMediaAssets(userId, assetIds);
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    // `listMediaAssets` de-duplicates and does not preserve order; the caller
    // indexes by id, so only completeness matters here.
    for (const id of assetIds) {
      if (!byId.has(id)) throw new MediaError('MEDIA_NOT_FOUND', '图片不存在或不可访问', 404);
    }
    const unique = [...byId.values()];
    const ids = unique.map((asset) => asset.id);
    await this.#store.setMediaLease(userId, ids, new Date(this.#now().getTime() + this.#limits.leaseMs));
    try {
      return await Promise.all(
        unique.map(async (asset) => ({
          assetId: asset.id,
          bytes: await this.#blobs.read(asset.request.key),
        })),
      );
    } catch (error) {
      await this.#store.setMediaLease(userId, ids, null);
      throw error;
    }
  }

  async releaseLease(userId: string, assetIds: readonly string[]): Promise<void> {
    await this.#store
      .setMediaLease(userId, assetIds, null)
      .catch(() => undefined);
  }

  /** Preview bytes: the bounded request variant, never the private original. */
  async readPreview(
    userId: string,
    assetId: string,
    conversationId?: string | null,
  ): Promise<LoadedImage> {
    const asset = await this.#store.getMediaAsset(userId, assetId);
    if (!asset || (conversationId && asset.conversationId !== conversationId)) {
      throw new MediaError('MEDIA_NOT_FOUND', '图片不存在或不可访问', 404);
    }
    return { asset, bytes: await this.#blobs.read(asset.request.key) };
  }

  async deleteDraft(userId: string, assetId: string): Promise<void> {
    // Read the keys before the row disappears; the directory is derived from
    // them, not from the asset id alone.
    const asset = await this.#store.getMediaAsset(userId, assetId);
    if (!asset) throw new MediaError('MEDIA_NOT_FOUND', '图片不存在或不可访问', 404);
    const deleted = await this.#store.deletePendingMediaAsset(userId, assetId, this.#now());
    if (!deleted) {
      throw new MediaError('MEDIA_REFERENCED', '图片已经被消息使用，不能作为草稿删除', 409);
    }
    await this.#blobs
      .remove({
        original: asset.storageKey,
        normalized: asset.normalized.key,
        request: asset.request.key,
      })
      .catch(() => undefined);
  }

  /**
   * Remove the bytes of assets whose conversation/user rows were just deleted.
   *
   * The caller lists the assets *before* deleting the rows, because after the
   * cascade there is nothing left to name the files. A failed unlink leaves an
   * orphan file, which is recoverable; refusing the conversation deletion is not
   * an option.
   */
  async removeAssetBytes(assets: readonly ImageAsset[]): Promise<void> {
    await Promise.all(
      assets.map((asset) =>
        this.#blobs
          .remove({
            original: asset.storageKey,
            normalized: asset.normalized.key,
            request: asset.request.key,
          })
          .catch(() => undefined),
      ),
    );
  }

  async conversationAssets(userId: string, conversationId: string): Promise<ImageAsset[]> {
    return this.#store.listConversationMedia(userId, conversationId);
  }

  async userAssets(userId: string): Promise<ImageAsset[]> {
    return this.#store.listUserMedia(userId);
  }

  /**
   * Delete old drafts and released assets.
   *
   * "Old" is measured from creation and filtered by the grace window; a live
   * lease is skipped. A file that is already gone is not an error — the row is
   * the thing that would keep a client pointing at it.
   */
  async collect(now: Date = this.#now()): Promise<{ removed: number }> {
    const candidates = await this.#store.listCollectableMedia(now, this.#limits.unboundGraceMs);
    let removed = 0;
    for (const asset of candidates) {
      try {
        await this.#blobs.remove({
          original: asset.storageKey,
          normalized: asset.normalized.key,
          request: asset.request.key,
        });
      } catch {
        // Keep the row so a later sweep can retry; the bytes may still exist.
        continue;
      }
      await this.#store.deleteMediaAssets([asset.id]);
      removed += 1;
    }
    return { removed };
  }

  /** Verify that a recorded original still matches its immutable digest. */
  async verifyOriginal(asset: ImageAsset): Promise<boolean> {
    try {
      const bytes = await this.#blobs.read(asset.storageKey);
      return sha256(bytes) === asset.sha256;
    } catch {
      return false;
    }
  }

  async readOriginal(asset: ImageAsset): Promise<Buffer> {
    return this.#blobs.read(asset.storageKey);
  }
}

/** Bound the display name; it is data, not a path and not a sentence. */
function clampName(name: string): string {
  const flat = name.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return 'image';
  return flat.length > 120 ? `${flat.slice(0, 117)}…` : flat;
}

export { assetDirectory, MEDIA_PROCESSOR_VERSION, REQUEST_VARIANT_POLICY };
