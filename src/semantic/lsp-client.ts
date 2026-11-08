/**
 * A bounded JSON-RPC client for a real `typescript-language-server` process.
 *
 * This is deliberately not a general LSP library. It speaks the small part of
 * the protocol the semantic tools need, and it enforces the limits that keep a
 * language server from becoming a second, unsupervised execution path:
 *
 *   - one child process per client, spawned with a fixed cwd and a constructed
 *     environment (`PATH`, a private `HOME`, no inherited credentials);
 *   - startup, per-request and shutdown timeouts; a request that exceeds its
 *     deadline is cancelled with `$/cancelRequest` and rejected;
 *   - bounded frames and a bounded stderr tail, so a broken server cannot grow
 *     memory without limit;
 *   - server-initiated `workspace/applyEdit` and `window/showMessageRequest` are
 *     refused, `workspace/configuration` gets an empty answer, and dynamic
 *     capability registration is acknowledged but never acted on. The client
 *     loads no plugins and executes no server command.
 *
 * The architectural boundary test that forbids `node:child_process` outside the
 * sandbox runtime lists this file explicitly: a language server is not a command
 * runner, and the tool layer still reaches it only through `LanguageProvider`.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const MAX_LOG_LINES = 100;

export type LspErrorCode =
  | 'LSP_SERVER_MISSING'
  | 'LSP_SPAWN_FAILED'
  | 'LSP_STARTUP_TIMEOUT'
  | 'LSP_PROTOCOL_ERROR'
  | 'LSP_TIMEOUT'
  | 'LSP_CANCELLED'
  | 'LSP_CRASHED'
  | 'LSP_DISPOSED';

export class LspError extends Error {
  readonly code: LspErrorCode;
  readonly detail?: Record<string, unknown>;

  constructor(code: LspErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = 'LspError';
    this.code = code;
    if (detail) this.detail = detail;
  }
}

export interface LocatedLanguageServer {
  /** Absolute path to the server's JavaScript entry (the package `bin`). */
  readonly path: string;
  readonly version: string;
  readonly packagePath: string;
}

/**
 * Locate the installed server through Node's resolver, not through `PATH`.
 *
 * `EUNOIA_TYPESCRIPT_LANGUAGE_SERVER` exists for an operator who installs the
 * package outside this project; it is process configuration, never a model
 * argument. A missing package is a normal, reported condition.
 */
export function locateLanguageServer(): LocatedLanguageServer | null {
  const override = process.env.EUNOIA_TYPESCRIPT_LANGUAGE_SERVER?.trim();
  if (override && existsSync(override)) {
    return { path: override, version: 'unknown', packagePath: override };
  }
  const require = createRequire(import.meta.url);
  try {
    const packagePath = require.resolve('typescript-language-server/package.json');
    const metadata = JSON.parse(readFileSync(packagePath, 'utf8')) as {
      version?: string;
      bin?: string | Record<string, string>;
    };
    const bin =
      typeof metadata.bin === 'string'
        ? metadata.bin
        : metadata.bin?.['typescript-language-server'];
    if (bin) {
      const serverPath = resolve(dirname(packagePath), bin);
      if (existsSync(serverPath)) {
        return {
          path: serverPath,
          version: metadata.version ?? 'unknown',
          packagePath,
        };
      }
    }
  } catch {
    // Fall through to the conventional install location.
  }
  const conventional = resolve(
    process.cwd(),
    'node_modules',
    'typescript-language-server',
    'lib',
    'cli.mjs',
  );
  if (existsSync(conventional)) {
    let version = 'unknown';
    try {
      const packagePath = resolve(process.cwd(), 'node_modules', 'typescript-language-server', 'package.json');
      version =
        (JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: string }).version ?? 'unknown';
    } catch {
      // Version is reporting data; the server is still usable.
    }
    return { path: conventional, version, packagePath: conventional };
  }
  return null;
}

export interface LspServerInfo {
  readonly name: string;
  readonly version?: string;
}

export interface LspClientMetrics {
  readonly requests: number;
  readonly notifications: number;
  readonly cancellations: number;
  readonly refusedServerRequests: number;
  readonly ignoredServerRequests: number;
  readonly protocolErrors: number;
  readonly stderrBytes: number;
}

