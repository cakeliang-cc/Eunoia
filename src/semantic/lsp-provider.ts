/**
 * The LanguageProvider seam, implemented by the real language server.
 *
 * The semantic tools do not speak LSP. They ask a `LanguageProvider` for
 * definitions, references, symbols and diagnostics; this module runs
 * `typescript-language-server` over stdio and answers in the same vocabulary.
 * `language-service-provider.ts` implements the same seam with the in-memory
 * TypeScript `LanguageService`, so the tool contract and its formatting do not
 * change when the server is unavailable.
 *
 * Properties this module is responsible for:
 *
 *   - **cwd is the real project when one exists.** The port supplies a host
 *     note; when it does not, a bounded temp mirror is created and declared as a
 *     mirror in every result. A mirror is never described as the project.
 *   - **document versions.** Every result names the version it was computed
 *     from. A document is opened once, changed with `didChange`, and closed on
 *     dispose; diagnostics that arrive for an older version are returned marked
 *     `stale` rather than passed off as current.
 *   - **one bounded reconnect.** If the server dies, the next request may start
 *     one replacement and re-open every document it had. A second death is
 *     reported; it is not retried forever.
 *   - **1-based model positions.** The model counts code points; LSP counts
 *     UTF-16 units. `code-text.ts` owns that conversion, including CRLF and
 *     CJK/emoji lines.
 */

import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  fromLspPosition,
  isSemanticPath,
  normalizePath,
  resolveSymbolPosition,
  snippetAt,
  toLspPosition,
  type ModelPosition,
} from './code-text.ts';
import { LspClient, LspError, locateLanguageServer, type LspServerInfo } from './lsp-client.ts';

/** Files a single provider may keep open; older ones are closed least-recently-used. */
const MAX_OPEN_DOCUMENTS = 256;
/**
 * When a project has no tsconfig/jsconfig, tsserver's inferred project only
 * contains documents the client opened. Opening a bounded set of scripts is what
 * makes cross-file definition and workspace symbols work there; a larger project
 * is reported as bounded scope, not silently treated as complete.
 */
const MAX_SEEDED_DOCUMENTS = 200;
/** A dependency file is read only to convert a result position, never delivered. */
const MAX_EXTERNAL_READ_BYTES = 2 * 1024 * 1024;
const DEFAULT_DIAGNOSTIC_TIMEOUT_MS = 6_000;
/**
 * tsserver first publishes an empty list when a document opens, then the
 * computed diagnostics. A small settle window keeps that first notification
 * from being reported as "zero errors".
 */
const DIAGNOSTIC_SETTLE_MS = 400;
const MAX_REFS = 100;
const MAX_SYMBOLS = 200;
const MAX_WORKSPACE_SYMBOLS = 50;
/** One automatic restart per provider lifetime. */
const MAX_RECONNECTS = 1;
const IDLE_DISPOSE_MS = 30_000;

export type SemanticBackend = 'language_server' | 'language_service';

export type SemanticProviderErrorCode =
  | 'UNSUPPORTED_LANGUAGE'
  | 'UNSUPPORTED_CAPABILITY'
  | 'POSITION_NOT_RESOLVED'
  | 'FILE_NOT_LOADED'
  | 'LSP_SERVER_MISSING'
  | 'LSP_SPAWN_FAILED'
  | 'LSP_STARTUP_TIMEOUT'
  | 'LSP_PROTOCOL_ERROR'
  | 'LSP_TIMEOUT'
  | 'LSP_CANCELLED'
  | 'LSP_CRASHED'
  | 'LSP_RECONNECT_LIMIT'
  | 'LSP_DIAGNOSTICS_TIMEOUT'
  | 'NO_WORKSPACE_ROOT';

export class SemanticProviderError extends Error {
  readonly code: SemanticProviderErrorCode;
  readonly detail?: Record<string, unknown>;

  constructor(code: SemanticProviderErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = 'SemanticProviderError';
    this.code = code;
    if (detail) this.detail = detail;
  }
}

export interface SemanticTarget {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
  readonly symbol?: string;
}

export interface ProviderLocation {
  /** Workspace-relative when the file is inside the root; absolute otherwise. */
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly endLine?: number;
  readonly endColumn?: number;
  readonly snippet?: string;
  /** True when the range points outside the workspace root (a dependency). */
  readonly external?: boolean;
  /** Set only when the column could not be converted from UTF-16. */
  readonly columnIsUtf16?: boolean;
}

export interface ProviderSymbol {
  readonly name: string;
  readonly kind: string;
  readonly line: number;
  readonly column: number;
  readonly container?: string;
  readonly depth: number;
  /** Set by workspace-symbol queries; document symbols are in the input file. */
  readonly path?: string;
}

export interface ProviderDiagnostic {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly endLine?: number;
  readonly endColumn?: number;
  readonly severity: 'error' | 'warning' | 'info' | 'hint';
  readonly code: string;
  readonly message: string;
}

export interface ProviderScope {
  /** `host` means the server ran in the project directory; `mirror` is a copy. */
  readonly rootKind: 'host' | 'mirror';
  readonly root: string;
  readonly tsconfig: boolean;
  readonly dependencies: boolean;
  readonly typescriptVersion: string | null;
  readonly openDocuments: number;
}

export interface LanguageProviderInfo {
  readonly backend: SemanticBackend;
  readonly server?: string;
  readonly serverVersion?: string | null;
  readonly serverPath?: string;
  readonly pid?: number | null;
  readonly transport?: 'stdio';
  readonly positionEncoding?: 'utf-16';
  readonly scope?: ProviderScope;
  readonly capabilities?: readonly string[];
  readonly reconnects: number;
  readonly cancellations: number;
  readonly refusedServerRequests?: number;
  readonly openDocuments?: number;
  readonly notes?: readonly string[];
}

export interface ProviderResult<T> {
  readonly value: T;
  /** Document version the result was computed from; null when it spans files. */
  readonly documentVersion: number | null;
  /** True when diagnostics came from an older version than the document. */
  readonly stale: boolean;
  readonly info: LanguageProviderInfo;
  readonly notes: readonly string[];
}

export interface LanguageCallOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface ReferencesOptions extends LanguageCallOptions {
  readonly includeDeclaration?: boolean;
  readonly limit?: number;
}

