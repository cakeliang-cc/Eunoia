/**
 * Configuration is the security boundary: it decides where a process runs, what
 * network it may reach and which environment it receives. These tests exercise
 * the refusals, not only the happy path.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG_PARSE_OPTIONS,
  parseServerInput,
  previewMcpServersImport,
  resolveReference,
  stdioEnvironment,
  validateHttpEndpoint,
} from '../../src/mcp/config.ts';

const base = { ...DEFAULT_CONFIG_PARSE_OPTIONS, userId: 'user-1' };

function stdio(overrides: Record<string, unknown> = {}) {
  return {
    name: 'demo',
    transport: 'stdio',
    stdio: { command: 'node', args: ['server.mjs'], runLocation: 'host' },
    ...overrides,
  };
}

describe('stdio configuration', () => {
  it('refuses a host process unless the deployment allows it', () => {
    expect(() => parseServerInput(stdio(), base)).toThrow(/not allowed by this deployment/);
    const parsed = parseServerInput(stdio(), { ...base, allowHostProcess: true });
    expect(parsed.config.stdio?.runLocation).toBe('host');
    expect(parsed.config.enabled).toBe(false);
  });

  it('refuses a shell command line as the executable', () => {
    expect(() =>
      parseServerInput(
        stdio({ stdio: { command: 'sh -c "curl evil"', args: [], runLocation: 'host' } }),
        { ...base, allowHostProcess: true },
      ),
    ).toThrow(/one executable/);
  });

  it('requires a digest-pinned image for a sandbox run', () => {
    const image = `node@sha256:${'a'.repeat(64)}`;
    expect(() =>
      parseServerInput(
        stdio({ stdio: { command: 'node', args: [], runLocation: 'sandbox' } }),
        base,
      ),
    ).not.toThrow();
    const parsed = parseServerInput(
      stdio({ stdio: { command: 'node', args: [], runLocation: 'sandbox', image } }),
      base,
    );
    expect(parsed.config.stdio?.image).toBe(image);
    expect(() =>
      parseServerInput(
        stdio({ stdio: { command: 'node', args: [], runLocation: 'sandbox', image: 'node:latest' } }),
        base,
      ),
    ).toThrow(/pinned by digest/);
  });

  it('accepts only env references, and only in the MCP namespace', () => {
    expect(() =>
      parseServerInput(
        stdio({ stdio: { command: 'node', args: [], runLocation: 'host', envRefs: { TOKEN: 'sk-live-123' } } }),
        { ...base, allowHostProcess: true },
      ),
    ).toThrow(/must be a reference/);
    expect(() =>
      parseServerInput(
        stdio({
          stdio: { command: 'node', args: [], runLocation: 'host', envRefs: { TOKEN: 'env:DEEPSEEK_API_KEY' } },
        }),
        { ...base, allowHostProcess: true },
      ),
    ).toThrow(/outside that namespace/);
    const parsed = parseServerInput(
      stdio({ stdio: { command: 'node', args: [], runLocation: 'host', envRefs: { TOKEN: 'env:MCP_TOKEN' } } }),
      { ...base, allowHostProcess: true },
    );
    expect(parsed.config.stdio?.envRefs).toEqual({ TOKEN: 'env:MCP_TOKEN' });
  });

  it('builds a child environment from an allow list plus explicit refs', () => {
    const { env, missing } = stdioEnvironment(
      { TOKEN: 'env:MCP_TOKEN' },
      {
        PATH: '/usr/bin',
        HOME: '/home/me',
        DEEPSEEK_API_KEY: 'secret',
        EUNOIA_CONTROL: 'secret',
        MCP_TOKEN: 'allowed-value',
      },
    );
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/me');
    expect(env.TOKEN).toBe('allowed-value');
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(env.EUNOIA_CONTROL).toBeUndefined();
    expect(missing).toEqual([]);
    expect(stdioEnvironment({ TOKEN: 'env:MCP_MISSING' }, {}).missing).toEqual(['TOKEN']);
  });
});

describe('http configuration', () => {
  it('refuses a private address unless the deployment allows it', () => {
    expect(() =>
      validateHttpEndpoint('http://127.0.0.1:9000/mcp', {
        allowPrivateNetwork: false,
        allowInsecure: true,
      }),
    ).toThrow(/private address/);
    expect(
      validateHttpEndpoint('http://127.0.0.1:9000/mcp', {
        allowPrivateNetwork: true,
        allowInsecure: true,
      }).host,
    ).toBe('127.0.0.1:9000');
  });

  it('refuses plain http to a public host', () => {
    expect(() =>
      validateHttpEndpoint('http://example.com/mcp', {
        allowPrivateNetwork: false,
        allowInsecure: false,
      }),
    ).toThrow(/https/);
  });

  it('refuses credentials embedded in the URL', () => {
    expect(() =>
      validateHttpEndpoint('https://user:pass@example.com/mcp', {
        allowPrivateNetwork: false,
        allowInsecure: false,
      }),
    ).toThrow(/must not embed credentials/);
  });

  it('requires the reference for the declared auth mode', () => {
    expect(() =>
      parseServerInput(
        {
          name: 'remote',
          transport: 'http',
          http: { url: 'https://example.com/mcp', auth: 'bearer' },
        },
        base,
      ),
    ).toThrow(/bearerRef is required/);
    expect(() =>
      parseServerInput(
        {
          name: 'remote',
          transport: 'http',
          http: { url: 'https://example.com/mcp', auth: 'header', headerRefs: {} },
        },
        base,
      ),
    ).toThrow(/must not be empty/);
    expect(() =>
      parseServerInput(
        {
          name: 'remote',
          transport: 'http',
          http: { url: 'https://example.com/mcp', auth: 'header', headerRefs: { host: 'env:MCP_H' } },
        },
        base,
      ),
    ).toThrow(/not an allowed header/);
  });

  it('stores references and never a value', () => {
    const parsed = parseServerInput(
      {
        name: 'remote',
        transport: 'http',
        http: {
          url: 'https://example.com/mcp',
          auth: 'bearer',
          bearerRef: 'env:MCP_TOKEN',
        },
      },
      base,
    );
    expect(JSON.stringify(parsed.config)).not.toContain('sk-');
    expect(parsed.config.http?.bearerRef).toBe('env:MCP_TOKEN');
    expect(resolveReference('env:MCP_TOKEN', { MCP_TOKEN: 'x' })).toBe('x');
    expect(resolveReference('env:DEEPSEEK_API_KEY', { DEEPSEEK_API_KEY: 'x' })).toBeNull();
  });
});

describe('import preview', () => {
  it('previews stdio and http entries and converts literals into references', () => {
    const preview = previewMcpServersImport(
      {
        mcpServers: {
          local: { command: 'node', args: ['a.mjs'], env: { TOKEN: '${MCP_TOKEN}' } },
          remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer literal' } },
          legacy: { type: 'sse', url: 'https://example.com/sse' },
        },
      },
      { ...base, allowHostProcess: true },
    );
    expect(preview.servers).toHaveLength(2);
    expect(preview.skipped).toEqual([{ name: 'legacy', reason: 'transport "sse" is not supported' }]);
    const remote = preview.servers.find((entry) => entry.name === 'remote');
    expect(remote?.warnings.some((warning) => warning.includes('已改为 env:'))).toBe(true);
    expect(JSON.stringify(preview)).not.toContain('Bearer literal');
    expect(preview.servers.every((entry) => entry.input.enabled === false)).toBe(true);
  });

  it('reports a host-mode import as skipped when the deployment forbids it', () => {
    const preview = previewMcpServersImport(
      { mcpServers: { local: { command: 'node', runLocation: 'host' } } },
      base,
    );
    expect(preview.servers).toHaveLength(0);
    expect(preview.skipped[0]?.reason).toMatch(/not allowed/);
  });
});

describe('limits', () => {
  it('clamps a per-server limit to the deployment ceiling', () => {
    expect(() =>
      parseServerInput(
        { ...stdio(), limits: { maxTools: DEFAULT_CONFIG_PARSE_OPTIONS.maxLimits!.maxTools + 1 } },
        { ...base, allowHostProcess: true },
      ),
    ).toThrow(/between/);
  });

  it('rejects non-integer timeouts', () => {
    expect(() =>
      parseServerInput(
        { ...stdio(), timeouts: { connectMs: 1.5 } },
        { ...base, allowHostProcess: true },
      ),
    ).toThrow(/integer/);
  });
});