export interface LspClientOptions {
  /** Absolute host directory the server considers its workspace root. */
  readonly root: string;
  /** Defaults to `locateLanguageServer()`. */
  readonly serverPath?: string;
  readonly startupTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  /** Test hook; when absent a private temp HOME is created and removed. */
  readonly homeDir?: string;
  /** Bounded log sink. The client never writes to stdout/stderr itself. */
  readonly onLog?: (message: string) => void;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

interface ParsedFrame {
  readonly index: number;
  readonly bodyStart: number;
  readonly length: number;
}

function parseFrame(buffer: Buffer): ParsedFrame | null {
  const crlf = buffer.indexOf('\r\n\r\n');
  const lf = buffer.indexOf('\n\n');
  const index = crlf >= 0 ? crlf : lf;
  if (index < 0) return null;
  const delimiter = crlf >= 0 ? 4 : 2;
  const header = buffer.subarray(0, index).toString('ascii');
  const match = /content-length:\s*(\d+)/i.exec(header);
  if (!match) return null;
  const length = Number(match[1]);
  if (!Number.isFinite(length) || length < 0) return null;
  return { index, bodyStart: index + delimiter, length };
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `signal ${signal}`;
  return code === null ? 'unknown status' : `exit code ${code}`;
}

export class LspClient {
  readonly #root: string;
  readonly #serverPath: string | null;
  readonly #startupTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  readonly #shutdownTimeoutMs: number;
  readonly #onLog: ((message: string) => void) | undefined;

  #child: ChildProcessWithoutNullStreams | null = null;
  #homeDir: string | null = null;
  #homeDirOwned = false;
  #buffer: Buffer = Buffer.alloc(0);
  #stderr = '';
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  #dead = false;
  #disposed = false;
  #shuttingDown = false;
  #exitCode: number | null = null;
  #exitSignal: NodeJS.Signals | null = null;
  #exitSeen = false;
  #exitWaiters: Array<() => void> = [];
  #crashListeners: Array<(error: LspError) => void> = [];
  #diagnosticsListeners: Array<(uri: string, version: number | null, diagnostics: unknown[]) => void> = [];
  #logLines: string[] = [];
  #metrics = {
    requests: 0,
    notifications: 0,
    cancellations: 0,
    refusedServerRequests: 0,
    ignoredServerRequests: 0,
    protocolErrors: 0,
    stderrBytes: 0,
  };
  #serverInfo: LspServerInfo | null = null;
  #capabilities: Record<string, unknown> = {};
  #positionEncoding: 'utf-16' | null = null;
  #typescriptVersion: string | null = null;
  #startPromise: Promise<void> | null = null;
  #startResolve: (() => void) | null = null;
  #startReject: ((error: Error) => void) | null = null;
  #initialized = false;

  constructor(options: LspClientOptions) {
    if (!isAbsolute(options.root)) {
      throw new LspError('LSP_SPAWN_FAILED', `language server root must be absolute: ${options.root}`);
    }
    this.#root = resolve(options.root);
    this.#serverPath = options.serverPath ?? locateLanguageServer()?.path ?? null;
    this.#startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.#onLog = options.onLog;
    if (options.homeDir) {
      this.#homeDir = options.homeDir;
    }
  }

  get root(): string {
    return this.#root;
  }

  get pid(): number | null {
    return this.#child?.pid ?? null;
  }

  get alive(): boolean {
    return (
      this.#child !== null &&
      !this.#dead &&
      !this.#disposed &&
      this.#child.exitCode === null &&
      this.#child.signalCode === null
    );
  }

  get serverInfo(): LspServerInfo | null {
    return this.#serverInfo;
  }

  get capabilities(): Record<string, unknown> {
    return this.#capabilities;
  }

  get positionEncoding(): 'utf-16' | null {
    return this.#positionEncoding;
  }

  get typescriptVersion(): string | null {
    return this.#typescriptVersion;
  }

  get stderrTail(): string {
    return this.#stderr;
  }

  get logs(): readonly string[] {
    return this.#logLines;
  }

