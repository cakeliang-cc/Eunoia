/**
 * R12 fault child: a real Node process with a real SQLite database.
 *
 * The parent starts this file with an IPC channel, watches for `{type:'fault'}`,
 * then kills it. Nothing here is an API; `EUNOIA_TEST_FAULT_POINTS` is set only
 * by the test parent.
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { openSqliteStore } from '../../src/db/sqlite-store.ts';
import { runTurn } from '../../src/service/chat.ts';
import { TurnCoordinator, turnRequestHash } from '../../src/service/turns.ts';
import { recoverInterruptedTurns } from '../../src/service/recovery.ts';
import { defineTool } from '../../src/tools/types.ts';
import type { ModelTurn } from '../../src/agent/model-port.ts';
import { publishCandidate } from '../../src/teams/integration.ts';
import type { ArtifactFile } from '../../src/teams/types.ts';

const USER = '00000000-0000-4000-8000-000000000001';

function arg(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing --${name}`);
  return value;
}

async function toolEffect(): Promise<void> {
  const store = openSqliteStore(arg('db'));
  try {
    await store.ensureUser(USER);
    const conversation = await store.createConversation(USER, 'fault-tool');
    const counter = arg('counter');
    const tool = defineTool({
      name: 'fault_effect',
      description: 'test-only: perform an external effect and pause',
      parameters: z.object({ value: z.string() }),
      sideEffect: 'command',
      readOnly: false,
      async execute({ value }) {
        appendFileSync(counter, `${value}\n`);
        await (await import('../../src/observability/faults.ts')).faultPoint('tool.effect.done', {
          counter,
        });
        return { ok: true, output: 'effect done' };
      },
    });
    let step = 0;
    const model: ModelTurn = async function* () {
      step += 1;
      if (step === 1) {
        yield {
          type: 'done',
          output: [
            {
              type: 'function_call',
              callId: 'call_fault_1',
              name: 'fault_effect',
              arguments: JSON.stringify({ value: 'one' }),
            },
          ],
          responseId: 'resp_fault_1',
        };
        return;
      }
      yield {
        type: 'done',
        output: [{ type: 'message', role: 'assistant', content: 'done' }],
        responseId: `resp_fault_${step}`,
      };
    };
    const requestId = arg('request');
    const admission = await new TurnCoordinator(store).begin({
      requestId,
      turnId: requestId,
      userId: USER,
      conversationId: conversation.id,
      requestHash: turnRequestHash({
        kind: 'chat',
        userId: USER,
        conversationId: conversation.id,
        message: 'perform the effect',
      }),
    });
    if (admission.kind !== 'started') throw new Error(`admission refused: ${admission.kind}`);
    for await (const event of runTurn(
      {
        store,
        transcriptMode: 'durable',
        modelTurn: model,
        additionalTools: [tool],
        toolPolicy: { allowWorkspaceWrites: true, allowCommands: true, maxOutputChars: 60_000 },
      },
      {
        userId: USER,
        conversationId: conversation.id,
        message: 'perform the effect',
        requestId,
      },
    )) {
      process.stdout.write(`${JSON.stringify({ event: event.type })}\n`);
    }
    writeFileSync(arg('done'), 'completed');
  } finally {
    await store.close();
  }
}

async function recover(): Promise<void> {
  const store = openSqliteStore(arg('db'));
  try {
    const report = await recoverInterruptedTurns({ store });
    const running = await store.listRunningTurns();
    const conversations = await store.listConversations(USER);
    process.stdout.write(
      `${JSON.stringify({ report, running: running.length, conversations: conversations.length })}\n`,
    );
  } finally {
    await store.close();
  }
}

async function publish(): Promise<void> {
  const spec = JSON.parse(readFileSync(arg('spec'), 'utf8')) as {
    targetRoot: string;
    files: ArtifactFile[];
    sourceHashes: Record<string, string>;
    expectedHashes: Record<string, string>;
    idempotencyKey: string;
    journalPath: string;
  };
  const result = await publishCandidate({
    targetRoot: spec.targetRoot,
    files: spec.files,
    sourceHashes: spec.sourceHashes,
    expectedHashes: spec.expectedHashes,
    idempotencyKey: spec.idempotencyKey,
    journalPath: spec.journalPath,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  writeFileSync(arg('done'), 'published');
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'tool-effect') return toolEffect();
  if (command === 'recover') return recover();
  if (command === 'publish') return publish();
  throw new Error(`unknown command ${String(command)}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
