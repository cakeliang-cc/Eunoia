/**
 * The cross-protocol fork seam.
 *
 * These are unit tests on purpose: the converter is the boundary that decides
 * "portable", "drop" or "refuse". The integration test in
 * `dual-provider.test.ts` proves the same seam is wired into the real fork
 * path with real transcripts.
 */

import { describe, expect, it } from 'vitest';
import {
  convertForkHistory,
  toolItemsOf,
  type ForkInputItem,
  type ForkTurn,
} from '../../src/agents/fork-protocol.ts';

function turn(seq: number, items: readonly ForkInputItem[], committed = true): ForkTurn {
  return { seq, committed, items };
}

const completeGroup: readonly ForkInputItem[] = [
  { type: 'message', role: 'assistant', content: '我先读。' },
  {
    type: 'function_call',
    callId: 'call_1',
    name: 'read_thing',
    arguments: '{"name":"a.ts"}',
  },
  {
    type: 'function_call_result',
    callId: 'call_1',
    name: 'read_thing',
    output: 'content of a.ts',
  },
];

describe('fork protocol conversion', () => {
  it('converts a complete tool group to portable items and drops reasoning text', () => {
    const conversion = convertForkHistory({
      sourceProtocol: 'responses',
      targetProtocol: 'chat-completions',
      turns: [
        turn(2, [
          {
            type: 'reasoning',
            text: '内部推理',
            raw: { type: 'reasoning', providerData: { id: 'rs_1' } },
          },
          ...completeGroup,
        ]),
      ],
    });

    expect(conversion.status).toBe('converted');
    if (conversion.status !== 'converted') throw new Error('expected conversion');
    expect(conversion.turns).toHaveLength(1);
    expect(conversion.turns[0]!.items).toEqual([
      { type: 'message', role: 'assistant', content: '我先读。' },
      {
        type: 'function_call',
        callId: 'call_1',
        name: 'read_thing',
        arguments: '{"name":"a.ts"}',
      },
      {
        type: 'function_call_result',
        callId: 'call_1',
        name: 'read_thing',
        output: 'content of a.ts',
      },
    ]);
    expect(conversion.omitted).toEqual([
      { turnSeq: 2, reason: 'reasoning_not_forwarded' },
    ]);
    // The tool group is the part a fork has to seed; messages are session rows.
    expect(toolItemsOf(conversion.turns[0]!)).toHaveLength(2);
    expect(JSON.stringify(conversion)).not.toContain('内部推理');
  });

  it('refuses vendor-private reasoning across protocols and recommends fresh', () => {
    const conversion = convertForkHistory({
      sourceProtocol: 'responses',
      targetProtocol: 'chat-completions',
      turns: [
        turn(2, [
          {
            type: 'reasoning',
            text: '想',
            raw: { providerData: { encrypted_content: 'opaque-signature' } },
          },
          { type: 'message', role: 'assistant', content: '好。' },
        ]),
      ],
    });

    expect(conversion).toMatchObject({
      status: 'refused',
      code: 'private_reasoning',
      recommendation: 'fresh',
      turnSeq: 2,
    });
  });

  it('does not refuse same-protocol private reasoning but never forwards it', () => {
    const conversion = convertForkHistory({
      sourceProtocol: 'responses',
      targetProtocol: 'responses',
      turns: [
        turn(2, [
          {
            type: 'reasoning',
            text: '想',
            raw: { providerData: { encrypted_content: 'same-vendor-signature' } },
          },
          { type: 'message', role: 'assistant', content: '好。' },
        ]),
      ],
    });

    expect(conversion.status).toBe('converted');
    if (conversion.status !== 'converted') throw new Error('expected conversion');
    expect(JSON.stringify(conversion)).not.toContain('same-vendor-signature');
  });

  it('refuses a call without its result as an incomplete tool group', () => {
    const conversion = convertForkHistory({
      sourceProtocol: 'responses',
      targetProtocol: 'chat-completions',
      turns: [
        turn(2, [
          { type: 'message', role: 'assistant', content: '先读。' },
          {
            type: 'function_call',
            callId: 'call_1',
            name: 'read_thing',
            arguments: '{}',
          },
        ]),
      ],
    });

    expect(conversion).toMatchObject({
      status: 'refused',
      code: 'incomplete_tool_group',
      recommendation: 'fresh',
    });
  });

  it('refuses a result without its call', () => {
    const conversion = convertForkHistory({
      sourceProtocol: 'chat-completions',
      targetProtocol: 'responses',
      turns: [
        turn(2, [
          {
            type: 'function_call_result',
            callId: 'call_1',
            name: 'read_thing',
            output: 'orphan',
          },
        ]),
      ],
    });

    expect(conversion).toMatchObject({ status: 'refused', code: 'orphan_tool_result' });
  });

  it('refuses a tool name Chat Completions cannot encode', () => {
    const conversion = convertForkHistory({
      sourceProtocol: 'responses',
      targetProtocol: 'chat-completions',
      turns: [
        turn(2, [
          { type: 'message', role: 'assistant', content: '调用。' },
          {
            type: 'function_call',
            callId: 'call_1',
            name: 'mcp/server.read',
            arguments: '{}',
          },
          {
            type: 'function_call_result',
            callId: 'call_1',
            name: 'mcp/server.read',
            output: 'ok',
          },
        ]),
      ],
    });

    expect(conversion).toMatchObject({ status: 'refused', code: 'unsupported_tool_call' });
  });

  it('refuses image content it cannot re-encode across protocols', () => {
    const conversion = convertForkHistory({
      sourceProtocol: 'chat-completions',
      targetProtocol: 'responses',
      turns: [
        turn(1, [
          { type: 'message', role: 'user', content: '看图', hasImages: true },
        ]),
      ],
    });

    expect(conversion).toMatchObject({ status: 'refused', code: 'image_not_portable' });
  });

  it('refuses an uncommitted turn', () => {
    const conversion = convertForkHistory({
      sourceProtocol: 'responses',
      targetProtocol: 'chat-completions',
      turns: [turn(3, [{ type: 'message', role: 'user', content: '未提交' }], false)],
    });

    expect(conversion).toMatchObject({ status: 'refused', code: 'uncommitted_turn' });
  });
});
