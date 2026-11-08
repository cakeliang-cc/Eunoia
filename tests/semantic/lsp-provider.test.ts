/**
 * The real language-server path, exercised against a real child process.
 *
 * These tests start `typescript-language-server` over stdio in a temporary
 * TypeScript project. They assert what a mock cannot prove: initialize and its
 * advertised capabilities, cross-file definition/reference, Chinese/emoji/CRLF
 * position conversion, diagnostics that change after an edit, `$/cancelRequest`,
 * and recovery after `SIGKILL` with document-state rebuild.
 *
 * Every provider is disposed in `afterEach`, and the test also waits for the
 * recorded child pid to disappear, so a leaked language server fails the suite.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { WorkspaceFiles } from '../../src/sandbox/workspace-files.ts';
import { LspClient } from '../../src/semantic/lsp-client.ts';
import {
  LspLanguageProvider,
  shutdownLanguageProviders,
} from '../../src/semantic/lsp-provider.ts';
import { workspaceDocumentReader } from '../../src/semantic/language-service-provider.ts';
import { findDefinitionTool } from '../../src/tools/coding/semantic-tools.ts';
import { DEFAULT_TOOL_POLICY } from '../../src/tools/types.ts';
import type { ToolContext } from '../../src/tools/types.ts';
import { TurnReadLedger } from '../../src/tools/ledger.ts';

const cleanups: Array<() => Promise<void>> = [];
const providers: LspLanguageProvider[] = [];
const watchedPids: number[] = [];

afterEach(async () => {
  for (const provider of providers.splice(0)) {
    const pid = provider.info().pid;
    if (pid) watchedPids.push(pid);
    await provider.dispose().catch(() => undefined);
  }
  await shutdownLanguageProviders();
  for (const pid of watchedPids.splice(0)) {
    await waitUntilGone(pid, 5_000);
    expect(isAlive(pid)).toBe(false);
  }
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilGone(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'eunoia-lsp-'));
  await mkdir(root, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    await mkdir(join(absolute, '..'), { recursive: true });
    await writeFile(absolute, content);
  }
  cleanups.push(async () => rm(root, { recursive: true, force: true }));
  return root;
}

async function openProvider(
  root: string,
  options: {
    readonly mirror?: boolean;
    readonly seedPaths?: readonly string[];
    readonly files?: readonly string[];
  } = {},
): Promise<LspLanguageProvider> {
  const workspace = new WorkspaceFiles({ root });
  const provider = await LspLanguageProvider.create({
    hostRoot: options.mirror ? null : root,
    ...(options.mirror ? { allowMirror: true, seedPaths: options.seedPaths ?? [] } : {}),
    ...(options.files ? { listDocuments: async () => options.files ?? [] } : {}),
    readDocument: workspaceDocumentReader(workspace),
  });
  providers.push(provider);
  const pid = provider.info().pid;
  if (pid) watchedPids.push(pid);
  return provider;
}

function toolContext(root: string, language: boolean): ToolContext {
  return {
    workspace: new WorkspaceFiles({ root }),
    ...(language ? { language: { hostRoot: root } } : {}),
    policy: { ...DEFAULT_TOOL_POLICY, maxOutputChars: 40_000 },
    ledger: new TurnReadLedger(),
    now: new Date('2026-04-01T00:00:00Z'),
  };
}

const PROJECT = {
  'a.ts': ['export function add(a: number, b: number): number {', '  return a + b;', '}'].join('\n'),
  'b.ts': ["import { add } from './a';", 'export const sum = add(1, 2);'].join('\n'),
  'c.ts': ['function add() { return 0; }', 'export const x = add();'].join('\n'),
};

describe('real typescript-language-server', () => {
  it(
    'initializes a child process and answers cross-file definition and references',
    async () => {
      const root = await project(PROJECT);
      const provider = await openProvider(root, { files: Object.keys(PROJECT) });
      const info = provider.info();
      expect(info.backend).toBe('language_server');
      expect(info.transport).toBe('stdio');
      expect(info.positionEncoding).toBe('utf-16');
      expect(info.server).toBe('typescript-language-server');
      expect(typeof info.serverVersion).toBe('string');
      expect(info.serverVersion).toMatch(/^\d+\.\d+\.\d+/);
      expect(info.pid).toBeGreaterThan(0);
      expect(isAlive(info.pid as number)).toBe(true);
      const capabilities = info.capabilities ?? [];
      expect(capabilities).toEqual(expect.arrayContaining(['definition', 'references', 'documentSymbol']));

      const definition = await provider.definition({ path: 'b.ts', symbol: 'add' });
      expect(definition.value.locations.length).toBeGreaterThan(0);
      const first = definition.value.locations[0];
      expect(first?.path).toBe('a.ts');
      expect(first?.line).toBe(1);
      expect(first?.snippet).toContain('function add');
      expect(definition.documentVersion).toBe(1);
      expect(definition.info.backend).toBe('language_server');

      const references = await provider.references(
        { path: 'a.ts', symbol: 'add' },
        { includeDeclaration: false },
      );
      const paths = references.value.locations.map((entry) => `${entry.path}:${entry.line}`);
      expect(paths).toContain('b.ts:2');
      // The same-named local function in c.ts is a different symbol.
      expect(paths.some((entry) => entry.startsWith('c.ts'))).toBe(false);
      expect(references.value.total).toBeGreaterThan(0);
    },
    40_000,
  );

  it(
    'converts 1-based code-point positions for Chinese text, emoji and CRLF',
    async () => {
      const lineOne = 'const 中文 = 1;';
      const lineTwo = 'const 文本 = "😀"; export const 值 = 中文;';
      const root = await project({ 'u.ts': `${lineOne}\r\n${lineTwo}\r\n` });
      const provider = await openProvider(root, { files: ['u.ts'] });
      const column = [...lineTwo].indexOf('中') + 1;
      const definition = await provider.definition({ path: 'u.ts', line: 2, column });
      expect(definition.value.locations.length).toBeGreaterThan(0);
      const target = definition.value.locations[0];
      expect(target?.path).toBe('u.ts');
      expect(target?.line).toBe(1);
      // `const 中文` — 中文 starts at code-point column 7.
      expect(target?.column).toBe([...lineOne].indexOf('中') + 1);
      // The declaration snippet must not contain a CR or the gutter.
      expect(target?.snippet).toBe('const 中文 = 1;');

      const references = await provider.references({ path: 'u.ts', line: 2, column });
      expect(references.value.locations.some((entry) => entry.line === 1)).toBe(true);
      expect(references.documentVersion).toBe(1);
    },
    40_000,
  );

  it(
    'reports diagnostics, increments the document version after a fix, and clears them',
    async () => {
      const root = await project({ 'bad.ts': ["export const value: number = 'not a number';"].join('\n') });
      const provider = await openProvider(root, { files: ['bad.ts'] });
      const first = await provider.diagnostics({ paths: ['bad.ts'] });
      expect(first.value.checked).toBe(1);
      expect(first.value.versions['bad.ts']).toBe(1);
      expect(first.stale).toBe(false);
      expect(first.value.diagnostics.some((entry) => entry.code === 'TS2322' && entry.line === 1)).toBe(true);

      await writeFile(join(root, 'bad.ts'), 'export const value: number = 1;\n', 'utf8');
      const second = await provider.diagnostics({ paths: ['bad.ts'] });
      expect(second.value.versions['bad.ts']).toBe(2);
      expect(second.stale).toBe(false);
      expect(second.value.diagnostics).toEqual([]);
      // The change really went through didChange, not a second provider.
      expect(second.info.reconnects).toBe(0);
    },
    45_000,
  );

  it(
    'sends $/cancelRequest for an aborted request and keeps serving afterwards',
    async () => {
      const root = await project(PROJECT);
      const client = new LspClient({ root });
      try {
        await client.start();
        // tsserver needs at least one open document to have a project for
        // `workspace/symbol`; that is also the provider's own seeding strategy.
        client.notify('textDocument/didOpen', {
          textDocument: {
            uri: pathToFileURL(join(root, 'a.ts')).href,
            languageId: 'typescript',
            version: 1,
            text: PROJECT['a.ts'],
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        const controller = new AbortController();
        const pending = client.request('workspace/symbol', { query: 'add' }, { signal: controller.signal });
        controller.abort();
        await expect(pending).rejects.toMatchObject({ code: 'LSP_CANCELLED' });
        expect(client.metrics().cancellations).toBeGreaterThanOrEqual(1);

        // The cancelled request used one id; the connection must still work.
        const symbols = await client.request<unknown[]>('workspace/symbol', { query: 'add' });
        expect(Array.isArray(symbols)).toBe(true);
        const opened = await client.request<unknown[]>('textDocument/documentSymbol', {
          textDocument: { uri: pathToFileURL(join(root, 'a.ts')).href },
        });
        expect(Array.isArray(opened)).toBe(true);
      } finally {
        const pid = client.pid;
        await client.dispose();
        if (pid) {
          await waitUntilGone(pid, 5_000);
          expect(isAlive(pid)).toBe(false);
        }
      }
    },
    40_000,
  );

  it(
    'detects SIGKILL, reconnects once, and rebuilds the open-document state',
    async () => {
      const root = await project(PROJECT);
      const provider = await openProvider(root, { files: Object.keys(PROJECT) });
      const before = provider.info();
      const oldPid = before.pid as number;
      expect(oldPid).toBeGreaterThan(0);

      // Force the server to know about b.ts before the crash, so rebuild has
      // something real to restore.
      const first = await provider.definition({ path: 'b.ts', symbol: 'add' });
      expect(first.value.locations[0]?.path).toBe('a.ts');
      expect(provider.info().openDocuments).toBeGreaterThan(0);

      process.kill(oldPid, 'SIGKILL');
      await waitUntilGone(oldPid, 5_000);
      expect(isAlive(oldPid)).toBe(false);

      const recovered = await provider.definition({ path: 'b.ts', symbol: 'add' });
      expect(recovered.value.locations[0]?.path).toBe('a.ts');
      const after = provider.info();
      expect(after.reconnects).toBe(1);
      expect(after.pid).toBeGreaterThan(0);
      expect(after.pid).not.toBe(oldPid);
      expect(isAlive(after.pid as number)).toBe(true);
      expect(after.openDocuments).toBeGreaterThan(0);
      expect(after.notes?.some((note) => note.includes('重启'))).toBe(true);

      // A documentSymbol call needs the rebuilt didOpen for b.ts.
      const symbols = await provider.documentSymbols({ path: 'b.ts' });
      expect(symbols.value.symbols.length).toBeGreaterThan(0);
      expect(symbols.info.reconnects).toBe(1);
    },
    45_000,
  );

  it(
    'labels a temp mirror as a mirror, not as the project',
    async () => {
      const root = await project(PROJECT);
      const provider = await openProvider(root, {
        mirror: true,
        seedPaths: ['a.ts', 'b.ts', 'c.ts'],
      });
      const info = provider.info();
      expect(info.scope?.rootKind).toBe('mirror');
      expect(info.scope?.root).not.toBe(root);
      expect(info.notes?.some((note) => note.includes('临时镜像'))).toBe(true);
      const definition = await provider.definition({ path: 'b.ts', symbol: 'add' });
      expect(definition.value.locations[0]?.path).toBe('a.ts');
      expect(definition.notes.some((note) => note.includes('不是原项目目录'))).toBe(true);
    },
    40_000,
  );

  it(
    'the semantic tool reports language_server metadata only when the child ran',
    async () => {
      const root = await project(PROJECT);
      const withLsp = await findDefinitionTool.contract?.validate({ path: 'b.ts', symbol: 'add' });
      expect(withLsp?.ok).toBe(true);
      if (!withLsp?.ok) return;
      const result = await findDefinitionTool.execute(withLsp.value, toolContext(root, true));
      expect(result.ok).toBe(true);
      expect(result.output).toContain('a.ts:1');
      const meta = result.meta as Record<string, unknown>;
      expect(meta.backend).toBe('language_server');
      const lsp = meta.language_server as Record<string, unknown>;
      expect(lsp.backend).toBe('language_server');
      expect(lsp.transport).toBe('stdio');
      expect(lsp.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(lsp.position_encoding).toBe('utf-16');
      expect(lsp.fallback_reason).toBeNull();
      expect(typeof lsp.pid).toBe('number');
      if (typeof lsp.pid === 'number') watchedPids.push(lsp.pid);
      expect(lsp.capabilities as string[]).toEqual(
        expect.arrayContaining(['definition', 'references']),
      );

      const fallback = await findDefinitionTool.execute(withLsp.value, toolContext(root, false));
      expect(fallback.ok).toBe(true);
      expect(fallback.output).toContain('a.ts:1');
      expect(fallback.output).toContain('内存 TypeScript LanguageService');
      const fallbackMeta = fallback.meta as Record<string, unknown>;
      expect(fallbackMeta.backend).toBe('language_service');
      expect((fallbackMeta.language_server as Record<string, unknown>).backend).toBe('language_service');
    },
    45_000,
  );
});