export interface ReferenceResult {
  readonly locations: readonly ProviderLocation[];
  readonly total: number;
  readonly truncated: boolean;
}

export interface DefinitionResult {
  readonly locations: readonly ProviderLocation[];
  readonly symbol: string | null;
}

export interface SymbolsResult {
  readonly symbols: readonly ProviderSymbol[];
  readonly truncated: boolean;
}

export interface DiagnosticsOptions extends LanguageCallOptions {
  /** Files to open and diagnose. Empty means the caller named none. */
  readonly paths?: readonly string[];
  readonly limit?: number;
}

export interface DiagnosticsResult {
  readonly diagnostics: readonly ProviderDiagnostic[];
  /** Per-file document version, so the tool can show what it checked. */
  readonly versions: Readonly<Record<string, number | null>>;
  readonly stale: boolean;
  readonly checked: number;
}

/**
 * What the semantic tools need from a semantic backend.
 *
 * `workspaceSymbols` is intentionally part of the seam even though the in-memory
 * backend cannot answer it: an unsupported capability must be an explicit error,
 * not an empty list that looks like "no such symbol".
 */
export interface LanguageProvider {
  readonly backend: SemanticBackend;
  info(): LanguageProviderInfo;
  sync(path: string): Promise<{ readonly path: string; readonly version: number }>;
  definition(
    target: SemanticTarget,
    options?: LanguageCallOptions,
  ): Promise<ProviderResult<DefinitionResult>>;
  references(
    target: SemanticTarget,
    options?: ReferencesOptions,
  ): Promise<ProviderResult<ReferenceResult>>;
  documentSymbols(
    input: { readonly path: string } & LanguageCallOptions,
  ): Promise<ProviderResult<SymbolsResult>>;
  workspaceSymbols(
    input: { readonly query: string; readonly limit?: number } & LanguageCallOptions,
  ): Promise<ProviderResult<SymbolsResult>>;
  diagnostics(options?: DiagnosticsOptions): Promise<ProviderResult<DiagnosticsResult>>;
  hover(
    target: SemanticTarget,
    options?: LanguageCallOptions,
  ): Promise<ProviderResult<string | null>>;
  dispose(): Promise<void>;
}

/** Reads a workspace file's real content (gutter already removed). */
export type DocumentReader = (path: string) => Promise<string>;

export interface LspProviderOptions {
  /** Absolute host directory, when the port has one. */
  readonly hostRoot?: string | null;
  /** When no host root exists, permit a bounded temp mirror. */
  readonly allowMirror?: boolean;
  /** Files to seed the mirror with (workspace-relative). */
  readonly seedPaths?: readonly string[];
  /**
   * Lazy list of workspace scripts, used only when the root has no tsconfig or
   * jsconfig: the inferred project then needs opened documents.
   */
  readonly listDocuments?: () => Promise<readonly string[]>;
  readonly readDocument: DocumentReader;
  readonly serverPath?: string;
  readonly diagnosticTimeoutMs?: number;
}

interface OpenDocument {
  readonly path: string;
  readonly uri: string;
  readonly languageId: string;
  text: string;
  version: number;
  /** When this text/version became current; disambiguates version-less diagnostics. */
  updatedAt: number;
}

interface DiagnosticRecord {
  readonly version: number | null;
  readonly diagnostics: readonly LspDiagnostic[];
  readonly receivedAt: number;
}

