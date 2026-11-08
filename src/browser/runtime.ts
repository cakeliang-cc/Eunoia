/** Browser MCP runs in a disposable, unprivileged network:none container. */
import { log } from '../observability/logging.ts';
import { randomUUID } from 'node:crypto';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { ContainerCli } from '../sandbox/runtime/container-cli.ts';
import { startManagedEgress } from '../sandbox/network/managed-egress.ts';
import type { EgressProxyOptions } from '../sandbox/network/egress-proxy.ts';
import type { ExecutionScope } from '../tools/scope.ts';
import type { McpServerConfig } from '../mcp/types.ts';
import { McpError } from '../mcp/types.ts';
import { attachStderr, type BuiltStdioTransport } from '../mcp/transport/stdio.ts';
import type { BrowserOutputFileSystem } from '../mcp/browser-output.ts';

export interface BrowserRuntimeOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly previewRoute?: (scope: ExecutionScope, url: URL) => ReturnType<NonNullable<EgressProxyOptions['previewRoute']>>;
}

const OUTPUT = '/tmp/eunoia-output';
const MCP_ENTRY = '/opt/browser/node_modules/@playwright/mcp/cli.js';

export class BrowserRuntime {
  readonly #env: NodeJS.ProcessEnv;
  readonly #cli: ContainerCli;
  readonly #previewRoute: BrowserRuntimeOptions['previewRoute'];

  constructor(options: BrowserRuntimeOptions = {}) {
    this.#env = options.env ?? process.env;
    this.#cli = new ContainerCli({ binary: this.#env.MCP_DOCKER_BINARY?.trim() || 'docker', kind: 'docker' });
    this.#previewRoute = options.previewRoute;
  }

