/**
 * `read_image`: bring a workspace image into the conversation as a real image.
 *
 * The bytes are read through the workspace gateway (path guard, ignore rules,
 * sensitive-file refusal) and decoded by the media pipeline. A filename is not
 * an image: the declared extension is only a hint, and the actual bytes decide
 * the MIME type. If the current model cannot see images, the next request's
 * media plan refuses rather than the tool claiming "looked at it".
 *
 * See docs/adr/038-developer-toolkit.md.
 */

import { z } from 'zod';
import { defineTool, toolError, toolOk } from '../types.ts';
import type { ToolResult } from '../types.ts';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function extensionOf(path: string): string {
  const index = path.lastIndexOf('.');
  return index >= 0 ? path.slice(index).toLowerCase() : '';
}

export const readImageTool = defineTool({
  name: 'read_image',
  description:
    'Read an image file from the workspace and attach its actual pixels to this conversation. ' +
    'Supports JPEG, PNG and WebP. Use it to inspect screenshots, design mockups or diagrams before answering.',
  parameters: z.object({
    file_path: z.string().min(1).describe('Image path relative to the workspace root.'),
  }),
  sideEffect: 'none',
  readOnly: true,
  guidelines:
    'read_image only supports JPEG/PNG/WebP. The image bytes are immutable once read; editing the file later does not change the message history.',
  timeoutMs: 20_000,
  async execute({ file_path }, context): Promise<ToolResult> {
    if (!context.workspace) return toolError('没有配置工作区，不能读取文件。');
    if (!context.media) return toolError('这个进程没有配置图片存储，不能把图片交给模型。');
    if (!context.userId || !context.conversationId) {
      return toolError('图片读取缺少会话或用户上下文，已拒绝。');
    }
    const declared = MIME_BY_EXTENSION[extensionOf(file_path)];
    if (!declared) {
      return toolError(
        `不支持的图片格式：${extensionOf(file_path) || '(无扩展名)'}。只支持 JPEG、PNG、WebP；SVG/GIF/PDF 不会被当作图片读取。`,
        { reason: 'unsupported_image_type' },
      );
    }
    let info;
    try {
      info = await context.workspace.stat(file_path);
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error));
    }
    if (!info) return toolError(`文件不存在：${file_path}`);
    if (info.size > MAX_IMAGE_BYTES) {
      return toolError(`图片超过 ${MAX_IMAGE_BYTES} 字节上限。`, {
        reason: 'image_too_large',
        bytes: info.size,
      });
    }
    let bytes: Uint8Array;
    try {
      if (!context.workspace.readBytes) {
        return toolError('当前工作区不支持二进制读取。');
      }
      bytes = await context.workspace.readBytes(file_path, MAX_IMAGE_BYTES);
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error));
    }
    let imported;
    try {
      imported = await context.media.importToolImage({
        userId: context.userId,
        conversationId: context.conversationId,
        actionId: context.actionId ?? context.toolCallId ?? 'read_image',
        name: file_path.split('/').pop() ?? 'image',
        mediaType: declared,
        bytes,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolError(`图片无法解码或入库：${message}`);
    }
    return {
      ...toolOk(
        `已读取 ${file_path}：${imported.width}×${imported.height}，${imported.bytes} 字节，来源为工作区文件。图片已加入本轮内容。`,
        {
          summary: `${file_path}（${imported.width}×${imported.height}）`,
          path: file_path,
          source: 'workspace_file',
        },
      ),
      content: [
        {
          type: 'image',
          assetId: imported.assetId,
          mediaType: imported.mediaType,
          width: imported.width,
          height: imported.height,
          bytes: imported.bytes,
          name: imported.name,
          source: 'tool',
        },
      ],
    };
  },
});