  metrics(): LspClientMetrics {
    return { ...this.#metrics };
  }

  /** Capability names the initialized server actually advertised. */
  capabilitySummary(): string[] {
    const capabilities = this.#capabilities;
    const names: string[] = [];
    for (const [key, value] of Object.entries(capabilities)) {
      if (value === true || (typeof value === 'object' && value !== null)) {
        names.push(key.replace(/Provider$/, ''));
      }
    }
    return names.sort();
  }

  onCrash(listener: (error: LspError) => void): () => void {
    this.#crashListeners.push(listener);
    return () => {
      this.#crashListeners = this.#crashListeners.filter((entry) => entry !== listener);
    };
  }

  onDiagnostics(
    listener: (uri: string, version: number | null, diagnostics: unknown[]) => void,
  ): () => void {
    this.#diagnosticsListeners.push(listener);
    return () => {
      this.#diagnosticsListeners = this.#diagnosticsListeners.filter((entry) => entry !== listener);
    };
  }

  /** Spawn the process and perform `initialize` / `initialized`. Idempotent. */
  async start(): Promise<void> {
    if (this.#initialized) return;
    if (this.#startPromise) return this.#startPromise;
    if (this.#disposed) throw new LspError('LSP_DISPOSED', 'language client is already disposed');
    const starting = new Promise<void>((resolveStart, rejectStart) => {
      this.#startResolve = resolveStart;
      this.#startReject = rejectStart;
    });
    this.#startPromise = starting;
    this.#spawn();
    return starting;
  }

  #spawn(): void {
    if (!this.#serverPath) {
      const error = new LspError(
        'LSP_SERVER_MISSING',
        'typescript-language-server is not installed; install it as a dev dependency',
      );
      this.#startReject?.(error);
      this.#startPromise = null;
      return;
    }
    if (!this.#homeDir) {
      this.#homeDir = mkdtempSync(join(tmpdir(), 'eunoia-lsp-home-'));
      this.#homeDirOwned = true;
      try {
        chmodSync(this.#homeDir, 0o700);
      } catch {
        // A restrictive HOME is desirable, not required.
      }
    }
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: this.#homeDir,
      TMPDIR: this.#homeDir,
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      TZ: 'UTC',
      NO_COLOR: '1',
    };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(process.execPath, [this.#serverPath, '--stdio'], {
        cwd: this.#root,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      const failure = new LspError(
        'LSP_SPAWN_FAILED',
        `could not spawn typescript-language-server: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.#startReject?.(failure);
      this.#startPromise = null;
      return;
    }
    this.#child = child;
    child.stdout.on('data', (chunk: Buffer) => this.#onStdout(chunk));
    child.stderr.on('data', (chunk: Buffer) => this.#onStderr(chunk));
    child.on('error', (error) => {
      const failure = new LspError('LSP_SPAWN_FAILED', `language server process error: ${error.message}`);
      this.#dead = true;
      this.#rejectPending(failure);
      this.#startReject?.(failure);
      this.#startPromise = null;
    });
    child.on('exit', (code, signal) => this.#onExit(code, signal));

    const timer = setTimeout(() => {
      if (this.#initialized) return;
      const error = new LspError(
        'LSP_STARTUP_TIMEOUT',
        `language server did not initialize within ${this.#startupTimeoutMs} ms`,
      );
      this.#startReject?.(error);
      this.#startPromise = null;
      this.#kill('SIGKILL');
    }, this.#startupTimeoutMs);
    timer.unref?.();

    void this.#initialize().catch((error: unknown) => {
      clearTimeout(timer);
      const failure =
        error instanceof LspError
          ? error
          : new LspError(
              'LSP_PROTOCOL_ERROR',
              `language server initialization failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
      this.#startReject?.(failure);
      this.#startPromise = null;
      this.#kill('SIGKILL');
    });
    // The timer belongs to initialization; clear it once that settles either way.
    this.#startPromise?.then(
      () => clearTimeout(timer),
      () => clearTimeout(timer),
    );
  }

  async #initialize(): Promise<void> {
    const uri = pathToFileURL(this.#root).href;
    const result = (await this.request(
      'initialize',
      {
        processId: process.pid,
        clientInfo: { name: 'eunoia', version: '0.1.0' },
        locale: 'en',
        rootPath: this.#root,
        rootUri: uri,
        workspaceFolders: [{ uri, name: basename(this.#root) }],
        capabilities: {
          general: { positionEncodings: ['utf-16'] },
          workspace: {
            workspaceFolders: true,
            configuration: false,
            applyEdit: false,
            workspaceEdit: {
              documentChanges: false,
              resourceOperations: [],
              failureHandling: 'abort',
            },
            symbol: { symbolKind: { valueSet: Array.from({ length: 26 }, (_, index) => index + 1) } },
            didChangeWatchedFiles: { dynamicRegistration: false },
          },
          textDocument: {
            synchronization: {
              dynamicRegistration: false,
              willSave: false,
              willSaveWaitUntil: false,
              didSave: false,
            },
            definition: { linkSupport: false },
            references: { dynamicRegistration: false },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            publishDiagnostics: {
              relatedInformation: false,
              versionSupport: true,
              tagSupport: { valueSet: [] },
            },
            diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
          },
          window: { workDoneProgress: false },
        },
        initializationOptions: {
          hostInfo: 'eunoia',
          tsserver: { maxTsServerMemory: 512, logVerbosity: 'off' },
        },
      },
      { timeoutMs: this.#startupTimeoutMs },
    )) as {
      serverInfo?: LspServerInfo;
      capabilities?: Record<string, unknown> & { positionEncoding?: string };
    };
    this.#serverInfo = result?.serverInfo ?? { name: 'typescript-language-server' };
    this.#capabilities = result?.capabilities ?? {};
    const encoding = result?.capabilities?.positionEncoding ?? 'utf-16';
    if (encoding !== 'utf-16') {
      throw new LspError(
        'LSP_PROTOCOL_ERROR',
        `language server negotiated unsupported position encoding ${encoding}; Eunoia requires utf-16`,
      );
    }
    this.#positionEncoding = 'utf-16';
    this.#initialized = true;
    this.#notify('initialized', {});
    this.#startResolve?.();
    this.#startPromise = null;
  }

  async request<T>(
    method: string,
    params: unknown,
    options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
  ): Promise<T> {
    if (this.#disposed) throw new LspError('LSP_DISPOSED', 'language client is disposed');
    if (!this.#initialized && method !== 'initialize') {
      await this.start();
    }
    if (!this.alive) {
      throw new LspError('LSP_CRASHED', this.#crashMessage());
    }
    if (this.#shuttingDown) {
      throw new LspError('LSP_DISPOSED', 'language client is shutting down');
    }
    return await this.#requestInternal<T>(method, params, options);
  }

  /** A request without the public liveness guards; dispose uses it once. */
  async #requestInternal<T>(
    method: string,
    params: unknown,
    options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
  ): Promise<T> {
    const id = this.#nextId++;
    const timeoutMs = options.timeoutMs ?? this.#requestTimeoutMs;
    this.#metrics = { ...this.#metrics, requests: this.#metrics.requests + 1 };
    return await new Promise<T>((resolveRequest, rejectRequest) => {
      const pending: PendingRequest = {
        method,
        resolve: (value) => resolveRequest(value as T),
        reject: rejectRequest,
        timer: null,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.signal
          ? {
              onAbort: () => {
                if (!this.#pending.has(id)) return;
                this.#cancel(id, `request ${method} was cancelled`);
              },
            }
          : {}),
      };
      this.#pending.set(id, pending);
      if (pending.signal) {
        if (pending.signal.aborted) {
          this.#pending.delete(id);
          rejectRequest(new LspError('LSP_CANCELLED', `${method} was cancelled before it was sent`));
          return;
        }
        pending.signal.addEventListener('abort', pending.onAbort as () => void, { once: true });
      }
      pending.timer = setTimeout(() => {
        if (!this.#pending.has(id)) return;
        this.#cancel(id, `request ${method} exceeded ${timeoutMs} ms`, 'LSP_TIMEOUT');
      }, timeoutMs);
      try {
        this.#write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        this.#settle(id);
        rejectRequest(
          error instanceof LspError
            ? error
            : new LspError('LSP_PROTOCOL_ERROR', `could not write ${method}: ${String(error)}`),
        );
      }
    });
  }

  notify(method: string, params: unknown): void {
    if (this.#disposed || !this.alive) return;
    this.#notify(method, params);
  }

  #notify(method: string, params: unknown): void {
    if (this.#disposed) return;
    this.#metrics = { ...this.#metrics, notifications: this.#metrics.notifications + 1 };
    this.#write({ jsonrpc: '2.0', method, params });
  }

  #write(payload: unknown): void {
    const child = this.#child;
    if (!child || child.stdin.destroyed || child.stdin.writableEnded) {
      throw new LspError('LSP_CRASHED', this.#crashMessage());
    }
    const body = JSON.stringify(payload);
    const bytes = Buffer.byteLength(body, 'utf8');
    child.stdin.write(`Content-Length: ${bytes}\r\n\r\n${body}`);
  }

  #onStdout(chunk: Buffer): void {
    const combined = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    this.#buffer = combined;
    for (;;) {
      const frame = parseFrame(this.#buffer);
      if (!frame) break;
      if (frame.length > MAX_MESSAGE_BYTES) {
        this.#metrics = { ...this.#metrics, protocolErrors: this.#metrics.protocolErrors + 1 };
        this.#rejectPending(
          new LspError('LSP_PROTOCOL_ERROR', `language server sent an oversized frame (${frame.length} bytes)`),
        );
        this.#kill('SIGKILL');
        this.#buffer = Buffer.alloc(0);
        return;
      }
      if (this.#buffer.length < frame.bodyStart + frame.length) break;
      const body = this.#buffer.subarray(frame.bodyStart, frame.bodyStart + frame.length).toString('utf8');
      this.#buffer = this.#buffer.subarray(frame.bodyStart + frame.length);
      this.#onMessage(body);
    }
  }

  #onStderr(chunk: Buffer): void {
    this.#metrics = { ...this.#metrics, stderrBytes: this.#metrics.stderrBytes + chunk.length };
    this.#stderr = (this.#stderr + chunk.toString('utf8')).slice(-MAX_STDERR_BYTES);
  }

  #onMessage(body: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(body) as Record<string, unknown>;
    } catch {
      this.#metrics = { ...this.#metrics, protocolErrors: this.#metrics.protocolErrors + 1 };
      return;
    }
    const method = typeof message.method === 'string' ? message.method : null;
    const id = message.id;
    if (method && (typeof id === 'number' || typeof id === 'string')) {
      this.#onServerRequest(id, method, message.params);
      return;
    }
    if (method) {
      this.#onServerNotification(method, message.params);
      return;
    }
    if (id === undefined || id === null) return;
    const numericId = typeof id === 'number' ? id : Number(id);
    if (!Number.isFinite(numericId)) return;
    const pending = this.#pending.get(numericId);
    if (!pending) return;
    this.#settle(numericId);
    if (message.error) {
      const error = message.error as { code?: number; message?: string };
      pending.reject(
        new LspError(
          'LSP_PROTOCOL_ERROR',
          `language server rejected ${pending.method}: [${error.code ?? '?'}] ${error.message ?? 'unknown error'}`,
        ),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  #onServerNotification(method: string, params: unknown): void {
    if (method === 'textDocument/publishDiagnostics') {
      const payload = params as { uri?: string; version?: number; diagnostics?: unknown[] };
      if (typeof payload.uri === 'string') {
        const version = typeof payload.version === 'number' ? payload.version : null;
        for (const listener of this.#diagnosticsListeners) {
          listener(payload.uri, version, payload.diagnostics ?? []);
        }
      }
      return;
    }
    if (method === 'window/logMessage') {
      const payload = params as { message?: string };
      if (typeof payload.message === 'string') this.#recordLog(payload.message);
      return;
    }
    if (method === 'window/showMessage') {
      const payload = params as { message?: string };
      if (typeof payload.message === 'string') this.#recordLog(payload.message);
      return;
    }
    // `$/progress`, `telemetry/event`, watched-file notifications and anything
    // unknown are informational only. None of them changes a tool result.
    this.#metrics = { ...this.#metrics, ignoredServerRequests: this.#metrics.ignoredServerRequests + 1 };
  }

  #onServerRequest(id: number | string, method: string, params: unknown): void {
    switch (method) {
      case 'workspace/configuration': {
        const items = (params as { items?: unknown[] })?.items ?? [];
        this.#respond(id, Array.from({ length: items.length }, () => null));
        break;
      }
      case 'workspace/workspaceFolders': {
        const uri = pathToFileURL(this.#root).href;
        this.#respond(id, [{ uri, name: basename(this.#root) }]);
        break;
      }
      case 'workspace/applyEdit':
      case 'window/showMessageRequest': {
        this.#metrics = { ...this.#metrics, refusedServerRequests: this.#metrics.refusedServerRequests + 1 };
        this.#respondError(
          id,
          -32601,
          `${method} is refused: Eunoia does not apply server-side edits or show modal requests`,
        );
        break;
      }
      case 'client/registerCapability':
      case 'client/unregisterCapability':
      case 'window/workDoneProgress/create': {
        this.#metrics = { ...this.#metrics, ignoredServerRequests: this.#metrics.ignoredServerRequests + 1 };
        this.#respond(id, null);
        break;
      }
      default: {
        this.#metrics = { ...this.#metrics, refusedServerRequests: this.#metrics.refusedServerRequests + 1 };
        this.#respondError(id, -32601, `unsupported server request ${method}`);
      }
    }
  }

  #respond(id: number | string, result: unknown): void {
    try {
      this.#write({ jsonrpc: '2.0', id, result });
    } catch {
      // The process is gone; the exit handler reports the crash.
    }
  }

  #respondError(id: number | string, code: number, message: string): void {
    try {
      this.#write({ jsonrpc: '2.0', id, error: { code, message } });
    } catch {
      // The process is gone; the exit handler reports the crash.
    }
  }

  #recordLog(message: string): void {
    this.#logLines = [...this.#logLines, message].slice(-MAX_LOG_LINES);
    const version = /Using (?:Typescript|TypeScript) version[^0-9]*([0-9]+\.[0-9]+\.[0-9]+)/i.exec(message);
    if (version?.[1]) this.#typescriptVersion = version[1];
    this.#onLog?.(message);
  }

  #cancel(id: number, reason: string, code: 'LSP_TIMEOUT' | 'LSP_CANCELLED' = 'LSP_CANCELLED'): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener('abort', pending.onAbort);
    }
    this.#metrics = { ...this.#metrics, cancellations: this.#metrics.cancellations + 1 };
    try {
      // The spec's cancellation is a notification; the response is ignored by
      // this client because the caller has already been rejected.
      this.#write({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } });
    } catch {
      // Losing the process while cancelling is reported by the exit handler.
    }
    pending.reject(new LspError(code, reason, { id, method: pending.method }));
  }

  #settle(id: number): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener('abort', pending.onAbort);
    }
  }

  #rejectPending(error: LspError): void {
    const ids = [...this.#pending.keys()];
    for (const id of ids) {
      const pending = this.#pending.get(id);
      if (!pending) continue;
      this.#settle(id);
      pending.reject(error);
    }
  }

  #onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.#exitCode = code;
    this.#exitSignal = signal;
    this.#exitSeen = true;
    this.#dead = true;
    for (const waiter of this.#exitWaiters) waiter();
    this.#exitWaiters = [];
    if (this.#shuttingDown || this.#disposed) {
      this.#rejectPending(new LspError('LSP_DISPOSED', 'language server exited during shutdown'));
      return;
    }
    const error = new LspError('LSP_CRASHED', this.#crashMessage(code, signal), {
      code,
      signal,
      stderr: this.#stderr.slice(-2_000),
    });
    this.#rejectPending(error);
    this.#startReject?.(error);
    for (const listener of this.#crashListeners) {
      try {
        listener(error);
      } catch {
        // A listener must not break crash reporting for the others.
      }
    }
  }

  #crashMessage(code: number | null = this.#exitCode, signal: NodeJS.Signals | null = this.#exitSignal): string {
    const status = code === null && signal === null ? 'is not running' : `exited with ${describeExit(code, signal)}`;
    const tail = this.#stderr.trim().split('\n').slice(-3).join(' | ');
    return `typescript-language-server ${status}${tail ? `: ${tail}` : ''}`;
  }

  #kill(signal: NodeJS.Signals): void {
    try {
      this.#child?.kill(signal);
    } catch {
      // Already gone.
    }
  }

  /** For the process-exit hook: no protocol, no awaiting, just no orphan. */
  killNow(): void {
    this.#shuttingDown = true;
    this.#kill('SIGKILL');
  }

  async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.#exitSeen) return true;
    if (!this.#child) return true;
    return await new Promise<boolean>((resolveWait) => {
      const timer = setTimeout(() => resolveWait(false), timeoutMs);
      timer.unref?.();
      this.#exitWaiters.push(() => {
        clearTimeout(timer);
        resolveWait(true);
      });
    });
  }

  /**
   * LSP shutdown: `shutdown`, `exit`, then bounded SIGTERM/SIGKILL.
   *
   * Every step is best-effort because dispose must also work after a crash. The
   * temp HOME is removed only when this client created it.
   */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    // Block new work immediately, then speak the shutdown protocol directly:
    // `request` refuses once disposal has started, which is the right public
    // contract but the wrong one for the final `shutdown` call.
    this.#disposed = true;
    this.#shuttingDown = true;
    const child = this.#child;
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        await this.#requestInternal('shutdown', null, {
          timeoutMs: Math.min(2_000, this.#shutdownTimeoutMs),
        });
      } catch {
        // A crashed or unresponsive server still has to be killed below.
      }
      try {
        if (child.exitCode === null && child.signalCode === null) {
          this.#write({ jsonrpc: '2.0', method: 'exit', params: null });
        }
      } catch {
        // Ignore: the process may already be gone.
      }
      if (!(await this.waitForExit(1_000))) {
        this.#kill('SIGTERM');
        if (!(await this.waitForExit(500))) this.#kill('SIGKILL');
        await this.waitForExit(500);
      }
    }
    this.#rejectPending(new LspError('LSP_DISPOSED', 'language client was disposed'));
    this.#buffer = Buffer.alloc(0);
    if (this.#homeDirOwned && this.#homeDir) {
      rmSync(this.#homeDir, { recursive: true, force: true });
      this.#homeDir = null;
      this.#homeDirOwned = false;
    }
  }
}

export interface LanguageServerProbe {
  readonly ok: boolean;
  readonly detail: string;
  readonly serverInfo: LspServerInfo | null;
  readonly version: number | string | null;
  readonly positionEncoding: string | null;
  readonly capabilities: readonly string[];
}

/**
 * Start a real server once and report what it says about itself.
 *
 * Used by the doctor so "installed" is not the same claim as "the protocol
 * works". A probe never touches project files.
 */
export async function probeLanguageServer(
  options: { readonly root?: string; readonly timeoutMs?: number } = {},
): Promise<LanguageServerProbe> {
  const located = locateLanguageServer();
  if (!located) {
    return {
      ok: false,
      detail: 'typescript-language-server is not installed',
      serverInfo: null,
      version: null,
      positionEncoding: null,
      capabilities: [],
    };
  }
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'eunoia-lsp-probe-'));
  const ownsRoot = options.root === undefined;
  const client = new LspClient({
    root,
    serverPath: located.path,
    startupTimeoutMs: options.timeoutMs ?? 15_000,
  });
  try {
    await client.start();
    const info = client.serverInfo;
    return {
      ok: true,
      detail: `${located.version} at ${located.path}${info?.name ? `; server ${info.name}${info.version ? ` ${info.version}` : ''}` : ''}`,
      serverInfo: info,
      version: info?.version ?? located.version,
      positionEncoding: client.positionEncoding,
      capabilities: client.capabilitySummary(),
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      serverInfo: null,
      version: located.version,
      positionEncoding: null,
      capabilities: [],
    };
  } finally {
    await client.dispose();
    if (ownsRoot) rmSync(root, { recursive: true, force: true });
  }
}
