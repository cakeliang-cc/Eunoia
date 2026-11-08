/**
 * Sealed secret storage and output redaction.
 *
 * Two rules are structural here, not conventions:
 *
 *   - **No key, no secret.** Without a usable master key the store refuses to
 *     persist a secret. It never falls back to plaintext, and it never stores a
 *     value it could not later decrypt.
 *   - **A secret that went out is not repeated.** Every resolved value is
 *     registered with the process redactor before it can reach a log line, a
 *     tool result or an error message.
 *
 * The master key lives in the deployment environment (or a key file), never in
 * the SQLite file, so a database backup is not a credential backup.
 *
 * See docs/adr/033-mcp-host.md §9.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  createHash,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { McpCredentialRecord, McpStore } from './store.ts';
import { McpError } from './types.ts';

const ALGORITHM = 'aes-256-gcm';
const KEY_VERSION = 1;

export interface SecretBox {
  /** False when no key is configured: secrets may not be persisted. */
  readonly available: boolean;
  readonly keyVersion: number;
  seal(plaintext: string, aad: string): string;
  open(sealed: string, aad: string): string;
}

class NoSecretKeyError extends Error {
  readonly code = 'MCP_SECRET_KEY_MISSING';

  constructor() {
    super(
      'MCP secret storage has no master key. Set EUNOIA_MCP_KEY (base64, 32 bytes) or EUNOIA_MCP_KEY_FILE before storing OAuth tokens.',
    );
    this.name = 'NoSecretKeyError';
  }
}

/**
 * Load the key from the environment or a key file.
 *
 * A malformed key is a startup-level condition, not a per-request one: it is
 * reported as unavailable so a text-only process still boots, and any attempt
 * to persist a secret then fails with an actionable message.
 */
export function loadSecretBox(env: NodeJS.ProcessEnv = process.env): SecretBox {
  const raw = env.EUNOIA_MCP_KEY?.trim();
  const file = env.EUNOIA_MCP_KEY_FILE?.trim();
  let material: Buffer | null = null;
  if (raw && raw.length > 0) {
    material = decodeKey(raw);
  } else if (file && file.length > 0) {
    try {
      material = decodeKey(readFileSync(file, 'utf8').trim());
    } catch {
      material = null;
    }
  }
  if (!material || material.length !== 32) {
    return {
      available: false,
      keyVersion: KEY_VERSION,
      seal() {
        throw new NoSecretKeyError();
      },
      open() {
        throw new NoSecretKeyError();
      },
    };
  }
  const key = material;
  return {
    available: true,
    keyVersion: KEY_VERSION,
    seal(plaintext, aad) {
      const iv = randomBytes(12);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      cipher.setAAD(Buffer.from(aad, 'utf8'));
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
    },
    open(sealed, aad) {
      const buffer = Buffer.from(sealed, 'base64');
      if (buffer.length < 12 + 16) throw new Error('sealed value is truncated');
      const iv = buffer.subarray(0, 12);
      const tag = buffer.subarray(12, 28);
      const ciphertext = buffer.subarray(28);
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    },
  };
}

function decodeKey(value: string): Buffer | null {
  // Accept base64 first; a 64-character hex key is accepted too because that is
  // what `openssl rand -hex 32` produces.
  try {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length === 32) return decoded;
  } catch {
    // fall through
  }
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
  return null;
}

function aadFor(userId: string, serverId: string, kind: string, keyVersion: number): string {
  return `mcp|${userId}|${serverId}|${kind}|v${keyVersion}`;
}

export class McpCredentialVault {
  readonly #store: McpStore;
  readonly #box: SecretBox;
  readonly #now: () => Date;

  constructor(store: McpStore, box: SecretBox, now: () => Date = () => new Date()) {
    this.#store = store;
    this.#box = box;
    this.#now = now;
  }

  get available(): boolean {
    return this.#box.available;
  }