interface DiagnosticWaiter {
  readonly uri: string;
  readonly expectedVersion: number;
  readonly resolve: (record: DiagnosticRecord) => void;
  timer: NodeJS.Timeout | null;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

interface LspDiagnostic {
  readonly range: { readonly start: LspPosition; readonly end: LspPosition };
  readonly severity?: number;
  readonly code?: string | number;
  readonly message: string;
}

interface LspPosition {
  readonly line: number;
  readonly character: number;
}

interface LspRange {
  readonly start: LspPosition;
  readonly end: LspPosition;
}

const SYMBOL_KINDS: Readonly<Record<number, string>> = {
  1: 'file',
  2: 'module',
  3: 'namespace',
  4: 'package',
  5: 'class',
  6: 'method',
  7: 'property',
  8: 'field',
  9: 'constructor',
  10: 'enum',
  11: 'interface',
  12: 'function',
  13: 'variable',
  14: 'constant',
  15: 'string',
  16: 'number',
  17: 'boolean',
  18: 'array',
  19: 'object',
  20: 'key',
  21: 'null',
  22: 'enum member',
  23: 'struct',
  24: 'event',
  25: 'operator',
  26: 'type parameter',
};

const SEVERITIES: Readonly<Record<number, ProviderDiagnostic['severity']>> = {
  1: 'error',
  2: 'warning',
  3: 'info',
  4: 'hint',
};

function languageIdFor(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.tsx')) return 'typescriptreact';
  if (lower.endsWith('.jsx')) return 'javascriptreact';
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'javascript';
  return 'typescript';
}

function fromLspError(error: unknown): SemanticProviderError {
  if (error instanceof SemanticProviderError) return error;
  if (error instanceof LspError) {
    const code = error.code.startsWith('LSP_')
      ? (error.code as SemanticProviderErrorCode)
      : 'LSP_PROTOCOL_ERROR';
    return new SemanticProviderError(code, error.message, error.detail);
  }
  return new SemanticProviderError(
    'LSP_PROTOCOL_ERROR',
    error instanceof Error ? error.message : String(error),
  );
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

function relativeOf(root: string, absolute: string): string {
  const rel = relative(root, absolute);
  return rel.split(sep).join('/');
}

/**
 * A live provider backed by one `typescript-language-server` child.
 *
 * Construction is async because it starts and initializes the process. Use
 * `acquireLanguageProvider` for the cached production path, or `create` directly
 * in tests, where the caller owns the process and must `dispose()` it.
 */
export class LspLanguageProvider implements LanguageProvider {
  readonly backend: SemanticBackend = 'language_server';
  readonly #root: string;
  readonly #rootKind: 'host' | 'mirror';
  readonly #mirrorRoot: string | null;
  readonly #serverPath: string | undefined;
  readonly #locatedVersion: string | null;
  readonly #diagnosticTimeoutMs: number;
  #readDocument: DocumentReader;

  #client: LspClient | null = null;
  #clientInfo: LspServerInfo | null = null;
  #capabilities: string[] = [];
  #typescriptVersion: string | null = null;
  #reconnects = 0;
  #documents = new Map<string, OpenDocument>();
  #diagnostics = new Map<string, DiagnosticRecord>();
  #waiters = new Set<DiagnosticWaiter>();
  #disposed = false;
  #reconnecting: Promise<LspClient> | null = null;
  #openOrder: string[] = [];
  #notes: string[] = [];
  /** Set once the no-tsconfig seeding decision has run. */
  #projectSeeded = false;

  private constructor(options: {
    root: string;
    rootKind: 'host' | 'mirror';
    mirrorRoot: string | null;
    readDocument: DocumentReader;
    serverPath?: string;
    locatedVersion: string | null;
    diagnosticTimeoutMs: number;
  }) {
    this.#root = options.root;
    this.#rootKind = options.rootKind;
    this.#mirrorRoot = options.mirrorRoot;
    this.#readDocument = options.readDocument;
    this.#serverPath = options.serverPath;
    this.#locatedVersion = options.locatedVersion;
    this.#diagnosticTimeoutMs = options.diagnosticTimeoutMs;
  }

  static async create(options: LspProviderOptions): Promise<LspLanguageProvider> {
    const located = locateLanguageServer();
    if (!located) {
      throw new SemanticProviderError(
        'LSP_SERVER_MISSING',
        'typescript-language-server is not installed; the in-memory TypeScript LanguageService is the only backend available',
      );
    }
    let root: string;
    let rootKind: 'host' | 'mirror';
    let mirrorRoot: string | null = null;
    if (options.hostRoot) {
      root = resolve(options.hostRoot);
      rootKind = 'host';
    } else if (options.allowMirror) {
      mirrorRoot = mkdtempSync(join(tmpdir(), 'eunoia-lsp-mirror-'));
      root = mirrorRoot;
      rootKind = 'mirror';
    } else {
      throw new SemanticProviderError(
        'NO_WORKSPACE_ROOT',
        'no host workspace root is available, and a temp mirror was not permitted',
      );
    }
    const provider = new LspLanguageProvider({
      root,
      rootKind,
      mirrorRoot,
      readDocument: options.readDocument,
      ...(options.serverPath ? { serverPath: options.serverPath } : {}),
      locatedVersion: located.version,
      diagnosticTimeoutMs: options.diagnosticTimeoutMs ?? DEFAULT_DIAGNOSTIC_TIMEOUT_MS,
    });
    try {
      if (rootKind === 'mirror') {
        await provider.#seedMirror(options.seedPaths ?? []);
      }
      await provider.#startClient();
      await provider.#seedInferredProject(options);
      installExitHook();
      liveProviders.add(provider);
      return provider;
    } catch (error) {
      await provider.dispose();
      throw error;
    }
  }

  /**
   * A configured project (tsconfig/jsconfig) is discovered by tsserver from the
   * root. Without one, only opened documents exist in the inferred project, so
   * cross-file answers would otherwise resolve to the import alias itself.
   */
  async #seedInferredProject(options: LspProviderOptions): Promise<void> {
    if (this.#projectSeeded) return;
    this.#projectSeeded = true;
    const configured =
      existsSync(join(this.#root, 'tsconfig.json')) || existsSync(join(this.#root, 'jsconfig.json'));
    if (configured) return;
    let candidates: readonly string[];
    if (this.#rootKind === 'mirror' && options.seedPaths) {
      candidates = options.seedPaths;
    } else if (options.listDocuments) {
      try {
        candidates = await options.listDocuments();
      } catch {
        candidates = [];
      }
    } else {
      candidates = [];
    }
    const paths = [...new Set(candidates.map(normalizePath))]
      .filter((path) => isSemanticPath(path))
      .slice(0, MAX_SEEDED_DOCUMENTS);
    const client = this.#client;
    if (!client) return;
    let opened = 0;
    for (const path of paths) {
      try {
        await this.#syncDocument(client, path);
        opened += 1;
      } catch {
        // A file the port refuses is not part of the project.
      }
    }
    if (opened > 0) {
      this.#notes.push(
        `没有 tsconfig.json/jsconfig.json：已打开前 ${opened} 个脚本文件建立推断项目（上限 ${MAX_SEEDED_DOCUMENTS}），更大项目的跨文件结果可能不完整`,
      );
    } else {
      this.#notes.push('没有 tsconfig.json/jsconfig.json，也没有可打开的脚本文件：项目推断为空');
    }
  }

  /** Replace the document source when a cached provider is leased again. */
  setDocumentReader(reader: DocumentReader): void {
    this.#readDocument = reader;
  }

  async #seedMirror(paths: readonly string[]): Promise<void> {
    let bytes = 0;
    let seeded = 0;
    for (const path of paths.slice(0, 400)) {
      if (!isSemanticPath(path)) continue;
      try {
        const text = await this.#readDocument(path);
        const size = Buffer.byteLength(text, 'utf8');
        if (bytes + size > 4 * 1024 * 1024) break;
        const absolute = this.#absolute(path);
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, text, 'utf8');
        bytes += size;
        seeded += 1;
      } catch {
        // A file the port refuses is not part of the mirror.
      }
    }
    this.#notes.push(
      `临时镜像 ${this.#root}（${seeded} 个文件，${Math.ceil(bytes / 1024)} KiB）：不是原项目目录，依赖与类型可能无法解析`,
    );
  }

  async #startClient(): Promise<LspClient> {
    if (this.#disposed) {
      throw new SemanticProviderError('LSP_CRASHED', 'language provider was disposed');
    }
    const client = new LspClient({
      root: this.#root,
      ...(this.#serverPath ? { serverPath: this.#serverPath } : {}),
      onLog: (message) => this.#recordServerLog(message),
    });
    client.onDiagnostics((uri, version, diagnostics) => {
      this.#onDiagnostics(uri, version, diagnostics as LspDiagnostic[]);
    });
    client.onCrash(() => {
      // The next operation observes `alive === false` and reconnects once.
      // Nothing is retried in the background: a broken server must not mutate
      // state without a caller waiting for an answer.
    });
    try {
      await client.start();
    } catch (error) {
      await client.dispose();
      throw fromLspError(error);
    }
    this.#client = client;
    this.#clientInfo = client.serverInfo;
    this.#capabilities = client.capabilitySummary();
    this.#typescriptVersion = client.typescriptVersion ?? this.#typescriptVersion;
    return client;
  }

