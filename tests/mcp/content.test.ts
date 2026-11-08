/**
 * Content mapping: order, typed blocks, explicit media reporting and structured
 * output validation. The text projection must never say something the blocks do
 * not contain.
 */

import { describe, expect, it } from 'vitest';
import { mapCallResult } from '../../src/mcp/content.ts';
import { SecretRedactor } from '../../src/mcp/credentials.ts';
import { DEFAULT_MCP_LIMITS } from '../../src/mcp/types.ts';

const redactor = new SecretRedactor();

function result(content: unknown[], extra: Record<string, unknown> = {}) {
  return {
    content,
    isError: false,
    task: null,
    raw: { content },
    ...extra,
  };
}

describe('mapCallResult', () => {
  it('preserves block order and builds one text projection', async () => {
    const mapped = await mapCallResult({
      result: result([
        { type: 'text', text: 'first' },
        { type: 'image', mimeType: 'image/png', data: Buffer.from('png').toString('base64') },
        { type: 'text', text: 'last' },
      ]),
      limits: DEFAULT_MCP_LIMITS,
      redactor,
      importImage: async ({ mediaType }) => ({
        assetId: 'asset-1',
        mediaType,
        width: 1,
        height: 1,
        bytes: 3,
        name: 'mcp-tool-2.png',
      }),
    });
    expect(mapped.result.ok).toBe(true);
    expect(mapped.result.content?.map((block) => block.type)).toEqual(['text', 'image', 'text']);
    expect(mapped.result.output).toContain('first');
    expect(mapped.result.output).toContain('last');
    expect(mapped.result.output).toContain('工具返回的图片');
    expect(mapped.diagnostics).toEqual([]);
  });

  it('reports an image it cannot import instead of pretending it saw one', async () => {
    const mapped = await mapCallResult({
      result: result([
        { type: 'image', mimeType: 'image/gif', data: Buffer.from('gif').toString('base64') },
      ]),
      limits: DEFAULT_MCP_LIMITS,
      redactor,
    });
    expect(mapped.result.ok).toBe(true);
    expect(mapped.result.content).toHaveLength(1);
    expect(mapped.result.content?.[0]?.type).toBe('text');
    expect(mapped.result.output).toContain('不支持的格式');
    expect(mapped.result.meta?.mcp).toMatchObject({ images: 0 });
  });

  it('keeps audio as a private artifact and says it was not sent to the model', async () => {
    const mapped = await mapCallResult({
      result: result([
        { type: 'audio', mimeType: 'audio/mpeg', data: Buffer.from('audio').toString('base64') },
      ]),
      limits: DEFAULT_MCP_LIMITS,
      redactor,
      importArtifact: async ({ mimeType, bytes }) => ({
        artifactId: 'artifact-1',
        mimeType,
        bytes: bytes.length,
      }),
    });
    expect(mapped.result.content?.some((block) => block.type === 'artifact')).toBe(true);
    expect(mapped.result.output).toContain('没有发送给模型');
  });

  it('marks isError as a failure but keeps the text', async () => {
    const mapped = await mapCallResult({
      result: result([{ type: 'text', text: 'exploded' }], { isError: true }),
      limits: DEFAULT_MCP_LIMITS,
      redactor,
    });
    expect(mapped.result.ok).toBe(false);
    expect(mapped.result.error).toBe('exploded');
    expect(mapped.result.output).toBe('exploded');
  });

  it('fails a structured result that violates its outputSchema', async () => {
    const mapped = await mapCallResult({
      result: result([{ type: 'text', text: 'bad' }], { structuredContent: { ok: 'no' } }),
      limits: DEFAULT_MCP_LIMITS,
      redactor,
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    });
    expect(mapped.result.ok).toBe(false);
    expect(mapped.result.meta?.structuredInvalid).toBeTruthy();
  });

  it('keeps structuredContent separate and valid when the schema passes', async () => {
    const mapped = await mapCallResult({
      result: result([{ type: 'text', text: '3' }], { structuredContent: { sum: 3 } }),
      limits: DEFAULT_MCP_LIMITS,
      redactor,
      outputSchema: { type: 'object', properties: { sum: { type: 'number' } }, required: ['sum'] },
    });
    expect(mapped.result.ok).toBe(true);
    expect(mapped.result.structuredContent).toEqual({ sum: 3 });
    expect(mapped.result.output).toBe('3');
  });

  it('refuses a result above the byte limit before importing media', async () => {
    await expect(
      mapCallResult({
        result: result([{ type: 'text', text: 'x'.repeat(5_000) }]),
        limits: { ...DEFAULT_MCP_LIMITS, maxResultBytes: 1_024 },
        redactor,
      }),
    ).rejects.toThrow(/超过/);
  });

  it('redacts a secret the server echoed in text', async () => {
    redactor.registerToken('echoed-secret-value', 'test');
    const mapped = await mapCallResult({
      result: result([{ type: 'text', text: 'token echoed-secret-value' }]),
      limits: DEFAULT_MCP_LIMITS,
      redactor,
    });
    expect(mapped.result.output).not.toContain('echoed-secret-value');
    expect(mapped.result.output).toContain('[redacted:test]');
  });

  it('records a task handle in meta without changing the text', async () => {
    const mapped = await mapCallResult({
      result: result([{ type: 'text', text: 'working' }], {
        task: { taskId: 'task-1', status: 'working', ttl: 60_000 },
      }),
      limits: DEFAULT_MCP_LIMITS,
      redactor,
    });
    expect(mapped.task?.taskId).toBe('task-1');
    expect(mapped.result.meta?.taskHandle).toMatchObject({ taskId: 'task-1' });
  });
});
