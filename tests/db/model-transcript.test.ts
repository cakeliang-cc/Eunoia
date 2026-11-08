/**
 * A01–A02 on the real SQLite driver.
 *
 * The in-memory store proves the rule; this file proves the migration and the
 * constraints that make the rule hold across a restart.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteStore } from '../../src/db/sqlite-store.ts';
import { SQLITE_SCHEMA_VERSION } from '../../src/db/sqlite-schema.ts';

const USER = '00000000-0000-4000-8000-000000000001';
const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop() as string, { recursive: true, force: true });
});

async function dbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'eunoia-transcript-'));
  dirs.push(dir);
  return join(dir, 'eunoia.sqlite');
}

describe('A01: a version-9 database upgrades without losing rows', () => {
  it('adds the transcript tables and turn_usage, and is idempotent on reopen', async () => {
    const path = await dbPath();
    const first = openSqliteStore(path);
    const conversation = await (async () => {
      await first.ensureUser(USER);
      return first.createConversation(USER, 'old');
    })();
    await first.appendMessage({
      conversationId: conversation.id,
      userId: USER,
      role: 'user',
      content: 'old message',
    });
    await first.close();

    // Rewind to the version-9 shape.
    const legacy = new DatabaseSync(path);
    for (const table of ['model_context_state', 'model_steps', 'model_items', 'model_epochs']) {
      legacy.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    legacy.exec('ALTER TABLE turn_requests DROP COLUMN turn_usage');
    legacy.exec('PRAGMA user_version = 9');
    legacy.close();

    const upgraded = openSqliteStore(path);
    try {
      const version = upgraded.database.prepare('PRAGMA user_version').get() as {
        user_version: number;
      };
      expect(Number(version.user_version)).toBe(SQLITE_SCHEMA_VERSION);
      const tables = (
        upgraded.database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as { name: string }[]
      ).map((row) => row.name);
      for (const table of ['model_epochs', 'model_items', 'model_steps', 'model_context_state']) {
        expect(tables).toContain(table);
      }
      const turnColumns = (
        upgraded.database.prepare('PRAGMA table_info(turn_requests)').all() as { name: string }[]
      ).map((column) => column.name);
      expect(turnColumns).toContain('turn_usage');

      const messages = await upgraded.listMessages(USER, conversation.id);
      expect(messages.map((message) => message.content)).toEqual(['old message']);

      const epoch = await upgraded.createEpoch({
        id: randomUUID(),
        userId: USER,
        conversationId: conversation.id,
        parentEpochId: null,
        reason: 'legacy-seed',
        instructions: 'prompt',
        promptVersion: 'v1',
        tools: [],
        toolsHash: 'h',
        providerId: 'deepseek',
        modelId: 'deepseek-flash',
        protocolRevision: 'responses@1',
        encoderRevision: 'sdk@1',
        windowItemIds: [],
        windowRevision: 0,
        seededThroughSeq: 0,
        createdAt: new Date(),
      });
      expect(epoch.conversationId).toBe(conversation.id);
    } finally {
      await upgraded.close();
    }

    // Second open is a no-op migration.
    const reopened = openSqliteStore(path);
    try {
      const version = reopened.database.prepare('PRAGMA user_version').get() as {
        user_version: number;
      };
      expect(Number(version.user_version)).toBe(SQLITE_SCHEMA_VERSION);
      expect(await reopened.listEpochs(conversation.id)).toHaveLength(1);
    } finally {
      await reopened.close();
    }
  });
});

describe('A02: SQLite constraints enforce the same contract', () => {
  it('stores one item per idempotency key and one step per attempt', async () => {
    const path = await dbPath();
    const store = openSqliteStore(path);
    try {
      await store.ensureUser(USER);
      const conversation = await store.createConversation(USER);
      const epoch = await store.createEpoch({
        id: randomUUID(),
        userId: USER,
        conversationId: conversation.id,
        parentEpochId: null,
        reason: 'new-conversation',
        instructions: 'prompt',
        promptVersion: 'v1',
        tools: [],
        toolsHash: 'h',
        providerId: 'deepseek',
        modelId: 'deepseek-flash',
        protocolRevision: 'responses@1',
        encoderRevision: 'sdk@1',
        windowItemIds: [],
        windowRevision: 0,
        seededThroughSeq: 0,
        createdAt: new Date(),
      });
      const base = {
        conversationId: conversation.id,
        epochId: epoch.id,
        kind: 'user' as const,
        source: 'user' as const,
        scope: 'conversation' as const,
        payload: { type: 'message' as const, role: 'user' as const, content: 'hello' },
      };
      const first = await store.appendItems([
        { ...base, idempotencyKey: 'user:1' },
        { ...base, idempotencyKey: 'user:2' },
      ]);
      const again = await store.appendItems([{ ...base, idempotencyKey: 'user:1' }]);
      expect(again[0]?.id).toBe(first[0]?.id);
      expect((await store.listItems(conversation.id)).map((item) => item.seq)).toEqual([1, 2]);

      const step = {
        attemptId: randomUUID(),
        requestId: 'req',
        turnId: 'turn',
        conversationId: conversation.id,
        step: 1,
        attemptNo: 1,
        epochId: epoch.id,
        epochRevision: 0,
        inputItemIds: [first[0]!.id],
        requestConfigDigest: 'd',
        projection: null,
        status: 'prepared' as const,
        createdAt: new Date(),
      };
      await store.prepareStep({ items: [], step });
      const duplicate = await store.prepareStep({ items: [], step });
      expect(duplicate.step.attemptId).toBe(step.attemptId);
      expect(await store.listSteps('req')).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  it('cascades transcript rows when the conversation is deleted', async () => {
    const path = await dbPath();
    const store = openSqliteStore(path);
    try {
      await store.ensureUser(USER);
      const conversation = await store.createConversation(USER);
      const epoch = await store.createEpoch({
        id: randomUUID(),
        userId: USER,
        conversationId: conversation.id,
        parentEpochId: null,
        reason: 'new-conversation',
        instructions: 'prompt',
        promptVersion: 'v1',
        tools: [],
        toolsHash: 'h',
        providerId: 'deepseek',
        modelId: 'deepseek-flash',
        protocolRevision: 'responses@1',
        encoderRevision: 'sdk@1',
        windowItemIds: [],
        windowRevision: 0,
        seededThroughSeq: 0,
        createdAt: new Date(),
      });
      await store.appendItems([
        {
          conversationId: conversation.id,
          epochId: epoch.id,
          idempotencyKey: 'user:1',
          kind: 'user',
          source: 'user',
          scope: 'conversation',
          payload: { type: 'message', role: 'user', content: 'hello' },
        },
      ]);
      expect(await store.deleteConversation(USER, conversation.id)).toBe(true);
      const count = store.database
        .prepare('SELECT count(*) AS n FROM model_items WHERE conversation_id = ?')
        .get(conversation.id) as { n: number };
      expect(Number(count.n)).toBe(0);
    } finally {
      await store.close();
    }
  });
});
