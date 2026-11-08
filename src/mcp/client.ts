/**
 * One live MCP connection.
 *
 * This is the only module that imports the SDK's `Client`, and the only place
 * where its result shapes are read. Everything above receives the small raw
 * shapes in `catalog.ts` and `content.ts`.
 *
 * The connection is generation-scoped: the manager never reuses one after a
 * close, and a late reply from an old generation is discarded by its owner. That
 * is what stops a stale `tools/list` from replacing a catalog a newer connection
 * already published.
 *
 * See docs/adr/033-mcp-host.md §6.3.
 */

import {
  Client,
  LATEST_PROTOCOL_VERSION,
  type ClientCapabilities,
  type ElicitResult,
  type OAuthClientProvider,
} from '@modelcontextprotocol/client';
import type { ElicitRequestParams } from '@modelcontextprotocol/client';
import type { McpCapabilities, McpServerConfig } from './types.ts';
import { McpError } from './types.ts';
import { createStdioTransport, type BuiltStdioTransport } from './transport/stdio.ts';
import { createHttpTransport } from './transport/http.ts';

/** The SDK request method used for the Tasks extension. */
const TASK_METHODS = {
  get: 'tasks/get',
  result: 'tasks/result',
  cancel: 'tasks/cancel',
  list: 'tasks/list',
} as const;

export interface RawCallResult {
  readonly content: readonly unknown[];
  readonly structuredContent?: unknown;
  readonly isError: boolean;
  /** A task handle when the server answered with one. */
  readonly task: { readonly taskId: string; readonly status: string; readonly ttl?: number; readonly pollInterval?: number } | null;
  /** The raw result, kept for outputSchema validation evidence and diagnostics. */
  readonly raw: unknown;
}

export interface RawResourceContents {
  readonly uri: string;
  readonly mimeType: string | null;
  readonly text: string | null;
  readonly blob: Uint8Array | null;
}

export interface RawPromptResult {
  readonly description: string | null;
  readonly messages: readonly {
    readonly role: string;
    readonly content: unknown;
  }[];
}

export interface ElicitationRequest {
  readonly message: string;
  readonly mode: 'form' | 'url';
  readonly requestedSchema?: Record<string, unknown>;
  readonly url?: string;
}

export interface McpConnectionOptions {
  readonly config: McpServerConfig;
  readonly generation: number;
  readonly identity: string;
  readonly env?: NodeJS.ProcessEnv;
  /** OAuth provider, when the server uses OAuth. */
  readonly authProvider?: OAuthClientProvider;
  /** Called for a server-initiated form/URL interaction. */
  readonly onElicit?: (request: ElicitationRequest) => Promise<ElicitResult>;
  /** Called when the server says its tool/resource/prompt list changed. */
  readonly onListChanged?: (kind: 'tools' | 'resources' | 'prompts') => void;
  readonly fetch?: typeof fetch;
}

type RawRequest = {
  request(
    request: { method: string; params?: unknown },
    schema: unknown,
    options?: unknown,
  ): Promise<unknown>;
};

/** A pause that a caller can cancel. Rejects with a typed timeout, not a hang. */
async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  outer: AbortSignal | undefined,
  message: string,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const onAbort = (): void => controller.abort();
  outer?.addEventListener('abort', onAbort, { once: true });
  try {
    return await work(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new McpError(
        'MCP_TIMEOUT',
        outer?.aborted ? '调用被取消' : `${message}（超过 ${timeoutMs}ms）`,
        504,
        { retryable: false, detail: { timeoutMs, cancelled: outer?.aborted === true } },
      );
    }
    throw mapSdkError(error);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onAbort);
  }
}

function mapSdkError(error: unknown): unknown {
  if (error instanceof McpError) return error;
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  if (name === 'UnauthorizedError' || /unauthori[sz]ed|401/.test(message)) {
    return new McpError('MCP_AUTH_REQUIRED', '服务要求重新登录（401）。', 401, {
      detail: { reason: 'unauthorized' },
    });
  }
  if (name === 'InsufficientScopeError') {
    return new McpError('MCP_AUTH_SCOPE', '授权范围不足，需要重新授权。', 403, {
      detail: { reason: 'insufficient_scope' },
    });
  }
  if (name === 'SdkError' || name === 'SseError' || name === 'ProtocolError') {
    return new McpError('MCP_REMOTE_FAILED', message, 502);
  }
  return error;
}

export class McpConnection {
  readonly config: McpServerConfig;
  readonly generation: number;
  readonly identity: string;
  readonly #client: Client;
  readonly #stdio: BuiltStdioTransport | null;
  #closed = false;
  #capabilities: McpCapabilities;
  #protocolRevision: string | null = null;
  #serverInfo: { name: string; version: string } | null = null;
  #instructions: string | null = null;

