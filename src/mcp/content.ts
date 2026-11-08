/**
 * MCP result content → the host's ordered, typed content blocks.
 *
 * The mapping is where "the server returned an image" becomes a fact the rest of
 * the product can trust: bytes imported into private storage, a MIME type that
 * was actually decoded, and a note in the text projection saying the image came
 * from a tool rather than from the person. The model must be able to tell those
 * apart, and so must the UI.
 *
 * Order is preserved exactly. A result that is "text, image, text" is not "two
 * texts and an image"; the sequence is what the server meant.
 *
 * Unsupported media is reported, never dropped silently: an audio block becomes
 * a visible note plus a private artifact, because "the model read it" would be a
 * lie and "nothing happened" would hide a real result.
 *
 * See docs/adr/033-mcp-host.md §10.1.
 */

import type {
  ImportedToolImage,
  ToolContentBlock,
  ToolResult,
} from '../tools/types.ts';
import { createJsonSchemaValidator } from '../tools/contract.ts';
import type { SecretRedactor } from './credentials.ts';
import type { McpLimits } from './types.ts';
import { McpError } from './types.ts';
import type { RawCallResult } from './client.ts';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export interface StoredArtifactRef {
  readonly artifactId: string;
  readonly mimeType: string;
  readonly bytes: number;
}

export interface MapResultInput {
  readonly result: RawCallResult;
  readonly limits: McpLimits;
  readonly redactor: SecretRedactor;
  readonly outputSchema?: Record<string, unknown> | null;
  /** Private image import. Absent means images are reported but not sent. */
  readonly importImage?: (input: {
    readonly name: string;
    readonly mediaType: string;
    readonly bytes: Uint8Array;
  }) => Promise<ImportedToolImage>;
  /** Private non-image storage. Absent means the bytes are only described. */
  readonly importArtifact?: (input: {
    readonly mimeType: string;
    readonly bytes: Uint8Array;
  }) => Promise<StoredArtifactRef>;
}

export interface MappedResult {
  readonly result: ToolResult;
  readonly task: RawCallResult['task'];
  /** Non-fatal diagnostics for the trace: skipped media, truncation, decode errors. */
  readonly diagnostics: readonly string[];
}

/**
 * Convert one call result.
 *
 * `output` is derived from `content` here and nowhere else. A later stage that
 * edited the projection independently would be able to show the model something
 * the blocks do not contain.
 */
