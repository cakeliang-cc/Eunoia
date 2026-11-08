/**
 * Offline harness for the model-transcript acceptance suite (A01–A32).
 *
 * It drives the real `runTurn` orchestration with a scripted model step, so the
 * tests exercise retrieval, admission, media preflight, persistence and the
 * durable replay path rather than a parallel implementation.
 */

import { randomUUID } from 'node:crypto';
import { runTurn } from '../../src/service/chat.ts';
import type { ModelTurn, ModelTurnRequest, ModelUsage } from '../../src/agent/model-port.ts';
import type { AgentEvent } from '../../src/agent/events.ts';
import type { ToolDefinition } from '../../src/tools/types.ts';
import type { TranscriptMode } from '../../src/session/model-transcript.ts';

export const USER = '00000000-0000-4000-8000-000000000001';

export interface ScriptStep {
  readonly text?: string;
  readonly reasoning?: string;
  readonly calls?: readonly { readonly name: string; readonly arguments: Record<string, unknown> }[];
  /** Omitted means the provider reported nothing, which must stay null. */
  readonly usage?: ModelUsage;
  readonly incomplete?: boolean;
}

export interface ScriptedModel {
  readonly turn: ModelTurn;
  readonly requests: ModelTurnRequest[];
  readonly remaining: () => number;
}

/** A model that answers from a fixed script and records every encoded request. */
export function scriptedModel(steps: readonly ScriptStep[]): ScriptedModel {
  const queue = [...steps];
  const requests: ModelTurnRequest[] = [];
  let calls = 0;
  return {
    requests,
    remaining: () => queue.length,
    turn: async function* modelTurn(request: ModelTurnRequest) {
      requests.push(request);
      const step = queue.shift();
      if (!step) throw new Error('scripted model ran out of steps');
      const output: import('../../src/agent/model-port.ts').LoopOutputItem[] = [];
      if (step.reasoning) {
        yield { type: 'reasoning_delta', text: step.reasoning };
        output.push({ type: 'reasoning', text: step.reasoning, id: `rs_${calls}` });
      }
      if (step.text) yield { type: 'text_delta', text: step.text };
      if (step.text) output.push({ type: 'message', role: 'assistant', content: step.text });
      for (const call of step.calls ?? []) {
        calls += 1;
        output.push({
          type: 'function_call',
          callId: `call_${calls}`,
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        });
      }
      if (step.incomplete) {
        yield {
          type: 'incomplete',
          output,
          ...(step.usage ? { usage: step.usage } : {}),
          responseId: `resp_${calls}`,
          reason: 'cut',
        };
        return;
      }
      yield {
        type: 'done',
        output,
        ...(step.usage ? { usage: step.usage } : {}),
        responseId: `resp_${calls}`,
      };
    },
  };
}

export interface RunOptions {
  readonly store: Parameters<typeof runTurn>[0]['store'];
  readonly message: string;
  readonly conversationId?: string | null;
  readonly requestId?: string;
  readonly mode?: TranscriptMode;
  readonly model?: ScriptedModel;
  /** A custom model turn, used when a test needs to stop mid-stream. */
  readonly modelTurn?: ModelTurn;
  readonly tools?: readonly ToolDefinition[];
  readonly persist?: boolean;
  readonly regenerate?: boolean;
  readonly continue?: boolean;
  readonly signal?: AbortSignal;
  readonly retrieve?: boolean;
  readonly now?: () => Date;
  readonly timeZone?: string;
}

export async function runScenario(options: RunOptions): Promise<{
  readonly events: AgentEvent[];
  readonly requestId: string;
  readonly conversationId: string | null;
}> {
  const requestId = options.requestId ?? randomUUID();
  const events: AgentEvent[] = [];
  const deps: Parameters<typeof runTurn>[0] = {
    store: options.store,
    transcriptMode: options.mode ?? 'durable',
    modelTurn: options.modelTurn ?? (options.model as ScriptedModel).turn,
    ...(options.tools ? { additionalTools: options.tools } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  };
  for await (const event of runTurn(deps, {
    userId: USER,
    message: options.message,
    ...(options.conversationId ? { conversationId: options.conversationId } : {}),
    requestId,
    ...(options.persist === false ? { persist: false } : {}),
    ...(options.regenerate ? { regenerate: true } : {}),
    ...(options.continue ? { continue: true } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.retrieve !== undefined ? { retrieve: options.retrieve } : {}),
  })) {
    events.push(event);
  }
  const completed = [...events].reverse().find((event) => event.type === 'completed');
  return {
    events,
    requestId,
    conversationId:
      completed?.type === 'completed'
        ? completed.conversationId ?? null
        : events.find(
              (event) => event.type === 'interrupted' || event.type === 'error',
            )?.type === 'interrupted'
          ? ((events.find((event) => event.type === 'interrupted') as { conversationId?: string | null })
              .conversationId ?? null)
          : options.conversationId ?? null,
  };
}

/** Concatenate model text emitted by the events. */
export function replyOf(events: readonly AgentEvent[]): string {
  return events
    .filter((event): event is Extract<AgentEvent, { type: 'text_delta' }> => event.type === 'text_delta')
    .map((event) => event.text)
    .join('');
}