  #recordServerLog(message: string): void {
    const version = /Using (?:Typescript|TypeScript) version[^0-9]*([0-9]+\.[0-9]+\.[0-9]+)/i.exec(message);
    if (version?.[1]) this.#typescriptVersion = version[1];
  }

  #absolute(path: string): string {
    const absolute = isAbsolute(path)
      ? resolve(path)
      : resolve(this.#root, normalizePath(path));
    if (!inside(this.#root, absolute)) {
      throw new SemanticProviderError('FILE_NOT_LOADED', `${path} is outside the language server root`);
    }
    return absolute;
  }

  #relativePath(absolute: string): string | null {
    if (!inside(this.#root, absolute)) return null;
    return relativeOf(this.#root, absolute);
  }

  #uri(path: string): string {
    return pathToFileURL(this.#absolute(path)).href;
  }

  #languageId(path: string): string {
    return languageIdFor(path);
  }

  async #syncDocument(client: LspClient, path: string): Promise<OpenDocument> {
    const normalized = normalizePath(path);
    if (!isSemanticPath(normalized)) {
      throw new SemanticProviderError(
        'UNSUPPORTED_LANGUAGE',
        `语义工具只支持 TypeScript/JavaScript。${normalized} 需要另一个语言服务适配器，当前不会用文本搜索冒充。`,
      );
    }
    const text = await this.#readDocument(normalized);
    if (this.#rootKind === 'mirror') {
      const absolute = this.#absolute(normalized);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, text, 'utf8');
    }
    const existing = this.#documents.get(normalized);
    if (existing) {
      if (existing.text === text) {
        this.#touch(normalized);
        return existing;
      }
      const version = existing.version + 1;
      const updated: OpenDocument = { ...existing, text, version, updatedAt: Date.now() };
      this.#documents.set(normalized, updated);
      this.#openOrder = [...this.#openOrder.filter((entry) => entry !== normalized), normalized];
      client.notify('textDocument/didChange', {
        textDocument: { uri: updated.uri, version },
        contentChanges: [{ text }],
      });
      return updated;
    }
    const uri = this.#uri(normalized);
    const document: OpenDocument = {
      path: normalized,
      uri,
      languageId: this.#languageId(normalized),
      text,
      version: 1,
      updatedAt: Date.now(),
    };
    this.#documents.set(normalized, document);
    this.#openOrder.push(normalized);
    client.notify('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: document.languageId,
        version: document.version,
        text,
      },
    });
    await this.#evictDocuments(client);
    return document;
  }

  #touch(path: string): void {
    this.#openOrder = [...this.#openOrder.filter((entry) => entry !== path), path];
  }

  async #evictDocuments(client: LspClient): Promise<void> {
    while (this.#openOrder.length > MAX_OPEN_DOCUMENTS) {
      const oldest = this.#openOrder.shift();
      if (!oldest) return;
      const document = this.#documents.get(oldest);
      if (!document) continue;
      this.#documents.delete(oldest);
      this.#diagnostics.delete(document.uri);
      client.notify('textDocument/didClose', { textDocument: { uri: document.uri } });
    }
  }

  async sync(path: string): Promise<{ readonly path: string; readonly version: number }> {
    const client = await this.#ensureClient();
    const document = await this.#syncDocument(client, path);
    return { path: document.path, version: document.version };
  }

  async #ensureClient(): Promise<LspClient> {
    if (this.#disposed) {
      throw new SemanticProviderError('LSP_CRASHED', 'language provider was disposed');
    }
    if (this.#client?.alive) return this.#client;
    if (this.#client !== null) return await this.#reconnect();
    return await this.#startClient();
  }

  async #reconnect(): Promise<LspClient> {
    if (this.#reconnecting) return await this.#reconnecting;
    if (this.#reconnects >= MAX_RECONNECTS) {
      throw new SemanticProviderError(
        'LSP_RECONNECT_LIMIT',
        `typescript-language-server 已经崩溃并重启过一次（最后一次错误：${
          this.#client?.stderrTail.trim() || 'unknown'
        }）；不会无限重连`,
      );
    }
    this.#reconnecting = (async () => {
      this.#reconnects += 1;
      const previous = this.#client;
      this.#client = null;
      if (previous) await previous.dispose().catch(() => undefined);
      // Diagnostics from the dead process are not evidence about the new one.
      this.#diagnostics.clear();
      const client = await this.#startClient();
      const documents = [...this.#documents.values()];
      for (const document of documents) {
        client.notify('textDocument/didOpen', {
          textDocument: {
            uri: document.uri,
            languageId: document.languageId,
            version: document.version,
            text: document.text,
          },
        });
      }
      this.#notes = this.#notes.filter((note) => !note.startsWith('语言服务器已重启'));
      this.#notes.push(
        `语言服务器已重启 1 次并重建 ${documents.length} 个已打开文档（受限重连）`,
      );
      return client;
    })();
    try {
      return await this.#reconnecting;
    } finally {
      this.#reconnecting = null;
    }
  }

  async #runWithReconnect<T>(action: (client: LspClient) => Promise<T>): Promise<T> {
    let client = await this.#ensureClient();
    try {
      return await action(client);
    } catch (error) {
      if (!(error instanceof LspError) || error.code !== 'LSP_CRASHED') throw fromLspError(error);
      client = await this.#reconnect();
      return await action(client);
    }
  }

  info(): LanguageProviderInfo {
    const tsconfig = existsSync(join(this.#root, 'tsconfig.json'));
    const dependencies = existsSync(join(this.#root, 'node_modules', 'typescript', 'package.json'));
    const installedTs = dependencies ? this.#readTypeScriptVersion() : null;
    const notes = [...this.#notes];
    if (this.#rootKind === 'host' && !dependencies) {
      notes.push('项目目录没有 node_modules/typescript：第三方类型可能无法解析，不宣称完整项目零错误');
    }
    if (this.#rootKind === 'host' && !tsconfig) {
      notes.push('项目目录没有 tsconfig.json：语言服务器使用默认编译选项');
    }
    if (this.#reconnects > 0) {
      notes.push(`语言服务器重启 ${this.#reconnects} 次；文档状态已重建`);
    }
    const client = this.#client;
    return {
      backend: 'language_server',
      server: this.#clientInfo?.name ?? 'typescript-language-server',
      serverVersion: this.#clientInfo?.version ?? this.#locatedVersion,
      ...(this.#serverPath ? { serverPath: this.#serverPath } : {}),
      pid: client?.pid ?? null,
      transport: 'stdio',
      positionEncoding: 'utf-16',
      scope: {
        rootKind: this.#rootKind,
        root: this.#root,
        tsconfig,
        dependencies,
        typescriptVersion: this.#typescriptVersion ?? installedTs,
        openDocuments: this.#documents.size,
      },
      capabilities: this.#capabilities,
      reconnects: this.#reconnects,
      cancellations: client?.metrics().cancellations ?? 0,
      refusedServerRequests: client?.metrics().refusedServerRequests ?? 0,
      openDocuments: this.#documents.size,
      notes,
    };
  }

  #readTypeScriptVersion(): string | null {
    try {
      const metadata = JSON.parse(
        readFileSync(join(this.#root, 'node_modules', 'typescript', 'package.json'), 'utf8'),
      ) as { version?: string };
      return metadata.version ?? null;
    } catch {
      return null;
    }
  }

  async #resolveTarget(
    client: LspClient,
    target: SemanticTarget,
  ): Promise<{ document: OpenDocument; position: LspPosition }> {
    const document = await this.#syncDocument(client, target.path);
    let model: ModelPosition | null = null;
    if (target.symbol && target.symbol.trim().length > 0) {
      model = resolveSymbolPosition(document.text, target.symbol);
    } else if (target.line !== undefined && target.column !== undefined) {
      if (target.line >= 1 && target.column >= 1) {
        model = { line: target.line, column: target.column };
      }
    }
    if (!model) {
      throw new SemanticProviderError(
        'POSITION_NOT_RESOLVED',
        'could not resolve a position: pass line + column (1-based) or a symbol that appears in the file',
      );
    }
    const position = toLspPosition(document.text, model);
    if (!position) {
      throw new SemanticProviderError(
        'POSITION_NOT_RESOLVED',
        'could not resolve a position: line/column is outside the document',
      );
    }
    return { document, position };
  }

  async definition(
    target: SemanticTarget,
    options: LanguageCallOptions = {},
  ): Promise<ProviderResult<DefinitionResult>> {
    return await this.#runWithReconnect(async (client) => {
      const { document, position } = await this.#resolveTarget(client, target);
      const response = await client.request<unknown>(
        'textDocument/definition',
        {
          textDocument: { uri: document.uri },
          position,
        },
        { signal: options.signal, timeoutMs: options.timeoutMs },
      );
      const locations = this.#normalizeLocations(response, document);
      const symbol = await this.#hoverText(client, document, position, options.signal);
      return {
        value: { locations, symbol },
        documentVersion: document.version,
        stale: false,
        info: this.info(),
        notes: this.#resultNotes(),
      };
    });
  }

  async #hoverText(
    client: LspClient,
    document: OpenDocument,
    position: LspPosition,
    signal?: AbortSignal,
  ): Promise<string | null> {
    try {
      const hover = await client.request<{ contents?: unknown } | null>(
        'textDocument/hover',
        { textDocument: { uri: document.uri }, position },
        { timeoutMs: 2_000, ...(signal ? { signal } : {}) },
      );
      return hoverContentsToText(hover?.contents);
    } catch {
      // Hover is enrichment, not the answer. A timeout must not fail a definition.
      return null;
    }
  }

  #normalizeLocations(
    response: unknown,
    primary: OpenDocument,
  ): ProviderLocation[] {
    const raw: Array<{ uri: string; range: LspRange }> = [];
    const visit = (entry: unknown): void => {
      if (!entry || typeof entry !== 'object') return;
      const value = entry as Record<string, unknown>;
      if (typeof value.targetUri === 'string') {
        const range = (value.targetSelectionRange ?? value.targetRange) as LspRange | undefined;
        if (range) raw.push({ uri: value.targetUri, range });
        return;
      }
      if (typeof value.uri === 'string' && value.range) {
        raw.push({ uri: value.uri, range: value.range as LspRange });
      }
    };
    if (Array.isArray(response)) {
      for (const entry of response.slice(0, MAX_REFS)) visit(entry);
    } else {
      visit(response);
    }
    return raw.map((entry) => this.#locationFromUri(entry.uri, entry.range, primary));
  }

  async references(
    target: SemanticTarget,
    options: ReferencesOptions = {},
  ): Promise<ProviderResult<ReferenceResult>> {
    return await this.#runWithReconnect(async (client) => {
      const { document, position } = await this.#resolveTarget(client, target);
      const includeDeclaration = options.includeDeclaration !== false;
      const limit = Math.max(1, Math.min(options.limit ?? MAX_REFS, MAX_REFS));
      const response = await client.request<unknown>(
        'textDocument/references',
        {
          textDocument: { uri: document.uri },
          position,
          context: { includeDeclaration },
        },
        { signal: options.signal, timeoutMs: options.timeoutMs },
      );
      const entries = Array.isArray(response) ? response : [];
      const locations = entries
        .slice(0, limit)
        .map((entry) => {
          const value = entry as { uri?: string; range?: LspRange };
          if (typeof value.uri !== 'string' || !value.range) return null;
          return this.#locationFromUri(value.uri, value.range, document);
        })
        .filter((entry): entry is ProviderLocation => entry !== null);
      return {
        value: { locations, total: entries.length, truncated: entries.length > limit },
        documentVersion: document.version,
        stale: false,
        info: this.info(),
        notes: this.#resultNotes(),
      };
    });
  }

  #locationFromUri(uri: string, range: LspRange, primary: OpenDocument): ProviderLocation {
    let absolute: string;
    try {
      absolute = fileURLToPath(uri);
    } catch {
      absolute = uri;
    }
    const relativePath = this.#relativePath(absolute);
    const path = relativePath ?? absolute;
    const text = this.#textForLocation(absolute, primary);
    if (!text) {
      return {
        path,
        line: range.start.line + 1,
        column: range.start.character + 1,
        endLine: range.end.line + 1,
        endColumn: range.end.character + 1,
        ...(relativePath === null ? { external: true, columnIsUtf16: true } : {}),
      };
    }
    const start = fromLspPosition(text, range.start);
    const end = fromLspPosition(text, range.end);
    return {
      path,
      line: start.line,
      column: start.column,
      endLine: end.line,
      endColumn: end.column,
      ...(relativePath === null ? { external: true } : {}),
      ...(relativePath !== null ? { snippet: snippetAt(text, start) } : {}),
    };
  }

  #textForLocation(absolute: string, primary: OpenDocument): string | null {
    if (absolute === this.#absolute(primary.path)) return primary.text;
    const relativePath = this.#relativePath(absolute);
    if (relativePath === null) return null;
    const known = this.#documents.get(relativePath);
    if (known) return known.text;
    try {
      const info = statSync(absolute);
      if (!info.isFile() || info.size > MAX_EXTERNAL_READ_BYTES) return null;
      return readFileSync(absolute, 'utf8');
    } catch {
      return null;
    }
  }

  async documentSymbols(
    input: { readonly path: string } & LanguageCallOptions,
  ): Promise<ProviderResult<SymbolsResult>> {
    return await this.#runWithReconnect(async (client) => {
      const document = await this.#syncDocument(client, input.path);
      const response = await client.request<unknown>(
        'textDocument/documentSymbol',
        { textDocument: { uri: document.uri } },
        { signal: input.signal, timeoutMs: input.timeoutMs },
      );
      const symbols = this.#flattenDocumentSymbols(response, document);
      return {
        value: { symbols: symbols.slice(0, MAX_SYMBOLS), truncated: symbols.length > MAX_SYMBOLS },
        documentVersion: document.version,
        stale: false,
        info: this.info(),
        notes: this.#resultNotes(),
      };
    });
  }

  #flattenDocumentSymbols(response: unknown, document: OpenDocument): ProviderSymbol[] {
    if (!Array.isArray(response)) return [];
    const rows: ProviderSymbol[] = [];
    const walk = (entry: unknown, depth: number): void => {
      if (rows.length >= MAX_SYMBOLS || !entry || typeof entry !== 'object') return;
      const value = entry as Record<string, unknown>;
      const name = typeof value.name === 'string' ? value.name : '?';
      const kind = SYMBOL_KINDS[Number(value.kind)] ?? 'symbol';
      const container = typeof value.containerName === 'string' ? value.containerName : undefined;
      const location = value.location as { range?: LspRange } | undefined;
      const range = (value.selectionRange ?? value.range ?? location?.range) as LspRange | undefined;
      if (range) {
        const position = fromLspPosition(document.text, range.start);
        rows.push({
          name,
          kind,
          line: position.line,
          column: position.column,
          ...(container ? { container } : {}),
          depth,
        });
      }
      if (Array.isArray(value.children)) {
        for (const child of value.children) walk(child, depth + 1);
      }
    };
    for (const entry of response) walk(entry, 0);
    return rows;
  }

  async workspaceSymbols(
    input: { readonly query: string; readonly limit?: number } & LanguageCallOptions,
  ): Promise<ProviderResult<SymbolsResult>> {
    const query = input.query.trim();
    if (query.length === 0) {
      throw new SemanticProviderError('POSITION_NOT_RESOLVED', 'workspace symbol query is empty');
    }
    return await this.#runWithReconnect(async (client) => {
      if (!this.#capabilities.includes('workspaceSymbol')) {
        throw new SemanticProviderError(
          'UNSUPPORTED_CAPABILITY',
          'the language server did not advertise workspaceSymbol; workspace symbol search is unavailable',
        );
      }
      const limit = Math.max(1, Math.min(input.limit ?? MAX_WORKSPACE_SYMBOLS, MAX_WORKSPACE_SYMBOLS));
      const response = await client.request<unknown>(
        'workspace/symbol',
        { query },
        { signal: input.signal, timeoutMs: input.timeoutMs },
      );
      const entries = Array.isArray(response) ? response : [];
      const symbols: ProviderSymbol[] = [];
      for (const entry of entries.slice(0, limit)) {
        if (!entry || typeof entry !== 'object') continue;
        const value = entry as Record<string, unknown>;
        const name = typeof value.name === 'string' ? value.name : '?';
        const location = value.location as { uri?: string; range?: LspRange } | undefined;
        const range = location?.range;
        if (!location?.uri || !range) continue;
        const absolute = fileURLToPath(location.uri);
        const relativePath = this.#relativePath(absolute);
        if (relativePath === null) continue;
        let text: string | null = null;
        const known = this.#documents.get(relativePath);
        text = known?.text ?? null;
        if (text === null) {
          try {
            const info = statSync(absolute);
            if (info.isFile() && info.size <= MAX_EXTERNAL_READ_BYTES) text = readFileSync(absolute, 'utf8');
          } catch {
            text = null;
          }
        }
        if (text === null) continue;
        const position = fromLspPosition(text, range.start);
        symbols.push({
          name,
          kind: SYMBOL_KINDS[Number(value.kind)] ?? 'symbol',
          line: position.line,
          column: position.column,
          ...(typeof value.containerName === 'string' ? { container: value.containerName } : {}),
          depth: 0,
          path: relativePath,
        });
      }
      return {
        value: { symbols, truncated: entries.length > limit },
        documentVersion: null,
        stale: false,
        info: this.info(),
        notes: [
          ...this.#resultNotes(),
          ...(symbols.length === 0 ? ['工作区符号查询没有结果（有界查询，最多 50 个）'] : []),
        ],
      };
    });
  }

  async diagnostics(
    options: DiagnosticsOptions = {},
  ): Promise<ProviderResult<DiagnosticsResult>> {
    const paths = [...new Set((options.paths ?? []).map(normalizePath))];
    if (paths.length === 0) {
      throw new SemanticProviderError('FILE_NOT_LOADED', 'diagnostics needs at least one path to check');
    }
    const limit = Math.max(1, Math.min(options.limit ?? paths.length, 20));
    const targets = paths.slice(0, limit);
    return await this.#runWithReconnect(async (client) => {
      const documents = new Map<string, OpenDocument>();
      for (const path of targets) {
        documents.set(path, await this.#syncDocument(client, path));
      }
      const records = await Promise.all(
        [...documents.values()].map(async (document) => {
          const record = await this.#waitForDiagnostics(
            document,
            this.#diagnosticTimeoutMs,
            options.signal,
          );
          return { document, record };
        }),
      );
      const diagnostics: ProviderDiagnostic[] = [];
      const versions: Record<string, number | null> = {};
      let stale = false;
      for (const { document, record } of records) {
        // tsserver omits `version` in publishDiagnostics; the document version
        // we accepted the notification for is the honest binding.
        versions[document.path] = record.record.version ?? document.version;
        if (record.stale) stale = true;
        const text = document.text;
        for (const diagnostic of record.record.diagnostics) {
          const start = fromLspPosition(text, diagnostic.range.start);
          const end = fromLspPosition(text, diagnostic.range.end);
          diagnostics.push({
            path: document.path,
            line: start.line,
            column: start.column,
            endLine: end.line,
            endColumn: end.column,
            severity: SEVERITIES[diagnostic.severity ?? 1] ?? 'error',
            code:
              typeof diagnostic.code === 'number'
                ? `TS${diagnostic.code}`
                : String(diagnostic.code ?? 'TS?'),
            message: diagnostic.message,
          });
        }
      }
      diagnostics.sort((left, right) =>
        left.path === right.path ? left.line - right.line || left.column - right.column : left.path.localeCompare(right.path),
      );
      const maxVersion = records.reduce<number | null>((max, entry) => {
        const version = entry.document.version;
        return max === null || version > max ? version : max;
      }, null);
      return {
        value: { diagnostics, versions, stale, checked: documents.size },
        documentVersion: maxVersion,
        stale,
        info: this.info(),
        notes: [
          ...this.#resultNotes(),
          ...(stale ? ['诊断版本落后于已修改的文档，结果标记为 stale'] : []),
        ],
      };
    });
  }

  async #waitForDiagnostics(
    document: OpenDocument,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ record: DiagnosticRecord; stale: boolean }> {
    const cached = this.#diagnostics.get(document.uri);
    if (cached && this.#diagnosticsAreCurrent(cached, document)) {
      return await this.#settleDiagnostics(document, cached, signal);
    }
    if (signal?.aborted) {
      throw new SemanticProviderError('LSP_CANCELLED', 'diagnostics request was cancelled');
    }
    const record = await new Promise<DiagnosticRecord | null>((resolveWait) => {
      const waiter: DiagnosticWaiter = {
        uri: document.uri,
        expectedVersion: document.version,
        resolve: (value) => resolveWait(value),
        timer: null,
        ...(signal ? { signal } : {}),
        ...(signal
          ? {
              onAbort: () => {
                this.#waiters.delete(waiter);
                if (waiter.timer) clearTimeout(waiter.timer);
                resolveWait(null);
              },
            }
          : {}),
      };
      this.#waiters.add(waiter);
      waiter.timer = setTimeout(() => {
        this.#waiters.delete(waiter);
        resolveWait(null);
      }, timeoutMs);
      waiter.timer.unref?.();
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
    });
    if (signal?.aborted) {
      throw new SemanticProviderError('LSP_CANCELLED', 'diagnostics request was cancelled');
    }
    if (record) return await this.#settleDiagnostics(document, record, signal);
    const fallback = this.#diagnostics.get(document.uri);
    if (fallback) {
      // A stale answer is more useful than a timeout, but it is labelled as
      // stale and never presented as the current document's diagnostics.
      return { record: fallback, stale: !this.#diagnosticsAreCurrent(fallback, document) };
    }
    throw new SemanticProviderError(
      'LSP_DIAGNOSTICS_TIMEOUT',
      `language server 没有在 ${timeoutMs} ms 内返回 ${document.path} 的诊断；未就绪或丢失的响应不能当作零错误`,
    );
  }

  /**
   * Give a just-arrived record a chance to be superseded.
   *
   * The fetch is a push notification, and tsserver emits an empty list first.
   * The settled record is still required to belong to the current document
   * version; the delay never turns an old answer into a current one.
   */
  async #settleDiagnostics(
    document: OpenDocument,
    first: DiagnosticRecord,
    signal?: AbortSignal,
  ): Promise<{ record: DiagnosticRecord; stale: boolean }> {
    await abortableDelay(DIAGNOSTIC_SETTLE_MS, signal);
    const latest = this.#diagnostics.get(document.uri);
    if (latest && this.#diagnosticsAreCurrent(latest, document)) {
      return { record: latest, stale: false };
    }
    return { record: first, stale: false };
  }

  /**
   * Is this diagnostic record evidence about the document's current text?
   *
   * A version is the strong answer. A server that omits `version` (allowed by
   * LSP) is accepted only when the notification arrived after the last
   * didOpen/didChange, so an old result cannot masquerade as the new one.
   */
  #diagnosticsAreCurrent(record: DiagnosticRecord, document: OpenDocument): boolean {
    if (record.version !== null) return record.version >= document.version;
    return record.receivedAt >= document.updatedAt;
  }

  #waiterMatches(waiter: DiagnosticWaiter, record: DiagnosticRecord): boolean {
    if (record.version !== null) return record.version >= waiter.expectedVersion;
    let document: OpenDocument | undefined;
    try {
      const relativePath = this.#relativePath(fileURLToPath(waiter.uri));
      document = relativePath === null ? undefined : this.#documents.get(relativePath);
    } catch {
      document = undefined;
    }
    return document ? record.receivedAt >= document.updatedAt : true;
  }

  #onDiagnostics(uri: string, version: number | null, diagnostics: readonly LspDiagnostic[]): void {
    const record: DiagnosticRecord = { version, diagnostics, receivedAt: Date.now() };
    this.#diagnostics.set(uri, record);
    for (const waiter of [...this.#waiters]) {
      if (waiter.uri !== uri) continue;
      if (!this.#waiterMatches(waiter, record)) continue;
      this.#waiters.delete(waiter);
      if (waiter.timer) clearTimeout(waiter.timer);
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      waiter.resolve(record);
    }
  }

  async hover(
    target: SemanticTarget,
    options: LanguageCallOptions = {},
  ): Promise<ProviderResult<string | null>> {
    return await this.#runWithReconnect(async (client) => {
      const { document, position } = await this.#resolveTarget(client, target);
      const hover = await client.request<{ contents?: unknown } | null>(
        'textDocument/hover',
        { textDocument: { uri: document.uri }, position },
        { signal: options.signal, timeoutMs: options.timeoutMs },
      );
      return {
        value: hoverContentsToText(hover?.contents),
        documentVersion: document.version,
        stale: false,
        info: this.info(),
        notes: this.#resultNotes(),
      };
    });
  }

  #resultNotes(): string[] {
    const notes = [...this.#notes];
    if (!existsSync(join(this.#root, 'node_modules', 'typescript', 'package.json'))) {
      notes.push('依赖未加载：第三方类型可能无法解析，结果不是完整项目零错误证明');
    }
    return notes;
  }

  /** For the process-exit hook. Never awaited. */
  killNow(): void {
    this.#client?.killNow();
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    liveProviders.delete(this);
    const client = this.#client;
    this.#client = null;
    if (client) {
      for (const document of this.#documents.values()) {
        client.notify('textDocument/didClose', { textDocument: { uri: document.uri } });
      }
      await client.dispose();
    }
    this.#documents.clear();
    this.#diagnostics.clear();
    for (const waiter of this.#waiters) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve({ version: null, diagnostics: [], receivedAt: Date.now() });
    }
    this.#waiters.clear();
    if (this.#mirrorRoot) {
      await rm(this.#mirrorRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw new SemanticProviderError('LSP_CANCELLED', 'diagnostics request was cancelled');
  }
  await new Promise<void>((resolveDelay, rejectDelay) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolveDelay();
    }, ms);
    timer.unref?.();
    const onAbort = (): void => {
      clearTimeout(timer);
      rejectDelay(new SemanticProviderError('LSP_CANCELLED', 'diagnostics request was cancelled'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function hoverContentsToText(contents: unknown): string | null {
  const raw = hoverContentsRaw(contents);
  if (raw === null) return null;
  const lines = raw
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => !line.trim().startsWith('```'));
  const text = lines.join('\n').trim();
  return text.length > 0 ? text : null;
}

function hoverContentsRaw(contents: unknown): string | null {
  if (typeof contents === 'string') return contents;
  if (Array.isArray(contents)) {
    const parts = contents
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object' && typeof (entry as { value?: unknown }).value === 'string') {
          return (entry as { value: string }).value;
        }
        return '';
      })
      .filter((entry) => entry.length > 0);
    return parts.join('\n') || null;
  }
  if (contents && typeof contents === 'object') {
    const value = (contents as { value?: unknown }).value;
    if (typeof value === 'string') return value;
  }
  return null;
}

// ------------------------------------------------------------------ registry ---

interface RegistryEntry {
  readonly provider: LspLanguageProvider;
  refs: number;
  idleTimer: NodeJS.Timeout | null;
}

export interface ProviderLease {
  readonly provider: LspLanguageProvider;
  release(): void;
}

const registry = new Map<string, RegistryEntry>();
const pendingCreations = new Map<string, Promise<RegistryEntry>>();
const recentFailures = new Map<string, { readonly at: number; readonly error: SemanticProviderError }>();
const liveProviders = new Set<LspLanguageProvider>();
const FAILURE_TTL_MS = 30_000;
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // Synchronous last resort: a SIGTERM'd server must not leave language-server
  // children behind. Normal disposal is explicit and speaks the protocol.
  process.once('exit', () => {
    for (const provider of liveProviders) provider.killNow();
  });
}

/**
 * Lease the cached provider for a host root, or create a mirror provider that the
 * caller owns.
 *
 * A provider is kept alive between tool calls so `didChange` actually means
 * something; it is disposed after 30 s without a lease (the timer is unref'd),
 * and `shutdownLanguageProviders()` closes everything eagerly.
 */
export async function acquireLanguageProvider(options: LspProviderOptions): Promise<ProviderLease> {
  if (!options.hostRoot) {
    const provider = await LspLanguageProvider.create(options);
    return { provider, release: () => void provider.dispose() };
  }
  installExitHook();
  const key = resolve(options.hostRoot);
  const failure = recentFailures.get(key);
  if (failure && Date.now() - failure.at < FAILURE_TTL_MS) {
    throw failure.error;
  }
  const existing = registry.get(key);
  if (existing) {
    entryLease(existing, options.readDocument);
    return makeLease(key, existing);
  }
  const pending = pendingCreations.get(key);
  if (pending) {
    const entry = await pending;
    entryLease(entry, options.readDocument);
    return makeLease(key, entry);
  }
  const creation = (async (): Promise<RegistryEntry> => {
    try {
      const provider = await LspLanguageProvider.create(options);
      const entry: RegistryEntry = { provider, refs: 0, idleTimer: null };
      registry.set(key, entry);
      return entry;
    } catch (error) {
      const failureError =
        error instanceof SemanticProviderError
          ? error
          : new SemanticProviderError(
              'LSP_PROTOCOL_ERROR',
              error instanceof Error ? error.message : String(error),
            );
      recentFailures.set(key, { at: Date.now(), error: failureError });
      throw failureError;
    } finally {
      pendingCreations.delete(key);
    }
  })();
  pendingCreations.set(key, creation);
  const entry = await creation;
  entryLease(entry, options.readDocument);
  return makeLease(key, entry);
}

function entryLease(entry: RegistryEntry, reader: DocumentReader): void {
  entry.refs += 1;
  entry.provider.setDocumentReader(reader);
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
}

function makeLease(key: string, entry: RegistryEntry): ProviderLease {
  let released = false;
  return {
    provider: entry.provider,
    release: () => {
      if (released) return;
      released = true;
      entry.refs = Math.max(0, entry.refs - 1);
      if (entry.refs > 0) return;
      if (registry.get(key) !== entry) return;
      entry.idleTimer = setTimeout(() => {
        if (entry.refs > 0) return;
        if (registry.get(key) === entry) registry.delete(key);
        void entry.provider.dispose().catch(() => undefined);
      }, IDLE_DISPOSE_MS);
      entry.idleTimer.unref?.();
    },
  };
}

/** Close every cached language server. Tests and service shutdown call this. */
export async function shutdownLanguageProviders(): Promise<void> {
  const entries = [...registry.values()];
  registry.clear();
  pendingCreations.clear();
  recentFailures.clear();
  for (const entry of entries) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
  await Promise.all(entries.map((entry) => entry.provider.dispose().catch(() => undefined)));
}
