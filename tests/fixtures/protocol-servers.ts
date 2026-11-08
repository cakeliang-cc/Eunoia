/**
 * Real local wire fixtures for the two protocols the product supports.
 *
 * These are not "two functions that return the same ModelTurn". Each one is a
 * `node:http` server that speaks the actual wire protocol on an ephemeral port:
 *
 * - `responses`: `POST /v1/responses`, SSE frames with `event:` and `data:`,
 *   `response.created` / `response.output_text.delta` /
 *   `response.reasoning_text.delta` / `response.output_item.added` /
 *   `response.function_call_arguments.delta` / `response.completed`.
 * - `chat-completions`: `POST /v1/chat/completions`,
 *   `chat.completion.chunk` SSE frames terminated by `data: [DONE]`.
 *
 * Every captured request keeps the parsed body, the headers (so a test can see
 * which credential was used) and whether the client disconnected before the
 * response finished (so a cancellation test can observe the abort rather than
 * trust the client's own signal).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type WireProtocol = 'responses' | 'chat-completions';

export interface ToolCallPlan {
  readonly callId: string;
  readonly name: string;
  /** Full JSON string the model "produced". */
  readonly arguments: string;
  /** Optional split for streaming deltas; defaults to one delta. */
  readonly argumentChunks?: readonly string[];
}

export interface UsagePlan {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens?: number;
}

export interface ReplyPlan {
  readonly textChunks?: readonly string[];
  readonly reasoningChunks?: readonly string[];
  readonly toolCalls?: readonly ToolCallPlan[];
  readonly usage?: UsagePlan;
  readonly responseId?: string;
  /** Include a vendor-private reasoning payload in the terminal output. */
  readonly privateReasoning?: boolean;
  /** Stream a protocol-native error event after any deltas. */
  readonly streamError?: {
    readonly code: string;
    readonly message: string;
    readonly type?: string;
  };
}

export interface CapturedRequest {
  readonly protocol: WireProtocol;
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  // The fixture parses the JSON body, so its shape is intentionally unknown.
  readonly body: unknown;
  readonly raw: string;
  /** True when the client disconnected before the fixture finished the reply. */
  aborted: boolean;
  /** True when the fixture wrote a complete protocol response. */
  completed: boolean;
}

export interface FixtureOptions {
  readonly protocol: WireProtocol;
  /** Static plan, or a plan chosen from the request (tool-result round trips). */
  readonly plan?: ReplyPlan | ((request: CapturedRequest) => ReplyPlan);
  /** Answer with an HTTP error instead of streaming. */
  readonly httpError?: {
    readonly status: number;
    readonly body?: unknown;
    readonly statusText?: string;
  };
  /** Wait before writing response headers (real client-timeout case). */
  readonly delayBeforeHeadersMs?: number;
  /** Delay between SSE frames. */
  readonly frameDelayMs?: number;
  /**
   * After the scripted frames, keep the connection open and never write the
   * terminal event, until the client disconnects.
   */
  readonly hangAfterFrames?: boolean;
  /** Never write anything; keep the connection open (timeout/cancel case). */
  readonly hangBeforeHeaders?: boolean;
}

export interface ProtocolFixture {
  readonly protocol: WireProtocol;
  /** `http://127.0.0.1:<ephemeral>/v1`, the value a provider config uses. */
  readonly baseURL: string;
  readonly requests: readonly CapturedRequest[];
  close(): Promise<void>;
}

type Captured = {
  -readonly [K in keyof CapturedRequest]: CapturedRequest[K];
};

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function writeFrame(response: ServerResponse, event: string | null, data: unknown): void {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  if (event) response.write(`event: ${event}\n`);
  response.write(`data: ${payload}\n\n`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Open the SSE response and, for scenarios where the fixture must outlive the
 * client, resolve only when the socket closes. Returning a promise keeps the
 * request handler alive so `close()` can wait for the connection to be gone.
 */
function hangUntilDisconnect(response: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => resolve();
    response.on('close', done);
    response.on('error', done);
  });
}

function responseOutput(plan: ReplyPlan): unknown[] {
  const output: unknown[] = [];
  if (plan.reasoningChunks && plan.reasoningChunks.length > 0) {
    const text = plan.reasoningChunks.join('');
    output.push({
      type: 'reasoning',
      id: 'rs_fixture_1',
      summary: [{ type: 'summary_text', text }],
      ...(plan.privateReasoning
        ? { encrypted_content: 'vendor-private-signature', status: 'completed' }
        : {}),
    });
  }
  if (plan.textChunks && plan.textChunks.length > 0) {
    output.push({
      type: 'message',
      id: 'msg_fixture_1',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: plan.textChunks.join('') }],
    });
  }
  for (const call of plan.toolCalls ?? []) {
    output.push({
      type: 'function_call',
      id: `fc_${call.callId}`,
      call_id: call.callId,
      name: call.name,
      arguments: call.arguments,
      status: 'completed',
    });
  }
  return output;
}

