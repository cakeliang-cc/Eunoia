/**
 * T59 — old database upgrade and backup/restore.
 *
 * A version-11 database without the Team tables must gain them on open, keep its
 * existing conversation data, and survive a file backup/restore.
 */

import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteStore } from '../../src/db/sqlite-store.ts';
import { SQLITE_SCHEMA_VERSION } from '../../src/db/sqlite-schema.ts';

const USER = '00000000-0000-4000-8000-000000000001';

const TEAM_TABLES = [
  'teams',
  'team_runs',
  'team_members',
  'team_activations',
  'team_tasks',
  'team_task_attempts',
  'team_messages',
  'team_artifacts',
  'team_events',
  'team_budget_entries',
  'team_integrations',
];

describe('T59 — migration and backup/restore', () => {
  it('adds Team tables to a version-11 database without losing data, then restores a backup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eunoia-team-migration-'));
    const path = join(directory, 'db.sqlite');
    try {
      const store = openSqliteStore(path);
      await store.ensureUser(USER);
      const conversation = await store.createConversation(USER, '迁移前会话');
      await store.appendMessage({
        conversationId: conversation.id,
        userId: USER,
        role: 'user',
        content: '必须保留的消息',
      });
      await store.close();

      // Roll the file back to the pre-Team schema: drop the Team tables and
      // claim version 11.
      const raw = new DatabaseSync(path);
      raw.exec('PRAGMA foreign_keys = OFF;');
      for (const table of [...TEAM_TABLES].reverse()) {
        raw.exec(`DROP TABLE IF EXISTS ${table};`);
      }
      raw.exec('PRAGMA user_version = 11;');
      raw.close();

      const reopened = openSqliteStore(path);
      expect(SQLITE_SCHEMA_VERSION).toBe(12);
      const tables = (
        reopened.database
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'team%'")
          .all() as { name: string }[]
      ).map((row) => row.name);
      for (const table of TEAM_TABLES) expect(tables).toContain(table);
      expect(
        (reopened.database.prepare('PRAGMA user_version').get() as { user_version: number })
          .user_version,
      ).toBe(12);
      const message = await reopened.appendMessage({
        conversationId: conversation.id,
        userId: USER,
        role: 'assistant',
        content: '升级后仍然可用',
      });
      expect(message.content).toBe('升级后仍然可用');
      await reopened.close();

      const backup = join(directory, 'backup.sqlite');
      await copyFile(path, backup);
      await rm(path);
      await copyFile(backup, path);
      const restored = openSqliteStore(path);
      const messages = await restored.listMessages(USER, conversation.id, 10);
      expect(messages.map((entry) => entry.content)).toEqual([
        '必须保留的消息',
        '升级后仍然可用',
      ]);
      await restored.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
