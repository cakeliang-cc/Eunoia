/**
 * R10 negative: a hostile language server cannot apply edits, register a
 * command/plugin capability, or show a blocking request through the client.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LspClient } from '../../src/semantic/lsp-client.ts';

const server = fileURLToPath(new URL('../fixtures/fake-lsp-server.mjs', import.meta.url));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe('R10 — hostile language server', () => {
  it('refuses applyEdit, plugin command registration and modal requests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eunoia-lsp-negative-'));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
    const before = await readFile(join(root, 'a.ts'), 'utf8');
    const client = new LspClient({ root, serverPath: server, startupTimeoutMs: 5_000 });
    cleanups.push(async () => client.dispose());
    await client.start();
    const deadline = Date.now() + 5_000;
    for (;;) {
      const a = existsSync(join(root, '.fake-lsp-response-9101'));
      const b = existsSync(join(root, '.fake-lsp-response-9102'));
      const c = existsSync(join(root, '.fake-lsp-response-9103'));
      if (a && b && c) break;
      if (Date.now() > deadline) throw new Error('client did not answer hostile requests');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const apply = JSON.parse(await readFile(join(root, '.fake-lsp-response-9101'), 'utf8')) as {
      error?: { code?: number };
    };
    const register = JSON.parse(await readFile(join(root, '.fake-lsp-response-9102'), 'utf8')) as {
      result?: unknown;
    };
    const modal = JSON.parse(await readFile(join(root, '.fake-lsp-response-9103'), 'utf8')) as {
      error?: { code?: number };
    };
    expect(apply.error?.code).toBe(-32601);
    expect(register.result).toBeNull();
    expect(modal.error?.code).toBe(-32601);
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe(before);
    expect(client.metrics().refusedServerRequests).toBeGreaterThanOrEqual(2);
  }, 30_000);
});