export async function mapCallResult(input: MapResultInput): Promise<MappedResult> {
  const diagnostics: string[] = [];
  const blocks: ToolContentBlock[] = [];
  const projection: string[] = [];
  let truncated = false;
  let textChars = 0;
  const mediaErrors: string[] = [];

  const rawBytes = byteLength(input.result.raw);
  if (rawBytes > input.limits.maxResultBytes) {
    throw new McpError(
      'MCP_RESULT_TOO_LARGE',
      `工具结果 ${rawBytes} 字节，超过 ${input.limits.maxResultBytes} 字节上限。`,
      413,
      { detail: { bytes: rawBytes, maxBytes: input.limits.maxResultBytes } },
    );
  }

  const appendText = (text: string): void => {
    if (text.length === 0) return;
    const remaining = input.limits.maxTextChars - textChars;
    if (remaining <= 0) {
      truncated = true;
      return;
    }
    const slice = text.length > remaining ? text.slice(0, remaining) : text;
    if (slice.length < text.length) truncated = true;
    textChars += slice.length;
    blocks.push({ type: 'text', text: slice });
    projection.push(slice);
  };

  for (const [index, entry] of input.result.content.entries()) {
    const block = (entry ?? {}) as Record<string, unknown>;
    const type = typeof block.type === 'string' ? block.type : '';
    if (type === 'text') {
      const text = typeof block.text === 'string' ? block.text : '';
      appendText(input.redactor.redact(text));
      continue;
    }
    if (type === 'image') {
      const mimeType = typeof block.mimeType === 'string' ? block.mimeType : '';
      const data = typeof block.data === 'string' ? block.data : '';
      if (!IMAGE_TYPES.has(mimeType)) {
        const note = `[工具返回的图片使用了不支持的格式 ${mimeType || '(unknown)'}，没有发送给模型]`;
        appendText(note);
        diagnostics.push(note);
        continue;
      }
      const bytes = Buffer.from(data, 'base64');
      if (bytes.length === 0) {
        const note = `[工具返回的第 ${index + 1} 张图片是空的，没有发送给模型]`;
        appendText(note);
        diagnostics.push(note);
        continue;
      }
      if (!input.importImage) {
        const note = `[工具返回了一张 ${mimeType} 图片（${bytes.length} 字节），但本进程没有配置媒体存储，未发送给模型]`;
        appendText(note);
        diagnostics.push(note);
        continue;
      }
      try {
        const imported = await input.importImage({
          name: `mcp-tool-${String(index + 1)}.${extensionOf(mimeType)}`,
          mediaType: mimeType,
          bytes,
        });
        blocks.push({ type: 'image', source: 'tool', ...imported });
        projection.push(
          `[工具返回的图片 #${blocks.filter((b) => b.type === 'image').length}：${imported.name}，${imported.width}×${imported.height}，来源为 MCP 工具结果]`,
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const note = `[工具返回的图片无法导入：${reason}]`;
        appendText(note);
        diagnostics.push(note);
        mediaErrors.push(reason);
      }
      continue;
    }
    if (type === 'audio' || type === 'video') {
      const mimeType = typeof block.mimeType === 'string' ? block.mimeType : `unknown/${type}`;
      const bytes = typeof block.data === 'string' ? Buffer.from(block.data, 'base64') : Buffer.alloc(0);
      let descriptor = `${type} ${mimeType}（${bytes.length} 字节）`;
      if (input.importArtifact && bytes.length > 0) {
        try {
          const artifact = await input.importArtifact({ mimeType, bytes });
          blocks.push({
            type: 'artifact',
            artifactId: artifact.artifactId,
            mimeType: artifact.mimeType,
            bytes: artifact.bytes,
            name: `mcp-tool-${String(index + 1)}.${extensionOf(mimeType)}`,
          });
          descriptor = `${type} ${mimeType}，已保存为私有产物`;
        } catch (error) {
          diagnostics.push(`artifact store failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const note = `[工具返回了 ${descriptor}；当前模型不会读取这类媒体，内容没有发送给模型]`;
      appendText(note);
      diagnostics.push(note);
      continue;
    }
    if (type === 'resource_link') {
      const uri = typeof block.uri === 'string' ? block.uri : '';
      const name = typeof block.name === 'string' ? block.name : uri;
      blocks.push({
        type: 'resource_link',
        uri,
        name,
        ...(typeof block.mimeType === 'string' ? { mimeType: block.mimeType } : {}),
        ...(typeof block.description === 'string' ? { description: block.description } : {}),
      });
      projection.push(`[资源链接：${name} <${uri}>；访问需要用户明确选择]`);
      continue;
    }
    if (type === 'resource') {
      const resource = (block.resource ?? {}) as Record<string, unknown>;
      const uri = typeof resource.uri === 'string' ? resource.uri : '';
      const mimeType = typeof resource.mimeType === 'string' ? resource.mimeType : 'application/octet-stream';
      if (typeof resource.text === 'string') {
        const text = input.redactor.redact(resource.text);
        blocks.push({ type: 'embedded_text', uri, mimeType, text });
        projection.push(`[嵌入资源 ${uri}]\n${text}`);
        continue;
      }
      if (typeof resource.blob === 'string') {
        const bytes = Buffer.from(resource.blob, 'base64');
        if (IMAGE_TYPES.has(mimeType) && input.importImage) {
          try {
            const imported = await input.importImage({
              name: `mcp-resource-${String(index + 1)}.${extensionOf(mimeType)}`,
              mediaType: mimeType,
              bytes,
            });
            blocks.push({ type: 'image', source: 'tool', ...imported });
            projection.push(`[嵌入资源图片 ${uri}：${imported.name}]`);
            continue;
          } catch (error) {
            diagnostics.push(`embedded image failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (input.importArtifact) {
          try {
            const artifact = await input.importArtifact({ mimeType, bytes });
            blocks.push({
              type: 'artifact',
              artifactId: artifact.artifactId,
              mimeType,
              bytes: artifact.bytes,
              name: uri,
            });
            projection.push(`[嵌入资源 ${uri}（${mimeType}，${bytes.length} 字节）已保存为私有产物]`);
            continue;
          } catch (error) {
            diagnostics.push(`embedded artifact failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        projection.push(`[嵌入资源 ${uri}（${mimeType}，${bytes.length} 字节）未保存]`);
        continue;
      }
      projection.push(`[嵌入资源 ${uri} 没有可读内容]`);
      continue;
    }
    // Unknown content type: recorded and shown as a note. Silently dropping it
    // would make "the tool returned something" indistinguishable from "nothing".
    const note = `[工具返回了未知内容类型 ${type || '(missing)'}，未发送给模型]`;
    appendText(note);
    diagnostics.push(note);
  }

  let structuredInvalid: string | null = null;
  if (input.result.structuredContent !== undefined && input.outputSchema) {
    const validate = createJsonSchemaValidator(input.outputSchema);
    const check = validate(input.result.structuredContent);
    if (!check.ok) {
      structuredInvalid = check.error;
      diagnostics.push(`structuredContent 不符合 outputSchema: ${check.error}`);
    }
  }

  const errorText = input.result.isError
    ? projection.join('\n').trim() || '服务报告调用失败（没有返回错误文本）'
    : null;
  const blockedBySchema = structuredInvalid !== null;
  const ok = !input.result.isError && !blockedBySchema;
  const output = projection.join('\n');
  const error = errorText ?? (blockedBySchema ? `返回的结构化内容不符合 outputSchema：${structuredInvalid}` : undefined);

  return {
    result: {
      ok,
      output,
      ...(error ? { error } : {}),
      ...(blocks.length > 0 ? { content: blocks } : {}),
      ...(input.result.structuredContent !== undefined
        ? { structuredContent: input.result.structuredContent }
        : {}),
      meta: {
        ...(truncated ? { truncated: true } : {}),
        ...(diagnostics.length > 0 ? { mcpDiagnostics: diagnostics } : {}),
        ...(mediaErrors.length > 0 ? { mediaErrors } : {}),
        ...(structuredInvalid ? { structuredInvalid } : {}),
        ...(input.result.task ? { taskHandle: input.result.task } : {}),
        mcp: {
          contentBlocks: blocks.length,
          images: blocks.filter((block) => block.type === 'image').length,
          structured: input.result.structuredContent !== undefined,
        },
      },
    },
    task: input.result.task,
    diagnostics,
  };
}

function byteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return 0;
  }
}

function extensionOf(mimeType: string): string {
  const base = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (base === 'image/jpeg') return 'jpg';
  if (base === 'image/png') return 'png';
  if (base === 'image/webp') return 'webp';
  if (base === 'application/json') return 'json';
  if (base === 'application/pdf') return 'pdf';
  if (base === 'text/plain') return 'txt';
  return 'bin';
}
