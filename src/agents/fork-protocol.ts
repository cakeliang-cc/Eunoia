/**
 * The fork boundary between two provider protocols.
 *
 * A fork is not a transcript copy. The child may be served by a different
 * provider with a different wire protocol, and some parent items are simply not
 * portable:
 *
 * - a reasoning item carrying a vendor-private replay payload (encrypted
 *   content, a signature, a provider extension) cannot be replayed by another
 *   vendor — forwarding it would either be rejected or leak provider-private
 *   material, so the fork is refused and the caller is told to use `fresh`;
 * - a tool call without its result is half a turn: inheriting it would make the
 *   child's first request look like a provider error;
 * - a tool call whose name only the source protocol can encode (namespaced
 *   names) cannot be converted to Chat Completions.
 *
 * Everything portable is converted to the product's neutral `LoopInputItem`
 * shape and re-encoded by the target adapter. Reasoning text is not forwarded:
 * it is model-private, and inventing a target-protocol representation for it
 * is the "fake success" this module exists to avoid.
 *
 * This module is deliberately pure: no store, no network, no SDK. The caller
 * decides which turns were committed; the converter decides whether they can
 * cross the boundary.
 */

import type { LoopInputItem } from '../agent/model-port.ts';

export type ForkProtocol = 'responses' | 'chat-completions';

export type ForkInputItem =
  | {
      readonly type: 'message';
      readonly role: 'user' | 'assistant' | 'system';
      readonly content: string;
      /** The message carries image parts; cross-protocol re-encoding needs media. */
      readonly hasImages?: boolean;
    }
  | {
      readonly type: 'function_call';
      readonly callId: string;
      readonly name: string;
      readonly arguments: string;
      readonly raw?: unknown;
    }
  | {
      readonly type: 'function_call_result';
      readonly callId: string;
      readonly name: string;
      readonly output: string;
      readonly raw?: unknown;
    }
  | {
      readonly type: 'reasoning';
      readonly text: string;
      readonly raw?: unknown;
    }
  | {
      readonly type: 'background' | 'summary' | 'interrupt';
      readonly text?: string;
      readonly raw?: unknown;
    };

export interface ForkTurn {
  /**
   * Message seq this turn is anchored to: the committed assistant message whose
   * text and tool group the turn contains.
   */
  readonly seq: number;
  /** False for a turn after the caller's committed cutoff. */
  readonly committed: boolean;
  readonly items: readonly ForkInputItem[];
}

export type ForkRefusalCode =
  | 'uncommitted_turn'
  | 'incomplete_tool_group'
  | 'orphan_tool_result'
  | 'duplicate_tool_call'
  | 'private_reasoning'
  | 'unsupported_tool_call'
  | 'image_not_portable';

export interface ForkRefusal {
  readonly status: 'refused';
  readonly code: ForkRefusalCode;
  readonly message: string;
  /** The only safe caller action when content cannot be converted. */
  readonly recommendation: 'fresh';
  readonly turnSeq: number | null;
  readonly itemIndex: number | null;
}

export interface ForkOmission {
  readonly turnSeq: number;
  readonly reason: 'reasoning_not_forwarded' | 'background_not_forwarded' | 'summary_not_forwarded';
}

export interface ForkConvertedTurn {
  readonly seq: number;
  readonly items: readonly LoopInputItem[];
}

export interface ForkConverted {
  readonly status: 'converted';
  readonly sourceProtocol: ForkProtocol;
  readonly targetProtocol: ForkProtocol;
  readonly turns: readonly ForkConvertedTurn[];
  readonly omitted: readonly ForkOmission[];
}

export type ForkConversion = ForkConverted | ForkRefusal;

export interface ForkConversionInput {
  readonly sourceProtocol: ForkProtocol;
  readonly targetProtocol: ForkProtocol;
  readonly turns: readonly ForkTurn[];
  /** Whether the target route can encode images at all. */
  readonly targetSupportsImages?: boolean;
}

/** Keys that mark a provider-private replay payload, at any depth. */
const PRIVATE_KEYS: ReadonlySet<string> = new Set([
  'encrypted_content',
  'encryptedContent',
  'signature',
  'thought_signature',
  'thoughtSignatures',
  'reasoning_content',
  'reasoningContent',
]);

/** Names Chat Completions accepts as a function name. */
const CHAT_FUNCTION_NAME = /^[a-zA-Z0-9_-]+$/;

function hasPrivatePayload(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((entry) => hasPrivatePayload(entry, depth + 1));
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (PRIVATE_KEYS.has(key)) return true;
    if (hasPrivatePayload(entry, depth + 1)) return true;
  }
  return false;
}

