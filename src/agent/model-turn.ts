/**
 * The one adapter between this project's model port and the Agents SDK.
 *
 * The SDK is used here for what it is good at: talking to a provider, including
 * its Responses API, streaming, reasoning and usage reporting. It is *not* used
 * for the loop. That is a deliberate split: the loop needs per-call policy,
 * parallel reads, a context ledger and tool events that the SDK's runner does
 * not expose, while the transport is exactly the kind of vendor detail ADR 005
 * says to keep in one place.
 *
 * The request shapes below mirror the SDK runner's own preparation. If a
 * provider rejects one, the failure is here and at one seam, not spread through
 * the loop.
 */

import type {
  AgentInputItem,
  AgentOutputItem,
  Model,
  ModelProvider,
  ModelRequest,
  SerializedTool,
} from '@openai/agents';
import type {
  LoopInputItem,
  LoopOutputItem,
  ModelTurn,
  ModelTurnEvent,
  ModelUsage,
} from './model-port.ts';
import { cacheUsageOf, reasoningChunkOf, textDeltaOf } from './stream-events.ts';

/** Build a model step bound to one SDK model. */
export function createSdkModelTurn(model: Model): ModelTurn {
  return async function* modelTurn(request): AsyncIterable<ModelTurnEvent> {
    let text = '';
    let sawDone = false;

    const modelRequest: ModelRequest = {
      systemInstructions: request.instructions,
      input: request.input.map(toAgentInput),
      modelSettings: {},
      tools: request.tools.map(toSerializedTool),
      toolsExplicitlyProvided: true,
      outputType: 'text',
      handoffs: [],
      // The native loop does not run inside an SDK `Trace`, so asking the SDK
      // to create a response span throws "No existing trace found". Turn and
      // tool events are logged by the loop itself; wiring SDK spans back in
      // means creating a trace around the loop, which is a separate change.
      tracing: false,
      ...(request.signal ? { signal: request.signal } : {}),
    };

    for await (const event of model.getStreamedResponse(modelRequest)) {
      if (event.type === 'output_text_delta') {
        const delta = textDeltaOf(event);
        if (delta !== null) {
          text += delta;
          yield { type: 'text_delta', text: delta };
        }
        continue;
      }

      if (event.type === 'model') {
        const reasoning = reasoningChunkOf(event);
        if (reasoning?.kind === 'delta') {
          yield { type: 'reasoning_delta', text: reasoning.text };
        } else if (reasoning?.kind === 'done') {
          yield { type: 'reasoning_done' };
        }
        continue;
      }

      if (event.type === 'response_done') {
        const output = event.response.output
          .map(toLoopOutput)
          .filter((item): item is LoopOutputItem => item !== null);
        // The streamed text is the authority on what the person saw. A missing
        // assistant item would otherwise make `completed` carry less than the
        // deltas already did.
        if (!output.some((item) => item.type === 'message') && text.length > 0) {
          output.push({ type: 'message', role: 'assistant', content: text });
        }
        sawDone = true;
        yield {
          type: 'done',
          output,
          ...(event.response.usage ? { usage: usageOf(event.response.usage) } : {}),
          responseId: event.response.id,
        };
        return;
      }
    }

    if (!sawDone) {
      if (text.length > 0) {
        yield {
          type: 'done',
          output: [{ type: 'message', role: 'assistant', content: text }],
        };
        return;
      }
      throw new Error('model stream ended without a response');
    }
  };
}

/**
 * Resolve a model id to a model turn, once per process.
 *
 * The cache is keyed by model id, not by conversation: the SDK model object is
 * immutable configuration, and rebuilding it per turn would throw away the
 * provider's connection wrappers.
 */
export function createModelTurnResolver(
  provider: ModelProvider,
): (modelId: string) => Promise<ModelTurn> {
  const cache = new Map<string, ModelTurn>();
  return async (modelId: string) => {
    const existing = cache.get(modelId);
    if (existing) return existing;
    const model = await provider.getModel(modelId);
    const turn = createSdkModelTurn(model);
    cache.set(modelId, turn);
    return turn;
  };
}

// ------------------------------------------------------------------ mapping ---

function toAgentInput(item: LoopInputItem): AgentInputItem {
  switch (item.type) {
    case 'message':
      if (item.role === 'assistant') {
        return {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: item.content }],
        };
      }
      if (item.role === 'system') {
        return {
          type: 'message',
          role: 'system',
          content: item.content,
        };
      }
      return {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: item.content }],
      };
    case 'function_call':
      return {
        type: 'function_call',
        callId: item.callId,
        name: item.name,
        arguments: item.arguments,
        status: 'completed',
      };
    case 'function_call_result':
      return {
        type: 'function_call_result',
        callId: item.callId,
        name: item.name,
        status: 'completed',
        output: item.output,
      };
    case 'reasoning':
      if (item.raw) return item.raw as AgentInputItem;
      return {
        type: 'reasoning',
        ...(item.id ? { id: item.id } : {}),
        content: [{ type: 'input_text', text: item.text }],
        rawContent: [{ type: 'reasoning_text', text: item.text }],
      };
  }
}

function toSerializedTool(tool: {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}): SerializedTool {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as Extract<SerializedTool, { type: 'function' }>['parameters'],
    strict: false,
  };
}

function toLoopOutput(item: AgentOutputItem): LoopOutputItem | null {
  if (item.type === 'function_call') {
    return {
      type: 'function_call',
      callId: item.callId,
      name: item.name,
      arguments: item.arguments,
    };
  }

  if (item.type === 'reasoning') {
    const rawText = (item.rawContent ?? [])
      .filter((part) => part.type === 'reasoning_text')
      .map((part) => part.text)
      .join('');
    const fallback = (item.content ?? [])
      .filter((part) => part.type === 'input_text')
      .map((part) => part.text)
      .join('');
    return {
      type: 'reasoning',
      text: rawText || fallback,
      ...(item.id ? { id: item.id } : {}),
      raw: item,
    };
  }

  // `message` is optional in the protocol union; a message with no explicit type
  // is still an assistant message.
  const record = item as { type?: unknown; role?: unknown; content?: unknown };
  if (record.role === 'assistant' && Array.isArray(record.content)) {
    const text = record.content
      .filter(
        (part): part is { type: 'output_text'; text: string } =>
          typeof part === 'object' &&
          part !== null &&
          (part as { type?: unknown }).type === 'output_text' &&
          typeof (part as { text?: unknown }).text === 'string',
      )
      .map((part) => part.text)
      .join('');
    return { type: 'message', role: 'assistant', content: text };
  }

  return null;
}

function usageOf(usage: {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly inputTokensDetails?: readonly Record<string, number>[] | Record<string, number>;
}): ModelUsage {
  const cache = cacheUsageOf(usage);
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
    cachedTokens: cache?.cached_tokens ?? 0,
  };
}
