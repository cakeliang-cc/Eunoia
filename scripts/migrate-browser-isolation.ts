/** Offline, CAS-protected migration. Dry run by default; stop the app before --apply. */
import { DatabaseSync } from 'node:sqlite';
import { sqlitePath } from '../src/db/select.ts';
import { SqliteMcpStore } from '../src/mcp/store-sqlite.ts';
import { resolveBrowserServer } from '../src/mcp/browser-output.ts';
import { parseServerInput, DEFAULT_CONFIG_PARSE_OPTIONS } from '../src/mcp/config.ts';
import type { McpServerConfig } from '../src/mcp/types.ts';

const apply = process.argv.includes('--apply');
const db = new DatabaseSync(sqlitePath(), { readOnly: !apply });
const store = new SqliteMcpStore(db);
const users = db.prepare('SELECT DISTINCT user_id FROM mcp_servers').all() as { user_id: string }[];
const migrated: Array<{ id: string; name: string; from: string; to: string }> = [];
if (apply) db.exec('BEGIN IMMEDIATE');
try {
  for (const user of users) for (const { config } of await store.listMcpServers(user.user_id)) {
    if (config.stdio?.runLocation !== 'host' || resolveBrowserServer(config).state === 'not_browser') continue;
    const next: McpServerConfig = {
      ...config,
      stdio: { command: 'eunoia-browser', args: [], runLocation: 'browser' },
      configRevision: config.configRevision + 1,
      updatedAt: new Date().toISOString(),
    };
    parseServerInput(next, { ...DEFAULT_CONFIG_PARSE_OPTIONS, userId: config.userId });
    if (apply) {
      if (!await store.updateMcpServer(next, config.configRevision)) throw new Error('configuration changed during migration');
      // The old catalog remains historical evidence, but cannot authorize calls
      // under the new process identity. The next connect discovers it afresh.
      await store.invalidateMcpCatalog(config.userId, config.id, 'browser-runtime-migrated', new Date());
      db.prepare("UPDATE mcp_servers SET status = '{}' WHERE id = ? AND user_id = ?").run(config.id, config.userId);
    }
    migrated.push({ id: config.id, name: config.name, from: 'host', to: 'browser' });
  }
  if (apply) db.exec('COMMIT');
  process.stdout.write(`${JSON.stringify({ applied: apply, servers: migrated }, null, 2)}\n`);
} catch (error) {
  if (apply) db.exec('ROLLBACK');
  throw error;
} finally { db.close(); }
