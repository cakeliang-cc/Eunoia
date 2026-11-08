/**
 * The tool-facing media import adapter.
 *
 * Both a native tool (`read_image`) and an MCP image result need the same
 * three facts: owner/conversation scoping, a decoded private asset, and a
 * binding so the collector does not treat the bytes as an unbound draft. This
 * adapter is the one place that composition lives.
 */

import type { ToolMediaPort } from '../tools/types.ts';
import type { MediaService } from './service.ts';

export function createToolMediaPort(media: MediaService): ToolMediaPort {
  return {
    async importToolImage(input) {
      const asset = await media.putToolImage({
        userId: input.userId,
        conversationId: input.conversationId,
        name: input.name,
        declaredMediaType: input.mediaType,
        bytes: input.bytes,
      });
      return {
        assetId: asset.id,
        mediaType: asset.mediaType,
        width: asset.width,
        height: asset.height,
        bytes: asset.bytes,
        name: asset.name,
      };
    },
  };
}
