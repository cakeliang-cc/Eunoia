/**
 * Sealed secrets: the database never contains plaintext, AAD binds a row to its
 * owner and server, and a missing key refuses to store rather than falling back.
 */

import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  loadSecretBox,
  McpCredentialVault,
  MCP_REDACTOR,
  SecretRedactor,
} from '../../src/mcp/credentials.ts';
import { MemoryMcpStore } from '../../src/mcp/store-memory.ts';

const key = randomBytes(32).toString('base64');

describe('SecretBox', () => {
  it('round-trips and rejects a different AAD', () => {
    const box = loadSecretBox({ EUNOIA_MCP_KEY: key });
    expect(box.available).toBe(true);
    const sealed = box.seal('token-value', 'mcp|u|s|k|v1');
    expect(sealed).not.toContain('token-value');
    expect(box.open(sealed, 'mcp|u|s|k|v1')).toBe('token-value');
    expect(() => box.open(sealed, 'mcp|other|s|k|v1')).toThrow();
  });

  it('is unavailable without a key and never silently stores', async () => {
    const box = loadSecretBox({});
    expect(box.available).toBe(false);
    expect(() => box.seal('x', 'aad')).toThrow(/no master key/i);
    const vault = new McpCredentialVault(new MemoryMcpStore(), box);
    await expect(
      vault.put({ userId: 'u', serverId: 's', kind: 'oauth-tokens', value: { token: 'x' } }),
    ).rejects.toThrow(/no master key/i);
  });

  it('persists ciphertext and reads it back with the same key only', async () => {
    const store = new MemoryMcpStore();
    const vault = new McpCredentialVault(store, loadSecretBox({ EUNOIA_MCP_KEY: key }));
    await vault.put({
      userId: 'u',
      serverId: 's',
      kind: 'oauth-tokens',
      value: { access_token: 'at', refresh_token: 'rt' },
      scope: 'read',
      account: 'me',
      expiresAt: '2026-01-01T00:00:00.000Z',
    });
    const record = await store.getMcpCredential('u', 's', 'oauth-tokens');
    expect(record).not.toBeNull();
    expect(record?.sealed).not.toContain('access_token');
    const read = await vault.get<{ access_token: string }>({
      userId: 'u',
      serverId: 's',
      kind: 'oauth-tokens',
    });
    expect(read?.value.access_token).toBe('at');
    expect(read?.account).toBe('me');
    expect(read?.scope).toBe('read');

    const other = new McpCredentialVault(store, loadSecretBox({ EUNOIA_MCP_KEY: randomBytes(32).toString('base64') }));
    await expect(
      other.get({ userId: 'u', serverId: 's', kind: 'oauth-tokens' }),
    ).rejects.toThrow(/无法解密/);
  });
});

describe('redactor', () => {
  it('replaces registered tokens and their base64 form', () => {
    const redactor = new SecretRedactor();
    redactor.registerToken('super-secret-token', 'test');
    expect(redactor.redact('x super-secret-token y')).toContain('[redacted:test]');
    expect(redactor.redact('x super-secret-token y')).not.toContain('super-secret-token');
    const encoded = Buffer.from('super-secret-token').toString('base64');
    expect(redactor.redact(`value ${encoded}`)).not.toContain(encoded);
    expect(redactor.containsSecret({ nested: 'super-secret-token' })).toBe(true);
    expect(redactor.digest('super-secret-token')).toHaveLength(12);
  });

  it('registers a resolved reference before it is returned', () => {
    MCP_REDACTOR.register('abc123456', 'unit');
    expect(MCP_REDACTOR.redact('abc123456')).toBe('[redacted:unit]');
  });
});