function refuse(
  code: ForkRefusalCode,
  message: string,
  turnSeq: number | null,
  itemIndex: number | null,
): ForkRefusal {
  return {
    status: 'refused',
    code,
    message: `${message} 请使用 fresh 重新开始该成员。`,
    recommendation: 'fresh',
    turnSeq,
    itemIndex,
  };
}

/**
 * Decide whether a committed parent history is portable to the child protocol.
 *
 * The returned turns contain only items the target adapter can encode: text
 * messages and complete function-call/result groups.
 */
export function convertForkHistory(input: ForkConversionInput): ForkConversion {
  const crossProtocol = input.sourceProtocol !== input.targetProtocol;
  const converted: ForkConvertedTurn[] = [];
  const omitted: ForkOmission[] = [];

  for (const turn of input.turns) {
    if (!turn.committed) {
      return refuse(
        'uncommitted_turn',
        `第 ${turn.seq} 条消息之后的轮次尚未提交，不能 fork。`,
        turn.seq,
        null,
      );
    }

    const pending = new Map<string, string>();
    const items: LoopInputItem[] = [];

    for (const [index, item] of turn.items.entries()) {
      switch (item.type) {
        case 'message': {
          if (item.hasImages && crossProtocol && input.targetSupportsImages !== true) {
            return refuse(
              'image_not_portable',
              '父轨迹的图片无法跨协议重新编码（目标模型不支持图片输入）。',
              turn.seq,
              index,
            );
          }
          items.push({ type: 'message', role: item.role, content: item.content });
          break;
        }

        case 'function_call': {
          if (pending.has(item.callId)) {
            return refuse(
              'duplicate_tool_call',
              `工具调用 ${item.callId} 在同一轮出现两次。`,
              turn.seq,
              index,
            );
          }
          if (hasPrivatePayload(item.raw)) {
            return refuse(
              'unsupported_tool_call',
              `工具调用 ${item.callId} 带有厂商私有字段，不能转换。`,
              turn.seq,
              index,
            );
          }
          if (
            input.targetProtocol === 'chat-completions' &&
            !CHAT_FUNCTION_NAME.test(item.name)
          ) {
            return refuse(
              'unsupported_tool_call',
              `Chat Completions 不能表示工具名 ${JSON.stringify(item.name)}。`,
              turn.seq,
              index,
            );
          }
          pending.set(item.callId, item.name);
          items.push({
            type: 'function_call',
            callId: item.callId,
            name: item.name,
            arguments: item.arguments,
          });
          break;
        }

        case 'function_call_result': {
          if (!pending.has(item.callId)) {
            return refuse(
              'orphan_tool_result',
              `工具结果 ${item.callId} 没有对应的调用，工具组不完整。`,
              turn.seq,
              index,
            );
          }
          pending.delete(item.callId);
          items.push({
            type: 'function_call_result',
            callId: item.callId,
            name: item.name,
            output: item.output,
          });
          break;
        }

        case 'reasoning': {
          if (hasPrivatePayload(item.raw)) {
            if (crossProtocol) {
              return refuse(
                'private_reasoning',
                '父轨迹包含厂商私有的推理回放字段（签名或加密内容），不能跨协议转发。',
                turn.seq,
                index,
              );
            }
            // Same protocol: the caller may replay it; the fork converter itself
            // never emits a reasoning item, so nothing private is written into
            // the child's portable history.
            omitted.push({ turnSeq: turn.seq, reason: 'reasoning_not_forwarded' });
            break;
          }
          // Plain reasoning text is model-private; dropping it is lossless for
          // the conversation and safer than inventing a target encoding.
          omitted.push({ turnSeq: turn.seq, reason: 'reasoning_not_forwarded' });
          break;
        }

        case 'background':
          omitted.push({ turnSeq: turn.seq, reason: 'background_not_forwarded' });
          break;
        case 'summary':
          omitted.push({ turnSeq: turn.seq, reason: 'summary_not_forwarded' });
          break;
        case 'interrupt':
          // An interrupt marker is bookkeeping, not model input.
          break;
      }
    }

    if (pending.size > 0) {
      const names = [...pending.values()].join(', ');
      return refuse(
        'incomplete_tool_group',
        `工具调用 ${names} 没有结果，工具组不完整。`,
        turn.seq,
        null,
      );
    }

    converted.push({ seq: turn.seq, items });
  }

  return {
    status: 'converted',
    sourceProtocol: input.sourceProtocol,
    targetProtocol: input.targetProtocol,
    turns: converted,
    omitted,
  };
}

/** The subset of a converted turn that has to be seeded as transcript items. */
export function toolItemsOf(turn: ForkConvertedTurn): LoopInputItem[] {
  return turn.items.filter((item) => item.type !== 'message');
}
