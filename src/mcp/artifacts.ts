/**
 * Private storage for non-image tool results.
 *
 * An MCP server may return a PDF, an archive or any other binary. It is a fact
 * worth keeping and a thing the model must not silently be told it read. This
 * service stores the bytes privately, records the MIME type and digest, and
 * gives back an opaque id; the model sees a link-shaped note, not a file path.
 *
 * The bytes are never executed and never treated as a workspace file.
 */

import { randomUUID } from 'node:crypto';
import { sha256 } from '../tools/contract.ts';
import type { MediaBlobStore } from '../media/blob-store.ts';
import type { McpStore } from './store.ts';
import { McpError } from './types.ts';

/** A conservative extension map. An unknown type is stored without one. */
const EXTENSIONS: Readonly<Record<string, string>> = {
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/json': 'json',
  'application/octet-stream': 'bin',
  'text/csv': 'csv',
  'text/plain': 'txt',
  'text/html': 'html',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'video/mp4': 'mp4',
};

export interface StoredArtifact {
  readonly artifactId: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly sha256: string;
}

export class McpArtifactService {
  readonly #store: McpStore;
  readonly #blobs: MediaBlobStore;
  readonly #now: () => Date;
  readonly #maxBytes: number;

  constructor(options: {
    readonly store: McpStore;
    readonly blobs: MediaBlobStore;
    readonly maxBytes: number;
    readonly now?: () => Date;
  }) {
    this.#store = options.store;
    this.#blobs = options.blobs;
    this.#maxBytes = options.maxBytes;
    this.#now = options.now ?? (() => new Date());
  }

  async put(input: {
    readonly userId: string;
    readonly conversationId: string;
    readonly actionId: string | null;
    readonly mimeType: string;
    readonly bytes: Uint8Array;
  }): Promise<StoredArtifact> {
    if (input.bytes.length > this.#maxBytes) {
      throw new McpError('MCP_RESULT_TOO_LARGE', '工具返回的二进制结果超过大小上限。', 413, {
        detail: { bytes: input.bytes.length, maxBytes: this.#maxBytes },
      });
    }
    if (!this.#blobs.putBinary) {
      throw new McpError('MCP_UNSUPPORTED', '当前媒体存储不支持工具产物。', 500);
    }
    const id = randomUUID();
    const extension = EXTENSIONS[input.mimeType.split(';')[0]?.trim() ?? ''] ?? 'bin';
    const storageKey = `mcp-artifacts/${input.userId}/${input.conversationId}/${id}.${extension}`;
    const digest = sha256(input.bytes);
    await this.#blobs.putBinary(storageKey, input.bytes);
    try {
      await this.#store.createMcpArtifact({
        id,
        userId: input.userId,
        conversationId: input.conversationId,
        actionId: input.actionId,
        mimeType: input.mimeType,
        bytes: input.bytes.length,
        sha256: digest,
        storageKey,
        createdAt: this.#now().toISOString(),
      });
    } catch (error) {
      await this.#blobs.removeKey?.(storageKey).catch(() => undefined);
      throw error;
    }
    return { artifactId: id, mimeType: input.mimeType, bytes: input.bytes.length, sha256: digest };
  }

  async read(
    userId: string,
    artifactId: string,
  ): Promise<{ readonly record: Awaited<ReturnType<McpStore['getMcpArtifact']>>; readonly bytes: Buffer }> {
    const record = await this.#store.getMcpArtifact(userId, artifactId);
    if (!record) throw new McpError('MCP_NOT_FOUND', '工具产物不存在或不可访问', 404);
    const bytes = await this.#blobs.read(record.storageKey);
    if (sha256(bytes) !== record.sha256) {
      throw new McpError('MCP_STORE_FAILED', '工具产物校验失败：内容与记录不一致', 500);
    }
    return { record, bytes };
  }
}
