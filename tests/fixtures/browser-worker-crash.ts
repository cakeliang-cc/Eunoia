/** Opt-in Docker fault fixture: the parent test kills THIS control process. */
import { BrowserRuntime } from '../../src/browser/runtime.ts';
import { McpConnection } from '../../src/mcp/client.ts';
import { DEFAULT_CONFIG_PARSE_OPTIONS, parseServerInput } from '../../src/mcp/config.ts';
import { rootExecutionScope } from '../../src/tools/scope.ts';

const id = process.argv[2];
if (!id || process.env.BROWSER_INTEGRATION !== '1') throw new Error('integration fixture only');
const config = parseServerInput({ name: 'Crash fixture', transport: 'stdio', stdio: { command: 'eunoia-browser', args: [], runLocation: 'browser' } }, { ...DEFAULT_CONFIG_PARSE_OPTIONS, userId: 'crash-user', newId: () => id }).config;
const runtime = new BrowserRuntime({ env: { ...process.env, SANDBOX_RUNTIME_CLASS: 'runc', SANDBOX_ALLOW_NON_GVISOR: '1' } });
const connection = await McpConnection.open({ config, identity: 'crash-test', generation: 1, stdioFactory: () => runtime.create(config, rootExecutionScope({ userId: 'crash-user', conversationId: 'crash-conversation' })) });
await connection.callTool({ name: 'browser_tabs', arguments: { action: 'list' } });
process.stdout.write('BROWSER_READY\n');
setInterval(() => undefined, 1_000);
