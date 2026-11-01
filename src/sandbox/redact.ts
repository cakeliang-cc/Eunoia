/**
 * Secret redaction for everything the sandbox writes down.
 *
 * Three places leak credentials if this is not applied: the execution event log,
 * the audit log, and the model-visible stdout/stderr of a command that echoed an
 * environment variable. The broker never injects a long-lived host credential,
 * but a short-lived token is still a token.
 *
 * The implementation is deliberately conservative and deterministic: known
 * secret values are replaced by a fixed marker, and common credential shapes
 * (`Bearer …`, `sk-…`, `ghp_…`, `AKIA…`, password assignments) are redacted even
 * when the value was not registered. A redactor that only knows registered
 * values misses the token a command printed from its own config file.
 */

const PLACEHOLDER = '[redacted]';

const PATTERNS: readonly { readonly name: string; readonly regex: RegExp }[] = [
  { name: 'bearer', regex: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi },
  { name: 'openai', regex: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { name: 'github', regex: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: 'aws-key', regex: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: 'private-key', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  {
    name: 'assignment',
    regex: /\b(password|passwd|secret|token|api[_-]?key|authorization)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
  },
];

export interface RedactorOptions {
  /** Values that must never appear in output, whatever their shape. */
  readonly secrets?: readonly string[];
}

export class Redactor {
  private secrets: string[];
  private readonly patterns: readonly { readonly name: string; readonly regex: RegExp }[];

  constructor(options: RedactorOptions = {}) {
    // Longest first: replacing a substring of a longer secret would leave the
    // remainder in place and look redacted.
    this.secrets = [...(options.secrets ?? [])]
      .filter((value) => value.trim().length >= 4)
      .sort((left, right) => right.length - left.length);
    this.patterns = PATTERNS;
  }

  /** Register a value after construction (a credential issued mid-process). */
  addSecret(value: string): void {
    if (value.trim().length < 4 || this.secrets.includes(value)) return;
    this.secrets = [...this.secrets, value].sort((left, right) => right.length - left.length);
  }

  /** Redact a string, leaving the surrounding text readable. */
  redact(text: string): string {
    let output = text;
    for (const secret of this.secrets) {
      output = output.split(secret).join(PLACEHOLDER);
    }
    for (const pattern of this.patterns) {
      // `replace` with a global regex resets lastIndex, unlike `test`.
      output = output.replace(pattern.regex, (_match, ...groups: unknown[]) => {
        if (pattern.name === 'assignment') {
          const key = String(groups[0] ?? '');
          const separator = String(groups[1] ?? '');
          return `${key}${separator}${PLACEHOLDER}`;
        }
        if (pattern.name === 'bearer') {
          const scheme = String(groups[0] ?? 'Bearer');
          return `${scheme} ${PLACEHOLDER}`;
        }
        return PLACEHOLDER;
      });
    }
    return output;
  }

  /** Deep-redact an audit payload. Keys are preserved; strings are redacted. */
  redactValue(value: unknown, depth = 0): unknown {
    if (depth > 8) return PLACEHOLDER;
    if (typeof value === 'string') return this.redact(value);
    if (Array.isArray(value)) return value.map((entry) => this.redactValue(entry, depth + 1));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        out[key] = isSecretKey(key) ? PLACEHOLDER : this.redactValue(entry, depth + 1);
      }
      return out;
    }
    return value;
  }
}

const SECRET_KEYS = new Set([
  'secret',
  'token',
  'password',
  'passwd',
  'apikey',
  'api_key',
  'authorization',
  'cookie',
  'credential',
  'credentials',
  'privatekey',
  'private_key',
]);

export function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key.toLowerCase());
}

/** A no-op redactor for tests that explicitly do not care. */
export const NOOP_REDACTOR = {
  redact: (text: string) => text,
  redactValue: (value: unknown) => value,
};
