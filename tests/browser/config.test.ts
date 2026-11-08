import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG_PARSE_OPTIONS, parseServerInput } from '../../src/mcp/config.ts';
import { intersectDomains } from '../../src/browser/runtime.ts';

describe('managed browser capability boundary', () => {
  const config = { name: 'Browser', transport: 'stdio', stdio: { command: 'eunoia-browser', args: [], runLocation: 'browser' } };
  const options = { ...DEFAULT_CONFIG_PARSE_OPTIONS, userId: 'user-1' };
  it('does not require host process permission', () => {
    expect(parseServerInput(config, options).config.stdio?.runLocation).toBe('browser');
  });
  it.each([{ command: 'sh' }, { args: ['--proxy-server', 'http://other'] }, { cwd: '/workspace' }, { image: 'malicious:latest' }, { envRefs: { TOKEN: 'env:MCP_TOKEN' } }])('refuses pasted config overrides: %j', (override) => {
    expect(() => parseServerInput({ ...config, stdio: { ...config.stdio, ...override } }, options)).toThrow(/managed browser/);
  });
  it('intersects deployment and member domains rather than widening either', () => {
    expect(intersectDomains(['*.example.com', 'registry.npmjs.org'], ['images.example.com', 'npmjs.org', 'evil.test'])).toEqual(['images.example.com', 'registry.npmjs.org']);
    expect(intersectDomains(['a.example.com'], ['b.example.com'])).toEqual([]);
  });
});
