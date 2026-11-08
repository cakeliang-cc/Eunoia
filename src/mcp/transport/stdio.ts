/**
 * The stdio transport boundary.
 *
 * Two implementations sit behind one port:
 *
 *   - **host** — the SDK spawns the server executable directly. Only a
 *     deployment switch can enable it, and the management view says "宿主进程";
 *     it is not sandboxed and is never described that way.
 *   - **sandbox** — a fresh OCI container per connection, with a pinned image,
 *     no network, a read-only root, dropped capabilities and an explicit
 *     environment. `docker run -i` is the controlled interactive process the
 *     existing `ContainerCli` cannot provide.
 *
 * stdin/stdout carry the protocol only. stderr is piped, bounded and redacted
 * before it reaches a log or the UI: a server that echoes a token there must not
 * get it into the diagnostics page.
 *
 * See docs/adr/033-mcp-host.md §6.1.
 */

import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { stdioEnvironment } from '../config.ts';
import { MCP_REDACTOR } from '../credentials.ts';
import { McpError, type McpStdioConfig } from '../types.ts';

/** How many stderr lines are kept for diagnostics. */
const STDERR_TAIL_LINES = 40;
const STDERR_LINE_MAX = 2_000;

export interface StdioProcessSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env: Record<string, string>;
  /** Env variable names passed to `docker run -e NAME` (values stay off argv). */
  readonly envNames?: readonly string[];
  readonly maxBufferSize: number;
}

export interface BuiltStdioTransport {
  readonly transport: StdioClientTransport;
  /** The tail of the child's stderr, bounded and redacted on read. */
  stderrTail(): readonly string[];
  /** The process id once started, for diagnostics and cleanup evidence. */
  pid(): number | null;
  readonly location: 'host' | 'sandbox';
}

/**
 * Build the argv for a sandboxed server.
 *
 * The image must be digest-pinned. Mounts are not configurable: a server that
 * needs a host directory is a host-mode decision the deployment has to make,
 * not something a pasted config can grant itself.
 */
export function buildDockerRunArgs(config: McpStdioConfig, envNames: readonly string[]): string[] {
  if (!config.image) {
    throw new McpError(
      'MCP_CONFIG_INVALID',
      '沙箱运行需要固定 digest 的镜像（stdio.image），否则无法确认运行环境。',
      400,
    );
  }
  const args = [
    'run',
    '--rm',
    '-i',
    '--network',
    'none',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=64m',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '256',
    '--memory',
    '512m',
    '--cpus',
    '1',
    '--user',
    '65532:65532',
  ];
  for (const name of envNames) args.push('-e', name);
  if (config.cwd) args.push('-w', config.cwd);
  args.push(config.image, config.command, ...config.args);
  return args;
}

function attachStderr(transport: StdioClientTransport): () => readonly string[] {
  const lines: string[] = [];
  const stream = transport.stderr;
  if (!stream) return () => lines;
  let buffer = '';
  stream.on('data', (chunk: Buffer | string) => {
    buffer += chunk.toString();
    // Split on newlines but never keep an unbounded partial line: a server that
    // streams without newlines must not grow the diagnostic buffer.
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      push(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
    }
    if (buffer.length > STDERR_LINE_MAX) {
      push(buffer);
      buffer = '';
    }
  });
  stream.on('error', () => undefined);
  function push(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    lines.push(MCP_REDACTOR.redact(trimmed.slice(0, STDERR_LINE_MAX)));
    if (lines.length > STDERR_TAIL_LINES) lines.shift();
  }
  return () => [...lines];
}

/** Build a host-mode transport. Callers must have checked the deployment flag. */
export function createHostStdioTransport(
  config: McpStdioConfig,
  options: { readonly env?: NodeJS.ProcessEnv; readonly maxBufferSize: number },
): BuiltStdioTransport {
  if (config.runLocation !== 'host') {
    throw new McpError('MCP_CONFIG_INVALID', 'host transport requires runLocation "host"');
  }
  const env = options.env ?? process.env;
  const resolved = stdioEnvironment(config.envRefs, env);
  if (resolved.missing.length > 0) {
    throw new McpError(
      'MCP_AUTH_REQUIRED',
      `stdio 服务需要的环境变量没有值：${resolved.missing.join(', ')}`,
      409,
      { detail: { missing: resolved.missing } },
    );
  }
  const transport = new StdioClientTransport({
    command: config.command,
    args: [...config.args],
    ...(config.cwd ? { cwd: config.cwd } : {}),
    env: resolved.env,
    stderr: 'pipe',
    maxBufferSize: options.maxBufferSize,
  });
  const tail = attachStderr(transport);
  return {
    transport,
    stderrTail: tail,
    pid: () => transport.pid ?? null,
    location: 'host',
  };
}

/**
 * Build a containerised transport.
 *
 * The docker CLI is the controlled parent; the server itself runs inside the
 * container. Values for referenced variables are passed by name (`-e NAME`), so
 * they are inherited from *this* spawn's environment rather than written on
 * argv where `ps` would show them.
 */
export function createSandboxStdioTransport(
  config: McpStdioConfig,
  options: { readonly env?: NodeJS.ProcessEnv; readonly maxBufferSize: number },
): BuiltStdioTransport {
  if (config.runLocation !== 'sandbox') {
    throw new McpError('MCP_CONFIG_INVALID', 'sandbox transport requires runLocation "sandbox"');
  }
  const env = options.env ?? process.env;
  const resolved = stdioEnvironment(config.envRefs, env);
  if (resolved.missing.length > 0) {
    throw new McpError(
      'MCP_AUTH_REQUIRED',
      `stdio 服务需要的环境变量没有值：${resolved.missing.join(', ')}`,
      409,
      { detail: { missing: resolved.missing } },
    );
  }
  const envNames = Object.keys(config.envRefs ?? {});
  const dockerArgs = buildDockerRunArgs(config, envNames);
  if (process.env.MCP_SANDBOX_DISABLED === '1') {
    throw new McpError(
      'MCP_UNSUPPORTED',
      '沙箱启动被这个部署关闭（MCP_SANDBOX_DISABLED=1）；宿主模式需要单独授权，不能静默替换。',
      409,
      { detail: { reason: 'sandbox_unavailable' } },
    );
  }
  const transport = new StdioClientTransport({
    command: process.env.MCP_DOCKER_BINARY?.trim() || 'docker',
    args: dockerArgs,
    env: resolved.env,
    stderr: 'pipe',
    maxBufferSize: options.maxBufferSize,
  });
  const tail = attachStderr(transport);
  return {
    transport,
    stderrTail: tail,
    pid: () => transport.pid ?? null,
    location: 'sandbox',
  };
}

export function createStdioTransport(
  config: McpStdioConfig,
  options: { readonly env?: NodeJS.ProcessEnv; readonly maxBufferSize: number },
): BuiltStdioTransport {
  return config.runLocation === 'host'
    ? createHostStdioTransport(config, options)
    : createSandboxStdioTransport(config, options);
}