  /** Store an opaque JSON payload. Refuses when no key is configured. */
  async put(input: {
    readonly userId: string;
    readonly serverId: string;
    readonly kind: string;
    readonly value: unknown;
    readonly scope?: string | null;
    readonly account?: string | null;
    readonly expiresAt?: string | null;
  }): Promise<void> {
    if (!this.#box.available) {
      throw new McpError('MCP_AUTH_REQUIRED', new NoSecretKeyError().message, 409, {
        detail: { reason: 'secret_key_missing' },
      });
    }
    const aad = aadFor(input.userId, input.serverId, input.kind, this.#box.keyVersion);
    const sealed = this.#box.seal(JSON.stringify(input.value), aad);
    const now = this.#now().toISOString();
    const existing = await this.#store.getMcpCredential(input.userId, input.serverId, input.kind);
    const record: McpCredentialRecord = {
      id: existing?.id ?? randomUUID(),
      userId: input.userId,
      serverId: input.serverId,
      kind: input.kind,
      sealed,
      keyVersion: this.#box.keyVersion,
      aad,
      scope: input.scope ?? null,
      account: input.account ?? null,
      expiresAt: input.expiresAt ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.#store.putMcpCredential(record);
  }

  /** Read and decrypt. A key mismatch is reported as "log in again". */
  async get<T>(input: {
    readonly userId: string;
    readonly serverId: string;
    readonly kind: string;
  }): Promise<{ readonly value: T; readonly scope: string | null; readonly account: string | null; readonly expiresAt: string | null } | null> {
    const record = await this.#store.getMcpCredential(
      input.userId,
      input.serverId,
      input.kind,
    );
    if (!record) return null;
    if (!this.#box.available) {
      throw new McpError(
        'MCP_AUTH_EXPIRED',
        '凭据已保存，但当前进程没有解密密钥；请重新登录或恢复 EUNOIA_MCP_KEY。',
        409,
        { detail: { reason: 'secret_key_missing' } },
      );
    }
    try {
      const value = JSON.parse(this.#box.open(record.sealed, record.aad)) as T;
      return {
        value,
        scope: record.scope,
        account: record.account,
        expiresAt: record.expiresAt,
      };
    } catch {
      throw new McpError(
        'MCP_AUTH_EXPIRED',
        '凭据无法解密（密钥已更换或被篡改），请重新登录。',
        409,
        { detail: { reason: 'secret_decrypt_failed' } },
      );
    }
  }

  async delete(userId: string, serverId: string): Promise<void> {
    await this.#store.deleteMcpCredentials(userId, serverId);
  }
}

// --------------------------------------------------------------- redactor ---

/**
 * The process-wide redactor.
 *
 * Registered secrets are replaced before a string reaches a log, an error
 * message, a tool result or the model. It is intentionally a process singleton:
 * a per-call redactor would be forgotten at exactly the boundary — an error
 * thrown from a transport — where a token most often leaks.
 */
export class SecretRedactor {
  readonly #secrets = new Map<string, string>();

  register(secret: string, label = 'secret'): void {
    if (secret.length < 6) return;
    this.#secrets.set(secret, `[redacted:${label}]`);
  }

  /** Register a token and its common encodings. */
  registerToken(secret: string, label = 'secret'): void {
    this.register(secret, label);
    this.register(Buffer.from(secret, 'utf8').toString('base64'), label);
    this.register(encodeURIComponent(secret), label);
  }

  redact(value: string): string {
    let result = value;
    // Longest first, so a token that contains another does not leave a fragment.
    const entries = [...this.#secrets.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [secret, replacement] of entries) {
      if (result.includes(secret)) result = result.split(secret).join(replacement);
    }
    return result;
  }

  redactDeep<T>(value: T): T {
    if (typeof value === 'string') return this.redact(value) as unknown as T;
    if (Array.isArray(value)) return value.map((entry) => this.redactDeep(entry)) as unknown as T;
    if (value && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        result[key] = this.redactDeep(entry);
      }
      return result as unknown as T;
    }
    return value;
  }

  /** Whether a schema contains one of the registered values. */
  containsSecret(value: unknown): boolean {
    const text = JSON.stringify(value);
    if (text === undefined) return false;
    for (const secret of this.#secrets.keys()) {
      if (text.includes(secret)) return true;
    }
    return false;
  }

  /** Constant-time check, for tests and diagnostics that compare values. */
  matches(secret: string): boolean {
    for (const registered of this.#secrets.keys()) {
      if (registered.length !== secret.length) continue;
      if (timingSafeEqual(Buffer.from(registered), Buffer.from(secret))) return true;
    }
    return false;
  }

  /** A stable digest for logs that need to correlate a secret without showing it. */
  digest(secret: string): string {
    return createHash('sha256').update(secret).digest('hex').slice(0, 12);
  }
}

export const MCP_REDACTOR = new SecretRedactor();

/** Resolve a header reference, registering the value before returning it. */
export function resolveSecretReference(
  reference: string,
  env: NodeJS.ProcessEnv,
  label: string,
): string | null {
  const match = /^env:([A-Z][A-Z0-9_]{0,63})$/.exec(reference);
  if (!match) return null;
  const name = match[1] as string;
  const value = env[name];
  if (typeof value !== 'string' || value.length === 0) return null;
  MCP_REDACTOR.registerToken(value, label);
  return value;
}