  async create(config: McpServerConfig, scope?: ExecutionScope): Promise<BuiltStdioTransport> {
    const image = this.#env.EUNOIA_BROWSER_IMAGE_DIGEST?.trim();
    if (!image || !/^(?:sha256:[a-f0-9]{64}|[^\s]+@sha256:[a-f0-9]{64})$/.test(image)) {
      throw new McpError('MCP_CONFIG_INVALID', '隔离浏览器需要 EUNOIA_BROWSER_IMAGE_DIGEST；先构建 scripts/browser-image/Dockerfile，不能回退到宿主浏览器。');
    }
    const name = `eunoia-browser-${randomUUID()}`;
    const args = [
      'create', '-i', '--rm', '--pull', 'never', '--name', name,
      '--label', 'eunoia.browser=true', '--label', `eunoia.mcp.server=${config.id}`,
      '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--user', '1000:1000', '--init',
      '--pids-limit', '256', '--memory', '1g', '--memory-swap', '1g',
      '--cpus', '2', '--shm-size', '128m',
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777', image,
    ];
    const runtimeClass = this.#env.SANDBOX_RUNTIME_CLASS?.trim() || 'gvisor';
    if (runtimeClass === 'gvisor') args.splice(args.indexOf(image), 0, '--runtime', 'runsc');
    else if (!['runc', 'default'].includes(runtimeClass) || this.#env.SANDBOX_ALLOW_NON_GVISOR !== '1') throw new McpError('MCP_CONFIG_INVALID', 'Browser requires gVisor, or explicit SANDBOX_ALLOW_NON_GVISOR=1 with runc/default');
    const commandArgs = [
      '--executable-path', '/usr/bin/chromium', '--headless', '--isolated', '--no-sandbox',
      '--proxy-server', 'http://127.0.0.1:3128', '--proxy-bypass', '<-loopback>',
      '--output-dir', OUTPUT, '--output-max-size', '33554432', '--caps', 'vision',
    ];
    // MCP is the main workload, with init reaping its process tree. Closing
    // its stdin exits the container; --rm also handles a crashed controller.
    const bootstrap = 'require("node:fs").mkdirSync("/tmp/eunoia-output", {recursive:true});process.chdir("/tmp/eunoia-output");require(process.argv[1]);';
    args.push('node', '-e', bootstrap, MCP_ENTRY, ...commandArgs);
    await this.#cli.runChecked(args, { timeoutMs: 30_000 });
    let egress: Awaited<ReturnType<typeof startManagedEgress>> | null = null;
    let cleanupPromise: Promise<void> | null = null;
    const cleanup = (): Promise<void> => cleanupPromise ??= (async () => {
      await egress?.close();
      await this.#cli.run(['rm', '-f', name], { timeoutMs: 15_000 }).catch(() => undefined);
    })();
    try {
      const network = scope?.capabilities.network;
      const deployedDomains = (this.#env.EUNOIA_BROWSER_ALLOWED_DOMAINS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
      const deployedPorts = (this.#env.EUNOIA_BROWSER_ALLOWED_PORTS ?? '80,443').split(',').map(Number).filter((port) => Number.isInteger(port) && port > 0 && port <= 65_535);
      const domains = !scope || network?.mode === 'none' ? [] : network?.mode === 'allowlist' ? intersectDomains(deployedDomains, network.domains) : deployedDomains;
      const ports = network?.mode === 'allowlist' && network.ports.length > 0 ? deployedPorts.filter((port) => network.ports.includes(port)) : deployedPorts;
      const afterConnect = async (): Promise<void> => {
        egress = await startManagedEgress({
          cli: this.#cli,
          container: name,
          policy: { allowedDomains: ports.length ? domains : [], allowedPorts: ports, maxRequestsPerMinute: 600 },
          audit: (event) => log.info('browser.network.request', {
            user_id: config.userId,
            conversation_id: scope?.identity.conversationId ?? null,
            member_id: scope?.identity.memberId ?? null,
            ...event,
          }),
          ...(scope && network?.mode !== 'none' && this.#previewRoute
            ? { previewRoute: (url: URL) => this.#previewRoute!(scope, url) }
            : {}),
        });
        if (cleanupPromise) { await egress.close(); throw new Error('browser closed during network setup'); }
      };
      const transport = new StdioClientTransport({
        command: this.#cli.binary,
        args: ['start', '-a', '-i', name],
        env: { PATH: this.#env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: this.#env.HOME ?? '/tmp' },
        stderr: 'pipe',
        maxBufferSize: config.limits.maxResultBytes,
      });
      // Native HTTP/CONNECT all pass the same checked proxy; UDP/QUIC, custom
      // DNS and direct TCP have nowhere to go on network:none.
      const stderrTail = attachStderr(transport);
      const outputConfig: McpServerConfig = { ...config, stdio: { command: 'playwright-mcp', args: ['--output-dir', OUTPUT], cwd: OUTPUT, runLocation: 'host' } };
      return { transport, pid: () => transport.pid ?? null, stderrTail, location: 'browser', cleanup, afterConnect, browserOutput: { config: outputConfig, fs: containerOutputFs(this.#cli, name) } };
    } catch (error) { await cleanup(); throw error; }
  }
}

export function intersectDomains(a: readonly string[], b: readonly string[]): string[] {
  const result = new Set<string>();
  for (const left of a) for (const right of b) {
    const x = left.toLowerCase().replace(/^\*\./, '');
    const y = right.toLowerCase().replace(/^\*\./, '');
    if (x === y || x.endsWith(`.${y}`)) result.add(x);
    else if (y.endsWith(`.${x}`)) result.add(y);
  }
  return [...result].sort();
}

/** File references are read inside this container, never on the host. */
function containerOutputFs(cli: ContainerCli, container: string): BrowserOutputFileSystem {
  const read = async (op: string, path: string): Promise<string> => {
    const script = String.raw`const fs=require('node:fs'),p=require('node:path');const [op,path]=process.argv.slice(1);const root='/tmp/eunoia-output',lex=p.resolve(path);if(lex!==root&&!lex.startsWith(root+'/'))process.exit(3);const real=fs.realpathSync(lex);if(real!==root&&!real.startsWith(root+'/'))process.exit(3);if(op==='realpath')process.stdout.write(real);else if(op==='stat'){const s=fs.statSync(real);process.stdout.write(JSON.stringify({size:s.size,mtimeMs:s.mtimeMs,isFile:s.isFile(),isDirectory:s.isDirectory()}));}else{const fd=fs.openSync(real,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),s=fs.fstatSync(fd);if(!s.isFile()||s.size<=0||s.size>10485760)process.exit(3);const b=Buffer.alloc(s.size+1),n=fs.readSync(fd,b,0,b.length,0);if(n!==s.size)process.exit(3);process.stdout.write(b.subarray(0,n).toString('base64'));fs.closeSync(fd);}`;
    const result = await cli.runChecked(['exec', container, 'node', '-e', script, op, path], { timeoutMs: 10_000, maxOutputBytes: 15 * 1024 * 1024 });
    return result.stdout;
  };
  return { realpath: (path) => read('realpath', path), stat: async (path) => JSON.parse(await read('stat', path)), readFile: async (path) => Buffer.from(await read('read', path), 'base64') };
}
