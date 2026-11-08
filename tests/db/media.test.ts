/**
 * A01/A02: the two stores must agree, and an old database must upgrade without
 * rewriting what people said.
 *
 * The migration test builds a real version-8 file (dropping the version-9
 * column/tables) and opens it twice. "It worked once" is not idempotence.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { openSqliteStore, type SqliteStore } from '../../src/db/sqlite-store.ts';
import { SQLITE_SCHEMA_VERSION } from '../../src/db/sqlite-schema.ts';
import type { UserContentV1 } from '../../src/agent/content.ts';
import { contentText } from '../../src/agent/content.ts';
import type { Store } from '../../src/store.ts';
import { makeAsset } from '../helpers/images.ts';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

const interleaved: UserContentV1 = {
  version: 1,
  parts: [
    { type: 'text', text: '第一段' },
    { type: 'image', assetId: ID_A },
    { type: 'text', text: '第二段' },
    { type: 'image', assetId: ID_B },
  ],
};

async function seed(store: Store, userId: string, conversationId: string): Promise<void> {
  await store.createMediaAsset(
    makeAsset({ id: ID_A, userId, conversationId, name: 'a.png', status: 'pending' }),
  );
  await store.createMediaAsset(
    makeAsset({ id: ID_B, userId, conversationId, name: 'b.png', status: 'pending' }),
  );
}

describe.each([
  ['InMemoryStore', () => new InMemoryStore() as Store],
  ['SqliteStore', () => openSqliteStore(':memory:') as Store],
])('A02 — ordered blocks in %s', (_name, make) => {
  it('stores text and images interleaved and derives the projection once', async () => {
    const store = make();
    const userId = randomUUID();
    await store.ensureUser(userId);
    const conversation = await store.createConversation(userId);
    await seed(store, userId, conversation.id);

    const message = await store.appendMessage({
      conversationId: conversation.id,
      userId,
      role: 'user',
      content: '要被我覆盖的投影',
      contentParts: interleaved,
      assetIds: [ID_A, ID_B],
    });

    expect(message.content).toBe(contentText(interleaved));
    expect(message.content).toBe('第一段\n第二段');
    expect(message.contentParts?.parts.map((part) => part.type)).toEqual([
      'text',
      'image',
      'text',
      'image',
    ]);

    const [read] = await store.listMessages(userId, conversation.id);
    expect(read?.contentParts).toEqual(interleaved);
    expect(await store.messageAssetIds(message.id)).toEqual([ID_A, ID_B]);
    expect((await store.getMediaAsset(userId, ID_A))?.status).toBe('bound');

    await store.close();
  });

  it('keeps duplicate occurrences as separate ordered references', async () => {
    const store = make();
    const userId = randomUUID();
    await store.ensureUser(userId);
    const conversation = await store.createConversation(userId);
    await store.createMediaAsset(makeAsset({ id: ID_A, userId, conversationId: conversation.id }));
    const content: UserContentV1 = {
      version: 1,
      parts: [
        { type: 'image', assetId: ID_A },
        { type: 'image', assetId: ID_A },
      ],
    };
    const message = await store.appendMessage({
      conversationId: conversation.id,
      userId,
      role: 'user',
      content: '',
      contentParts: content,
      assetIds: [ID_A, ID_A],
    });
    expect(await store.messageAssetIds(message.id)).toEqual([ID_A, ID_A]);
    await store.close();
  });

  it('reads an old text row as one text block', async () => {
    const store = make();
    const userId = randomUUID();
    await store.ensureUser(userId);
    const conversation = await store.createConversation(userId);
    const message = await store.appendMessage({
      conversationId: conversation.id,
      userId,
      role: 'user',
      content: '旧消息',
    });
    expect(message.contentParts).toBeNull();
    const [read] = await store.listMessages(userId, conversation.id);
    expect(read?.content).toBe('旧消息');
    expect(read?.contentParts ?? null).toBeNull();
    await store.close();
  });
});

describe('A20 — dropping messages releases their images', () => {
  it('marks the last reference released and keeps it for the grace window', async () => {
    const store = new InMemoryStore();
    const userId = randomUUID();
    await store.ensureUser(userId);
    const conversation = await store.createConversation(userId);
    await seed(store, userId, conversation.id);
    const user = await store.appendMessage({
      conversationId: conversation.id,
      userId,
      role: 'user',
      content: '',
      contentParts: { version: 1, parts: [{ type: 'image', assetId: ID_A }] },
      assetIds: [ID_A],
    });
    await store.appendMessage({
      conversationId: conversation.id,
      userId,
      role: 'assistant',
      content: '看图后',
    });
    expect((await store.getMediaAsset(userId, ID_A))?.status).toBe('bound');

    // Regeneration removes only the assistant reply: the image stays bound.
    await store.deleteMessagesAfter(userId, conversation.id, user.seq);
    expect((await store.getMediaAsset(userId, ID_A))?.status).toBe('bound');

    // Deleting the user message itself releases it.
    await store.deleteMessagesAfter(userId, conversation.id, 0);
    expect((await store.getMediaAsset(userId, ID_A))?.status).toBe('released');
    expect(await store.listCollectableMedia(new Date(Date.now() + 25 * 60 * 60 * 1000), 24 * 60 * 60 * 1000)).not.toHaveLength(0);
  });
});

describe('A01 — version 8 database upgrades and restarts idempotently', () => {
  let scratch: string | null = null;
  let path: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'eunoia-v8-'));
    path = join(scratch, 'legacy.sqlite');
    const store = openSqliteStore(path);
    const userId = randomUUID();
    await store.ensureUser(userId);
    const conversation = await store.createConversation(userId, '旧对话');
    await store.appendMessage({
      conversationId: conversation.id,
      userId,
      role: 'user',
      content: '第一句',
    });
    await store.appendMessage({
      conversationId: conversation.id,
      userId,
      role: 'assistant',
      content: '第二句',
    });
    await store.createTurn({
      id: randomUUID(),
      turnId: randomUUID(),
      userId,
      conversationId: conversation.id,
      requestHash: 'hash',
      status: 'completed',
      finishReason: 'completed',
      reply: '第二句',
      messageId: null,
      error: null,
      model: null,
      steps: 1,
      contextTokens: null,
      accepted: true,
      acceptance: [],
      usage: null,
      startedAt: new Date(),
      endedAt: new Date(),
    });
    await store.close();

    const db = new DatabaseSync(path);
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('DROP TABLE IF EXISTS message_assets');
    db.exec('DROP TABLE IF EXISTS media_assets');
    db.exec('ALTER TABLE messages DROP COLUMN content_parts');
    db.exec('PRAGMA user_version = 8');
    db.close();
  });

  afterEach(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
    scratch = null;
  });

  it('preserves count, seq, text and turns across two opens', async () => {
    let beforeRead: { id: string; seq: number; content: string }[] = [];
    for (let open = 0; open < 2; open += 1) {
      const store: SqliteStore = openSqliteStore(path);
      const version = store.database.prepare('PRAGMA user_version').get() as {
        user_version: number;
      };
      expect(Number(version.user_version)).toBe(SQLITE_SCHEMA_VERSION);

      const tables = store.database
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[];
      expect(tables.map((table) => table.name)).toEqual(
        expect.arrayContaining(['media_assets', 'message_assets']),
      );
      const columns = store.database.prepare('PRAGMA table_info(messages)').all() as {
        name: string;
      }[];
      expect(columns.map((column) => column.name)).toContain('content_parts');

      const messages = store.database
        .prepare('SELECT id, seq, content FROM messages ORDER BY seq')
        .all() as { id: string; seq: number; content: string }[];
      if (open === 0) {
        expect(messages.map((message) => message.content)).toEqual(['第一句', '第二句']);
        expect(messages.map((message) => Number(message.seq))).toEqual([1, 2]);
        beforeRead = messages.map((message) => ({
          id: message.id,
          seq: Number(message.seq),
          content: message.content,
        }));
      } else {
        expect(messages.map((message) => ({ ...message, seq: Number(message.seq) }))).toEqual(
          beforeRead,
        );
      }

      const turns = store.database.prepare('SELECT count(*) AS n FROM turn_requests').get() as {
        n: number;
      };
      expect(Number(turns.n)).toBe(1);
      await store.close();
    }
  });

  it('refuses an unknown stored content version instead of reading it as empty', async () => {
    const store = openSqliteStore(path);
    const conversation = store.database
      .prepare('SELECT id FROM conversations LIMIT 1')
      .get() as { id: string };
    store.database
      .prepare('UPDATE messages SET content_parts = ? WHERE seq = 1')
      .run(JSON.stringify({ version: 2, parts: [] }));
    await expect(store.messagesAfter(conversation.id, 0, 10)).rejects.toThrow(
      /unsupported content_parts/,
    );
    await store.close();
  });
});