  private constructor(
    options: McpConnectionOptions,
    client: Client,
    stdio: BuiltStdioTransport | null,
  ) {
    this.config = options.config;
    this.generation = options.generation;
    this.identity = options.identity;
    this.#client = client;
    this.#stdio = stdio;
    this.#capabilities = {
      tools: false,
      resources: false,
      prompts: false,
      logging: false,
      completions: false,
      subscriptions: false,
      tasks: false,
      elicitation: false,
    };
  }

  /** Connect, negotiate a protocol era and read the server's own description. */
  static async open(options: McpConnectionOptions): Promise<McpConnection> {
    const { config } = options;
    let stdio: BuiltStdioTransport | null = null;
    let transport;
    if (config.transport === 'stdio') {
      if (!config.stdio) throw new McpError('MCP_CONFIG_INVALID', 'stdio configuration missing');
      stdio = createStdioTransport(config.stdio, {
        ...(options.env ? { env: options.env } : {}),
        maxBufferSize: config.limits.maxResultBytes,
      });
      transport = stdio.transport;
    } else {
      if (!config.http) throw new McpError('MCP_CONFIG_INVALID', 'http configuration missing');
      const built = createHttpTransport(config.http, {
        allowPrivateNetwork: config.http.allowPrivateNetwork === true,
        allowInsecure: config.http.allowInsecure === true,
        ...(options.env ? { env: options.env } : {}),
        ...(options.authProvider ? { authProvider: options.authProvider } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      transport = built.transport;
    }

    // Give an OAuth provider the transport it belongs to, so an authorization
    // callback can complete on the transport that started the flow.
    const authWithTransport = options.authProvider as
      | { attachTransport?: (transport: unknown) => void }
      | undefined;
    authWithTransport?.attachTransport?.(transport);

    const client = new Client(
      { name: 'eunoia-mcp-host', version: '0.1.0' },
      {
        capabilities: { elicitation: {} } as ClientCapabilities,
        // Modern-era negotiation, with a legacy fallback. The negotiated
        // revision is recorded and reported; nothing above branches on it.
        versionNegotiation: { mode: 'auto' },
        listMaxPages: 64,
        listChanged: {
          tools: {
            onChanged: (error) => {
              if (!error) options.onListChanged?.('tools');
            },
          },
          resources: {
            onChanged: (error) => {
              if (!error) options.onListChanged?.('resources');
            },
          },
          prompts: {
            onChanged: (error) => {
              if (!error) options.onListChanged?.('prompts');
            },
          },
        },
        inputRequired: { autoFulfill: true },
      },
    );

    if (options.onElicit) {
      client.setRequestHandler('elicitation/create', async (request) => {
        const params = request.params as ElicitRequestParams;
        const mode = params.mode === 'url' ? 'url' : 'form';
        return options.onElicit?.({
          message: params.message,
          mode,
          ...(mode === 'form' && 'requestedSchema' in params
            ? { requestedSchema: params.requestedSchema as Record<string, unknown> }
            : {}),
          ...(mode === 'url' && 'url' in params ? { url: params.url } : {}),
        }) ?? { action: 'decline' };
      });
    }

    const connection = new McpConnection(options, client, stdio);
    try {
      await withTimeout(
        (signal) => client.connect(transport, { signal }),
        config.timeouts.connectMs,
        undefined,
        '连接 MCP 服务超时',
      );
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }

    connection.#readCapabilities();
    return connection;
  }

  #readCapabilities(): void {
    const capabilities = this.#client.getServerCapabilities() as
      | Record<string, unknown>
      | undefined;
    const version = this.#client.getServerVersion();
    this.#serverInfo = version ? { name: version.name, version: version.version } : null;
    this.#protocolRevision = this.#client.getNegotiatedProtocolVersion() ?? null;
    const instructions = this.#client.getInstructions();
    this.#instructions = typeof instructions === 'string' ? instructions : null;
    const has = (name: string): boolean =>
      capabilities !== undefined && capabilities[name] !== undefined;
    this.#capabilities = {
      tools: has('tools'),
      resources: has('resources'),
      prompts: has('prompts'),
      logging: has('logging'),
      completions: has('completions'),
      subscriptions: has('resources') && has('subscriptions'),
      tasks: has('tasks'),
      elicitation: has('elicitation'),
    };
  }

  get capabilities(): McpCapabilities {
    return this.#capabilities;
  }

  get protocolRevision(): string | null {
    return this.#protocolRevision;
  }

  get serverInfo(): { name: string; version: string } | null {
    return this.#serverInfo;
  }

  get instructions(): string | null {
    return this.#instructions;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Diagnostics: the container/host process id and the bounded stderr tail. */
  processEvidence(): { readonly location: 'host' | 'sandbox' | 'http'; readonly pid: number | null; readonly stderr: readonly string[] } {
    return {
      location: this.#stdio?.location ?? 'http',
      pid: this.#stdio?.pid() ?? null,
      stderr: this.#stdio?.stderrTail() ?? [],
    };
  }

  async ping(signal?: AbortSignal): Promise<void> {
    await withTimeout((inner) => this.#client.ping({ signal: inner }), 5_000, signal, 'ping 超时');
  }

  async listToolsPage(
    cursor: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ readonly tools: readonly unknown[]; readonly nextCursor?: string }> {
    const result = await withTimeout(
      (inner) =>
        this.#client.listTools(cursor ? { cursor } : undefined, {
          ...(inner ? { signal: inner } : {}),
          cacheMode: 'refresh',
        }),
      this.config.timeouts.callMs,
      signal,
      '读取工具列表超时',
    );
    return {
      tools: result.tools,
      ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}),
    };
  }

  async listResourcesPage(
    cursor: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ readonly resources: readonly unknown[]; readonly nextCursor?: string }> {
    const result = await withTimeout(
      (inner) => this.#client.listResources(cursor ? { cursor } : undefined, { signal: inner }),
      this.config.timeouts.callMs,
      signal,
      '读取资源列表超时',
    );
    return {
      resources: result.resources,
      ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}),
    };
  }

  async listResourceTemplatesPage(
    cursor: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ readonly resourceTemplates: readonly unknown[]; readonly nextCursor?: string }> {
    const result = await withTimeout(
      (inner) => this.#client.listResourceTemplates(cursor ? { cursor } : undefined, { signal: inner }),
      this.config.timeouts.callMs,
      signal,
      '读取资源模板超时',
    );
    return {
      resourceTemplates: result.resourceTemplates,
      ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}),
    };
  }

  async listPromptsPage(
    cursor: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ readonly prompts: readonly unknown[]; readonly nextCursor?: string }> {
    const result = await withTimeout(
      (inner) => this.#client.listPrompts(cursor ? { cursor } : undefined, { signal: inner }),
      this.config.timeouts.callMs,
      signal,
      '读取提示词列表超时',
    );
    return {
      prompts: result.prompts,
      ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}),
    };
  }

  async callTool(input: {
    readonly name: string;
    readonly arguments: Record<string, unknown>;
    readonly toolDefinition?: unknown;
    readonly signal?: AbortSignal;
  }): Promise<RawCallResult> {
    const params: Record<string, unknown> = {
      name: input.name,
      arguments: input.arguments,
    };
    const result = (await withTimeout(
      (inner) =>
        this.#client.callTool(
          params as { name: string; arguments?: Record<string, unknown> },
          {
            signal: inner,
            // The definition from the exact catalog revision is passed so output
            // schema validation and header mirroring agree with what the model
            // was offered.
            ...(input.toolDefinition ? { toolDefinition: input.toolDefinition as never } : {}),
          },
        ),
      this.config.timeouts.callMs,
      input.signal,
      '调用工具超时',
    )) as Record<string, unknown>;

    const content = Array.isArray(result.content) ? result.content : [];
    return {
      content,
      ...(result.structuredContent !== undefined
        ? { structuredContent: result.structuredContent }
        : {}),
      isError: result.isError === true,
      task: readTaskHandle(result),
      raw: result,
    };
  }

  async readResource(
    uri: string,
    signal?: AbortSignal,
  ): Promise<{ readonly contents: readonly RawResourceContents[]; readonly ttlMs?: number }> {
    const result = await withTimeout(
      (inner) => this.#client.readResource({ uri }, { signal: inner, cacheMode: 'refresh' }),
      this.config.timeouts.callMs,
      signal,
      '读取资源超时',
    );
    const contents = (result.contents ?? []).map((entry) => {
      const record = entry as Record<string, unknown>;
      return {
        uri: typeof record.uri === 'string' ? record.uri : uri,
        mimeType: typeof record.mimeType === 'string' ? record.mimeType : null,
        text: typeof record.text === 'string' ? record.text : null,
        blob:
          typeof record.blob === 'string' && record.blob.length > 0
            ? Buffer.from(record.blob, 'base64')
            : null,
      };
    });
    const ttlCandidate = (result as unknown as Record<string, unknown>).ttlMs;
    const ttlMs = typeof ttlCandidate === 'number' ? ttlCandidate : undefined;
    return { contents, ...(ttlMs !== undefined ? { ttlMs } : {}) };
  }

  async getPrompt(
    name: string,
    args: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<RawPromptResult> {
    const result = await withTimeout(
      (inner) => this.#client.getPrompt({ name, arguments: args }, { signal: inner }),
      this.config.timeouts.callMs,
      signal,
      '读取提示词超时',
    );
    return {
      description: result.description ?? null,
      messages: (result.messages ?? []).map((message) => ({
        role: message.role,
        content: message.content,
      })),
    };
  }

  async complete(input: {
    readonly ref: { readonly type: 'ref/prompt'; readonly name: string } | { readonly type: 'ref/resource'; readonly uri: string };
    readonly argument: { readonly name: string; readonly value: string };
    readonly signal?: AbortSignal;
  }): Promise<{ readonly values: readonly string[]; readonly total?: number; readonly hasMore?: boolean }> {
    const result = await withTimeout(
      (inner) =>
        this.#client.complete(
          { ref: input.ref, argument: input.argument } as never,
          { signal: inner },
        ),
      this.config.timeouts.callMs,
      input.signal,
      '参数补全超时',
    );
    return {
      values: result.completion?.values ?? [],
      ...(result.completion?.total !== undefined ? { total: result.completion.total } : {}),
      ...(result.completion?.hasMore !== undefined ? { hasMore: result.completion.hasMore } : {}),
    };
  }

  async subscribeResource(uri: string, signal?: AbortSignal): Promise<void> {
    await withTimeout(
      (inner) => this.#client.subscribeResource({ uri }, { signal: inner }),
      this.config.timeouts.callMs,
      signal,
      '订阅资源超时',
    );
  }

  async unsubscribeResource(uri: string, signal?: AbortSignal): Promise<void> {
    await withTimeout(
      (inner) => this.#client.unsubscribeResource({ uri }, { signal: inner }),
      this.config.timeouts.callMs,
      signal,
      '取消订阅超时',
    );
  }

  // -------------------------------------------------------------- tasks ---

  async getTask(remoteTaskId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.#taskRequest(TASK_METHODS.get, { taskId: remoteTaskId }, signal);
  }

  async getTaskResult(remoteTaskId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.#taskRequest(TASK_METHODS.result, { taskId: remoteTaskId }, signal);
  }

  async cancelTask(remoteTaskId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.#taskRequest(TASK_METHODS.cancel, { taskId: remoteTaskId }, signal);
  }

  async #taskRequest(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (!this.#capabilities.tasks) {
      throw new McpError('MCP_TASK_UNAVAILABLE', '这个服务没有声明 Tasks 扩展。', 400);
    }
    // `request` is part of the SDK client's protocol surface but not of its
    // typed convenience API in this build. The cast is confined to this method.
    const raw = this.#client as unknown as RawRequest;
    const passthrough = {
      parse(value: unknown): unknown {
        return value;
      },
    };
    const result = await withTimeout(
      () => raw.request({ method, params }, passthrough),
      this.config.timeouts.callMs,
      signal,
      '任务请求超时',
    );
    return (result ?? {}) as Record<string, unknown>;
  }

  // ---------------------------------------------------------------- close ---

  async close(reason = 'closed'): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    // Close first, then bound the wait: a hung server must not delay shutdown
    // past the configured grace, and the process tree is killed by the SDK's
    // transport once the pipe closes.
    const closing = this.#client.close().catch(() => undefined);
    await Promise.race([
      closing,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.config.timeouts.closeMs);
        timer.unref?.();
      }),
    ]);
    void reason;
  }
}

