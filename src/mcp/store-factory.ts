/**
 * Pick the MCP store that matches the product store.
 *
 * MCP state must live in the same database as conversations, because a deleted
 * conversation cascades its pending approvals and actions. A separate memory
 * store behind a SQLite product store would survive the cascade and leave
 * orphaned approvals.
 */

import type { Store } from '../store.ts';
import { MemoryMcpStore } from './store-memory.ts';
import { SqliteMcpStore } from './store-sqlite.ts';
import type { McpStore } from './store.ts';

export function createMcpStore(store: Store): McpStore {
  const database = (store as { readonly database?: unknown }).database;
  if (database) {
    return new SqliteMcpStore(database as ConstructorParameters<typeof SqliteMcpStore>[0]);
  }
  return new MemoryMcpStore();
}