function responsesUsage(plan: ReplyPlan): Record<string, unknown> {
  const usage = plan.usage ?? { inputTokens: 0, outputTokens: 0 };
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
    ...(usage.cachedTokens !== undefined
      ? { input_tokens_details: { cached_tokens: usage.cachedTokens } }
      : {}),
  };
}

async function streamResponses(
  fixture: Captured,
  response: ServerResponse,
  model: string,
  plan: ReplyPlan,
  options: FixtureOptions,
): Promise<void> {
  const responseId = plan.responseId ?? 'resp_fixture_1';
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const send = (event: string, data: unknown): void => writeFrame(response, event, data);

  // A real Responses stream opens with response.created before any content.
  send('response.created', {
    type: 'response.created',
    response: {
      id: responseId,
      object: 'response',
      created_at: 1_700_000_000,
      status: 'in_progress',
      model,
      output: [],
    },
  });

  if (plan.streamError) {
    send('error', {
      type: 'error',
      code: plan.streamError.code,
      message: plan.streamError.message,
      ...(plan.streamError.type ? { param: null } : {}),
    });
    fixture.completed = true;
    response.end();
    return;
  }

  let outputIndex = 0;
  if (plan.reasoningChunks && plan.reasoningChunks.length > 0) {
    send('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: { type: 'reasoning', id: 'rs_fixture_1', summary: [] },
    });
    for (const delta of plan.reasoningChunks) {
      await delay(options.frameDelayMs ?? 0);
      send('response.reasoning_text.delta', {
        type: 'response.reasoning_text.delta',
        item_id: 'rs_fixture_1',
        output_index: outputIndex,
        content_index: 0,
        delta,
      });
    }
    outputIndex += 1;
  }

  if (plan.textChunks && plan.textChunks.length > 0) {
    send('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: { type: 'message', id: 'msg_fixture_1', role: 'assistant', content: [] },
    });
    for (const delta of plan.textChunks) {
      await delay(options.frameDelayMs ?? 0);
      send('response.output_text.delta', {
        type: 'response.output_text.delta',
        item_id: 'msg_fixture_1',
        output_index: outputIndex,
        content_index: 0,
        delta,
      });
    }
    outputIndex += 1;
  }

  for (const call of plan.toolCalls ?? []) {
    send('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: {
        type: 'function_call',
        id: `fc_${call.callId}`,
        call_id: call.callId,
        name: call.name,
        arguments: '',
        status: 'in_progress',
      },
    });
    const chunks = call.argumentChunks ?? [call.arguments];
    for (const chunk of chunks) {
      await delay(options.frameDelayMs ?? 0);
      send('response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        item_id: `fc_${call.callId}`,
        output_index: outputIndex,
        delta: chunk,
      });
    }
    send('response.function_call_arguments.done', {
      type: 'response.function_call_arguments.done',
      item_id: `fc_${call.callId}`,
      output_index: outputIndex,
      arguments: call.arguments,
    });
    outputIndex += 1;
  }

  if (options.hangAfterFrames) {
    await hangUntilDisconnect(response);
    return;
  }

  send('response.completed', {
    type: 'response.completed',
    response: {
      id: responseId,
      object: 'response',
      created_at: 1_700_000_000,
      status: 'completed',
      model,
      output: responseOutput(plan),
      usage: responsesUsage(plan),
    },
  });
  fixture.completed = true;
  response.end();
}