/** A task handle in a call result, if the server returned one. */
function readTaskHandle(result: Record<string, unknown>): RawCallResult['task'] {
  const direct = result.task;
  if (direct && typeof direct === 'object') {
    const record = direct as Record<string, unknown>;
    if (typeof record.taskId === 'string') {
      return {
        taskId: record.taskId,
        status: typeof record.status === 'string' ? record.status : 'working',
        ...(typeof record.ttl === 'number' ? { ttl: record.ttl } : {}),
        ...(typeof record.pollInterval === 'number' ? { pollInterval: record.pollInterval } : {}),
      };
    }
  }
  const meta = result._meta;
  if (meta && typeof meta === 'object') {
    for (const [key, value] of Object.entries(meta as Record<string, unknown>)) {
      if (!key.includes('related-task') || !value || typeof value !== 'object') continue;
      const record = value as Record<string, unknown>;
      if (typeof record.taskId === 'string') {
        return {
          taskId: record.taskId,
          status: typeof record.status === 'string' ? record.status : 'working',
        };
      }
    }
  }
  return null;
}

/** The protocol revision this build was compiled against, for the report. */
export const SDK_PROTOCOL_VERSION = LATEST_PROTOCOL_VERSION;

/** Describe a connection failure for a status row, without leaking a token. */
export function describeConnectionError(error: unknown): {
  readonly code: string;
  readonly message: string;
  readonly detail?: Record<string, unknown>;
} {
  if (error instanceof McpError) {
    return {
      code: error.code,
      message: error.message,
      ...(Object.keys(error.detail).length > 0 ? { detail: error.detail } : {}),
    };
  }
  return {
    code: 'MCP_CONNECT_FAILED',
    message: error instanceof Error ? error.message : String(error),
  };
}
