/**
 * Shared fixtures for the browser-output (R06) tests.
 *
 * The PNG is the same 4×3 image the stdio fixture writes. It is duplicated as a
 * base64 constant on purpose: the fixture is a plain Node child process and
 * cannot import a TypeScript helper, and a committed binary would be harder to
 * review than 94 bytes of PNG.
 */

import { createHash } from 'node:crypto';
import type { RawCallResult } from '../../src/mcp/client.ts';
import {
  DEFAULT_MCP_LIMITS,
  DEFAULT_MCP_TIMEOUTS,
  type McpServerConfig,
  type McpStdioConfig,
} from '../../src/mcp/types.ts';

/** A real 4×3 PNG. */
export const BROWSER_PNG_4X3 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVQI12MwTjsDRww4OQA/XBC9i4/eRAAAAABJRU5ErkJggg==',
  'base64',
);

export function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function makeBrowserServerConfig(
  stdio: McpStdioConfig,
  overrides: Partial<McpServerConfig> = {},
): McpServerConfig {
  return {
    id: 'server-browser-1',
    userId: 'user-1',
    name: 'Playwright',
    enabled: true,
    required: false,
    transport: 'stdio',
    stdio,
    timeouts: DEFAULT_MCP_TIMEOUTS,
    limits: DEFAULT_MCP_LIMITS,
    toolPolicy: {},
    configRevision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function rawCallResult(
  content: readonly unknown[],
  structuredContent?: unknown,
): RawCallResult {
  return {
    content,
    ...(structuredContent !== undefined ? { structuredContent } : {}),
    isError: false,
    task: null,
    raw: { content, ...(structuredContent !== undefined ? { structuredContent } : {}) },
  };
}

/** Playwright's screenshot line, exactly as `Response.resolveClientFile` prints it. */
export function screenshotText(target: string, label = 'viewport'): string {
  return [
    '### Result',
    `- [Screenshot of ${label}](${target})`,
    '### Ran Playwright code',
    '```js',
    `await page.screenshot({ path: ${JSON.stringify(target)} });`,
    '```',
  ].join('\n');
}