async function streamChatCompletions(
  fixture: Captured,
  response: ServerResponse,
  model: string,
  plan: ReplyPlan,
  options: FixtureOptions,
): Promise<void> {
  const id = plan.responseId ?? 'chatcmpl_fixture_1';
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const send = (data: unknown): void => writeFrame(response, null, data);
  const chunk = (choices: unknown[]): Record<string, unknown> => ({
    id,
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model,
    choices,
  });

  send(chunk([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]));

  if (plan.streamError) {
    send({
      error: {
        message: plan.streamError.message,
        type: plan.streamError.type ?? 'server_error',
        code: plan.streamError.code,
      },
    });
    fixture.completed = true;
    response.end();
    return;
  }

  for (const delta of plan.reasoningChunks ?? []) {
    await delay(options.frameDelayMs ?? 0);
    send(chunk([{ index: 0, delta: { reasoning: delta }, finish_reason: null }]));
  }
  for (const delta of plan.textChunks ?? []) {
    await delay(options.frameDelayMs ?? 0);
    send(chunk([{ index: 0, delta: { content: delta }, finish_reason: null }]));
  }

  let toolIndex = 0;
  for (const call of plan.toolCalls ?? []) {
    const chunks = call.argumentChunks ?? [call.arguments];
    send(
      chunk([
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: toolIndex,
                id: call.callId,
                type: 'function',
                function: { name: call.name, arguments: chunks[0] ?? '' },
              },
            ],
          },
          finish_reason: null,
        },
      ]),
    );
    for (const extra of chunks.slice(1)) {
      await delay(options.frameDelayMs ?? 0);
      send(
        chunk([
          {
            index: 0,
            delta: {
              tool_calls: [{ index: toolIndex, function: { arguments: extra } }],
            },
            finish_reason: null,
          },
        ]),
      );
    }
    toolIndex += 1;
  }

  if (options.hangAfterFrames) {
    await hangUntilDisconnect(response);
    return;
  }

  send(
    chunk([
      {
        index: 0,
        delta: {},
        finish_reason: (plan.toolCalls?.length ?? 0) > 0 ? 'tool_calls' : 'stop',
      },
    ]),
  );

  if (plan.usage) {
    send({
      id,
      object: 'chat.completion.chunk',
      created: 1_700_000_000,
      model,
      choices: [],
      usage: {
        prompt_tokens: plan.usage.inputTokens,
        completion_tokens: plan.usage.outputTokens,
        total_tokens: plan.usage.inputTokens + plan.usage.outputTokens,
        ...(plan.usage.cachedTokens !== undefined
          ? { prompt_tokens_details: { cached_tokens: plan.usage.cachedTokens } }
          : {}),
      },
    });
  }
  writeFrame(response, null, '[DONE]');
  fixture.completed = true;
  response.end();
}

function expectedPath(protocol: WireProtocol): string {
  return protocol === 'responses' ? '/v1/responses' : '/v1/chat/completions';
}

export async function startProtocolFixture(options: FixtureOptions): Promise<ProtocolFixture> {
  const requests: Captured[] = [];
  const sockets = new Set<import('node:net').Socket>();

  const server: Server = createServer((request, response) => {
    const captured: Captured = {
      protocol: options.protocol,
      method: request.method ?? '',
      path: request.url ?? '',
      headers: Object.fromEntries(
        Object.entries(request.headers).map(([key, value]) => [
          key,
          Array.isArray(value) ? value.join(',') : (value ?? ''),
        ]),
      ),
      body: null,
      raw: '',
      aborted: false,
      completed: false,
    };
    requests.push(captured);
    // The client disconnecting mid-stream is observed here, not inferred from
    // the signal the test passed in.
    response.on('close', () => {
      if (!response.writableEnded && !captured.completed) captured.aborted = true;
    });

    void (async () => {
      const raw = await readBody(request);
      captured.raw = raw;
      try {
        captured.body = raw.length > 0 ? JSON.parse(raw) : null;
      } catch {
        captured.body = null;
      }

      if (options.hangBeforeHeaders) {
        await hangUntilDisconnect(response);
        return;
      }
      if (options.delayBeforeHeadersMs) {
        await delay(options.delayBeforeHeadersMs);
      }
      if (request.method !== 'POST' || captured.path.split('?')[0] !== expectedPath(options.protocol)) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'not found', type: 'invalid_request_error' } }));
        captured.completed = true;
        return;
      }

      if (options.httpError) {
        response.writeHead(options.httpError.status, {
          'content-type': 'application/json',
          ...(options.httpError.statusText ? { 'x-fixture-status': options.httpError.statusText } : {}),
        });
        response.end(
          JSON.stringify(
            options.httpError.body ?? {
              error: {
                message: 'fixture rejected the request',
                type: 'invalid_request_error',
                code: 'fixture_error',
              },
            },
          ),
        );
        captured.completed = true;
        return;
      }

      const plan =
        typeof options.plan === 'function'
          ? options.plan(captured)
          : (options.plan ?? { textChunks: ['ok'] });
      const body = (captured.body ?? {}) as { model?: unknown };
      const model = typeof body.model === 'string' ? body.model : 'fixture-model';

      if (options.protocol === 'responses') {
        await streamResponses(captured, response, model, plan, options);
      } else {
        await streamChatCompletions(captured, response, model, plan, options);
      }
    })().catch((error: unknown) => {
      // The handler must not leave the connection dangling on an unexpected
      // error; recording it as an aborted reply is the honest signal.
      if (!captured.completed) captured.aborted = true;
      if (!response.writableEnded) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }),
        );
      }
    });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;

  return {
    protocol: options.protocol,
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    requests,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
