/**
 * The metadata port for media assets.
 *
 * Both stores implement it with the same semantics: ownership is per user *and*
 * conversation, a bound asset cannot be released from under a message, and a
 * collection candidate is only the pair "unreferenced" plus "past the grace
 * window". The filesystem is not consulted to decide any of that — a filename is
 * not a reference count.
 */

import type { ImageAsset } from './types.ts';

export interface MediaAssetStore {
  createMediaAsset(asset: ImageAsset): Promise<void>;

  /** Owner-scoped read. Another user's id is indistinguishable from a missing one. */
  getMediaAsset(userId: string, assetId: string): Promise<ImageAsset | null>;

  /** Batch read, preserving nothing about the input order; callers index by id. */
  listMediaAssets(userId: string, assetIds: readonly string[]): Promise<ImageAsset[]>;

  listConversationMedia(userId: string, conversationId: string): Promise<ImageAsset[]>;

  listUserMedia(userId: string): Promise<ImageAsset[]>;

  /** Image references of one message, in their stored order. */
  messageAssetIds(messageId: string): Promise<string[]>;

  /**
   * Extend a lease on every still-owned asset.
   *
   * A lease is what stops the collector while a model request is reading the
   * bytes. It is not a reference: if the process dies, the lease expires and the
   * asset becomes collectable again, which is the only honest recovery.
   */
  setMediaLease(
    userId: string,
    assetIds: readonly string[],
    until: Date | null,
  ): Promise<void>;

  /**
   * Delete an unreferenced draft's metadata. Returns false when it is bound,
   * missing, or leased — the three reasons deletion must not proceed.
   */
  deletePendingMediaAsset(userId: string, assetId: string, now?: Date): Promise<boolean>;

  /** Delete metadata rows after their blobs were removed. */
  deleteMediaAssets(assetIds: readonly string[]): Promise<void>;

  /**
   * Assets a cleanup sweep may collect: released, or unreferenced pending, older
   * than the grace window, and not under a live lease.
   */
  listCollectableMedia(now: Date, graceMs: number): Promise<ImageAsset[]>;

  /**
   * Mark unreferenced bound assets as released after their messages were deleted.
   *
   * The rows stay until the grace window passes so the sweep can be retried; the
   * bytes are not deleted at message-deletion time.
   */
  releaseUnreferencedAssets(conversationId: string): Promise<void>;
}
