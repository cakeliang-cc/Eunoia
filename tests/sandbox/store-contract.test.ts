/**
 * Run the sandbox-store contract against both implementations.
 *
 * The two stores are hand-written against the same 56-method port; this file is
 * what keeps "the memory store passed" from meaning something different from
 * "production passed".
 */

import { describe } from 'vitest';
import { sandboxStoreContract } from './store-contract.ts';
import { MemorySandboxStore } from '../../src/sandbox/store-memory.ts';
import { SqliteSandboxStore } from '../../src/sandbox/store-sqlite.ts';
import { openSqliteStore } from '../../src/db/sqlite-store.ts';

describe('the memory and SQLite sandbox stores agree', () => {
  sandboxStoreContract('memory', async () => ({
    store: new MemorySandboxStore(),
    close: () => undefined,
  }));

  sandboxStoreContract('sqlite', async () => {
    const sqlite = openSqliteStore(':memory:');
    return {
      store: new SqliteSandboxStore(sqlite.database),
      close: async () => {
        await sqlite.close();
      },
    };
  });
});
