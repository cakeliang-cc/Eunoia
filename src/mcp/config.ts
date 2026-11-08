/**
 * Server configuration: one schema, validated everywhere.
 *
 * The GUI, a pasted `mcpServers` file and an environment-driven deployment all
 * go through `parseServerInput`. A second validator would be a second answer to
 * "is this configuration safe?", and the one that ran last would win.
 *
 * Two properties are enforced here rather than at connect time:
 *
 *   - **A reference is not a secret.** Configuration stores `env:NAME`; the
 *     value is resolved only when a process is spawned or a header is sent.
 *   - **A host process is a deployment decision.** `runLocation: 'host'` is
 *     refused unless the process explicitly allows it, and the management UI
 *     shows the trust scope. A model or an ordinary chat approval can never turn
 *     it on.
 *
 * See docs/adr/033-mcp-host.md.
 */

import { randomUUID } from 'node:crypto';
import {
  DEFAULT_MCP_LIMITS,
  DEFAULT_MCP_TIMEOUTS,
  McpError,
  type McpHttpConfig,
  type McpLimits,
  type McpOAuthConfig,
  type McpServerConfig,
  type McpStdioConfig,
  type McpTimeouts,
  type McpToolClassification,
  type McpToolPolicy,
  type McpToolPolicyEntry,
  type McpTransportKind,
} from './types.ts';

/**
 * Environment a child may inherit.
 *
 * Deliberately a list, not a filter: a deny list would leak every variable added
 * later. `DEEPSEEK_API_KEY`, `EUNOIA_*`, database paths and the control-plane
 * token are not here and cannot be reached by a configuration reference.
 */
export const INHERITED_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'WINDIR',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'COMSPEC',
  'PATHEXT',
] as const;

/** Only these prefixes may be referenced by a configuration. */
const REFERENCE_PREFIXES = ['MCP_', 'EUNOIA_MCP_'] as const;

/** Names that must never be passed to a server even if prefixed. */
const FORBIDDEN_REFERENCE_NAMES = new Set([
  'MCP_CONTROL_TOKEN',
  'MCP_DATABASE_URL',
  'EUNOIA_MCP_CONTROL_TOKEN',
]);

const REFERENCE = /^env:([A-Z][A-Z0-9_]{0,63})$/;

export interface ConfigParseOptions {
  /** Deployment switch: may a config run a trusted host process at all? */
  readonly allowHostProcess: boolean;
  /** Deployment switch: may a config reach loopback/private addresses? */
  readonly allowPrivateNetwork: boolean;
  /** Deployment switch: may a config use plain http on a loopback host? */
  readonly allowInsecureLoopback: boolean;
  /** Deployment ceiling; a per-server value may only lower it. */
  readonly maxLimits?: McpLimits;
  readonly maxTimeouts?: McpTimeouts;
  readonly userId: string;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export interface ServerInput {
  readonly id?: string;
  /** Optimistic-lock revision, required on an update and ignored on a create. */
  readonly configRevision?: number;
  readonly name?: unknown;
  readonly enabled?: unknown;
  readonly required?: unknown;
  readonly transport?: unknown;
  readonly http?: unknown;
  readonly stdio?: unknown;
  readonly timeouts?: unknown;
  readonly limits?: unknown;
  readonly toolPolicy?: unknown;
}

export interface ParsedServer {
  readonly config: McpServerConfig;
  /** Non-fatal notes to show in an import preview. */
  readonly notes: readonly string[];
}

// ------------------------------------------------------------ primitives ---

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function invalid(message: string, detail?: Record<string, unknown>): McpError {
  return new McpError('MCP_CONFIG_INVALID', message, 400, detail ? { detail } : {});
}

function stringField(value: unknown, field: string, max = 512): string {
  if (typeof value !== 'string') throw invalid(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw invalid(`${field} must not be empty`);
  if (trimmed.length > max) throw invalid(`${field} is longer than ${max} characters`);
  return trimmed;
}

function booleanField(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw invalid(`${field} must be a boolean`);
  return value;
}

function boundedInt(
  value: unknown,
  field: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw invalid(`${field} must be an integer`);
  }
  if (value < min || value > max) throw invalid(`${field} must be between ${min} and ${max}`);
  return value;
}

function stringList(value: unknown, field: string, maxEntries = 200): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalid(`${field} must be an array`);
  if (value.length > maxEntries) throw invalid(`${field} has more than ${maxEntries} entries`);
  return value.map((entry, index) => stringField(entry, `${field}[${index}]`, 256));
}

export function parseReference(value: unknown, field: string): string {
  const reference = stringField(value, field, 128);
  const match = REFERENCE.exec(reference);
  if (!match) {
    // A raw value is the mistake this message exists to prevent: a token pasted
    // into a config would otherwise be stored, exported and backed up.
    throw invalid(
      `${field} must be a reference like "env:MCP_NAME"; values are never stored in configuration`,
    );
  }
  const name = match[1] as string;
  if (!REFERENCE_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    throw invalid(
      `${field} may only reference MCP_ or EUNOIA_MCP_ variables; ${name} is outside that namespace`,
    );
  }
  if (FORBIDDEN_REFERENCE_NAMES.has(name)) {
    throw invalid(`${field} may not reference the reserved variable ${name}`);
  }
  return reference;
}

/** Resolve a reference to its value, without ever logging the value. */
export function resolveReference(
  reference: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const match = REFERENCE.exec(reference);
  if (!match) return null;
  const name = match[1] as string;
  if (FORBIDDEN_REFERENCE_NAMES.has(name)) return null;
  if (!REFERENCE_PREFIXES.some((prefix) => name.startsWith(prefix))) return null;
  const value = env[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The environment a child process receives. Never the parent's by default. */
export function stdioEnvironment(
  refs: Readonly<Record<string, string>> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { readonly env: Record<string, string>; readonly missing: string[] } {
  const resolved: Record<string, string> = {};
  for (const name of INHERITED_ENV_ALLOWLIST) {
    const value = env[name];
    if (typeof value === 'string' && value.length > 0) resolved[name] = value;
  }
  const missing: string[] = [];
  for (const [name, reference] of Object.entries(refs ?? {})) {
    const value = resolveReference(reference, env);
    if (value === null) {
      missing.push(name);
      continue;
    }
    resolved[name] = value;
  }
  return { env: resolved, missing };
}

// ------------------------------------------------------------ validation ---

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (LOOPBACK.has(host) || host.endsWith('.localhost') || host.endsWith('.internal')) return true;
  if (/^10\./.test(host) || /^127\./.test(host) || /^169\.254\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host === '0.0.0.0' || host === '::') return true;
  return false;
}

export function validateHttpEndpoint(
  rawUrl: string,
  options: { readonly allowPrivateNetwork: boolean; readonly allowInsecure: boolean },
): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw invalid('http.url must be an absolute URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw invalid('http.url must use https (or http for an explicitly allowed local service)');
  }
  const privateHost = isPrivateHost(url.hostname);
  if (privateHost && !options.allowPrivateNetwork) {
    throw invalid(
      'http.url points at a loopback or private address; this deployment has not enabled private network access',
      { host: url.hostname },
    );
  }
  if (url.protocol === 'http:' && !privateHost && !options.allowInsecure) {
    throw invalid('http.url must use https for a non-local host');
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw invalid('http.url must not embed credentials; use an auth reference');
  }
  return url;
}

function parseHttp(value: unknown, options: ConfigParseOptions): McpHttpConfig {
  const record = asRecord(value, 'http');
  const url = stringField(record.url, 'http.url', 2048);
  const allowPrivateNetwork = booleanField(
    record.allowPrivateNetwork,
    'http.allowPrivateNetwork',
    options.allowPrivateNetwork,
  );
  const allowInsecure = booleanField(
    record.allowInsecure,
    'http.allowInsecure',
    options.allowInsecureLoopback,
  );
  validateHttpEndpoint(url, { allowPrivateNetwork, allowInsecure });

  const authRaw = record.auth ?? 'none';
  if (
    authRaw !== 'none' &&
    authRaw !== 'bearer' &&
    authRaw !== 'header' &&
    authRaw !== 'oauth'
  ) {
    throw invalid('http.auth must be one of none, bearer, header, oauth');
  }
  const auth = authRaw;

  let bearerRef: string | undefined;
  if (auth === 'bearer') {
    if (record.bearerRef === undefined) throw invalid('http.bearerRef is required for bearer auth');
    bearerRef = parseReference(record.bearerRef, 'http.bearerRef');
  } else if (record.bearerRef !== undefined) {
    throw invalid('http.bearerRef is only valid with auth "bearer"');
  }

  let headerRefs: Record<string, string> | undefined;
  if (auth === 'header') {
    const headers = asRecord(record.headerRefs, 'http.headerRefs');
    const entries = Object.entries(headers);
    if (entries.length === 0) throw invalid('http.headerRefs must not be empty for header auth');
    headerRefs = {};
    for (const [name, reference] of entries) {
      if (!/^[A-Za-z0-9-]{1,64}$/.test(name) || /^(authorization|host|content-length)$/i.test(name)) {
        throw invalid(`http.headerRefs.${name} is not an allowed header name`);
      }
      headerRefs[name] = parseReference(reference, `http.headerRefs.${name}`);
    }
  } else if (record.headerRefs !== undefined) {
    throw invalid('http.headerRefs is only valid with auth "header"');
  }

  let oauth: McpOAuthConfig | undefined;
  if (auth === 'oauth') {
    if (record.oauth !== undefined) {
      const entry = asRecord(record.oauth, 'http.oauth');
      oauth = {
        ...(entry.clientId !== undefined ? { clientId: stringField(entry.clientId, 'http.oauth.clientId', 256) } : {}),
        ...(entry.clientSecretRef !== undefined
          ? { clientSecretRef: parseReference(entry.clientSecretRef, 'http.oauth.clientSecretRef') }
          : {}),
        ...(entry.scopes !== undefined
          ? { scopes: stringList(entry.scopes, 'http.oauth.scopes', 32) }
          : {}),
        ...(entry.redirectUri !== undefined
          ? { redirectUri: stringField(entry.redirectUri, 'http.oauth.redirectUri', 2048) }
          : {}),
        ...(entry.clientMetadataUrl !== undefined
          ? { clientMetadataUrl: stringField(entry.clientMetadataUrl, 'http.oauth.clientMetadataUrl', 2048) }
          : {}),
      };
    } else {
      oauth = {};
    }
  }

  return {
    url: new URL(url).toString(),
    auth,
    ...(oauth ? { oauth } : {}),
    ...(bearerRef ? { bearerRef } : {}),
    ...(headerRefs ? { headerRefs } : {}),
    allowPrivateNetwork,
    allowInsecure,
  };
}

function parseStdio(value: unknown, options: ConfigParseOptions): McpStdioConfig {
  const record = asRecord(value, 'stdio');
  const command = stringField(record.command, 'stdio.command', 512);
  if (/\s/.test(command)) {
    // A command with a space is how `sh -c "..."` gets smuggled in. The model
    // and a pasted file both reach this field, so it is refused structurally.
    throw invalid('stdio.command must be one executable, not a shell command line');
  }
  const args = stringList(record.args, 'stdio.args', 64);
  const cwd = record.cwd === undefined ? undefined : stringField(record.cwd, 'stdio.cwd', 1024);
  const runLocation = (record.runLocation ?? 'sandbox') as unknown;
  if (runLocation !== 'sandbox' && runLocation !== 'host' && runLocation !== 'browser') {
    throw invalid('stdio.runLocation must be "sandbox", "host" or "browser"');
  }
  if (runLocation === 'host' && !options.allowHostProcess) {
    throw invalid(
      'stdio.runLocation "host" is not allowed by this deployment; use the sandbox or enable MCP_ALLOW_HOST_PROCESS explicitly',
    );
  }
  let envRefs: Record<string, string> | undefined;
  if (record.envRefs !== undefined) {
    const refs = asRecord(record.envRefs, 'stdio.envRefs');
    envRefs = {};
    for (const [name, reference] of Object.entries(refs)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
        throw invalid(`stdio.envRefs.${name} is not a valid environment variable name`);
      }
      envRefs[name] = parseReference(reference, `stdio.envRefs.${name}`);
    }
  }
  const image = record.image === undefined ? undefined : stringField(record.image, 'stdio.image', 256);
  if (runLocation === 'browser' && (command !== 'eunoia-browser' || args.length !== 0 || cwd || image || Object.keys(envRefs ?? {}).length > 0)) {
    throw invalid('managed browser requires command eunoia-browser, empty args, no cwd/image/envRefs; deployment owns its image, flags and network');
  }
  if (runLocation === 'sandbox' && image !== undefined && !/^[^\s]+@sha256:[0-9a-f]{64}$/.test(image)) {
    throw invalid('stdio.image must be pinned by digest (name@sha256:<64 hex>)');
  }
  return {
    command,
    args,
    ...(cwd ? { cwd } : {}),
    ...(envRefs ? { envRefs } : {}),
    runLocation,
    ...(image ? { image } : {}),
  };
}

function parseTimeouts(value: unknown, ceiling: McpTimeouts): McpTimeouts {
  if (value === undefined || value === null) return { ...DEFAULT_MCP_TIMEOUTS };
  const record = asRecord(value, 'timeouts');
  return {
    connectMs: boundedInt(record.connectMs, 'timeouts.connectMs', DEFAULT_MCP_TIMEOUTS.connectMs, 1_000, ceiling.connectMs),
    callMs: boundedInt(record.callMs, 'timeouts.callMs', DEFAULT_MCP_TIMEOUTS.callMs, 1_000, ceiling.callMs),
    closeMs: boundedInt(record.closeMs, 'timeouts.closeMs', DEFAULT_MCP_TIMEOUTS.closeMs, 100, ceiling.closeMs),
  };
}

function parseLimits(value: unknown, ceiling: McpLimits): McpLimits {
  if (value === undefined || value === null) return { ...DEFAULT_MCP_LIMITS };
  const record = asRecord(value, 'limits');
  return {
    maxTools: boundedInt(record.maxTools, 'limits.maxTools', DEFAULT_MCP_LIMITS.maxTools, 1, ceiling.maxTools),
    maxSchemaBytes: boundedInt(record.maxSchemaBytes, 'limits.maxSchemaBytes', DEFAULT_MCP_LIMITS.maxSchemaBytes, 1_024, ceiling.maxSchemaBytes),
    maxCatalogBytes: boundedInt(record.maxCatalogBytes, 'limits.maxCatalogBytes', DEFAULT_MCP_LIMITS.maxCatalogBytes, 4_096, ceiling.maxCatalogBytes),
    maxResultBytes: boundedInt(record.maxResultBytes, 'limits.maxResultBytes', DEFAULT_MCP_LIMITS.maxResultBytes, 1_024, ceiling.maxResultBytes),
    maxTextChars: boundedInt(record.maxTextChars, 'limits.maxTextChars', DEFAULT_MCP_LIMITS.maxTextChars, 256, ceiling.maxTextChars),
  };
}

function parseToolPolicy(value: unknown): McpToolPolicy {
  if (value === undefined || value === null) return {};
  const record = asRecord(value, 'toolPolicy');
  const allow = record.allow === undefined ? undefined : stringList(record.allow, 'toolPolicy.allow');
  const deny = record.deny === undefined ? undefined : stringList(record.deny, 'toolPolicy.deny');
  const tools: Record<string, McpToolPolicyEntry> = {};
  if (record.tools !== undefined) {
    const entries = asRecord(record.tools, 'toolPolicy.tools');
    if (Object.keys(entries).length > 500) throw invalid('toolPolicy.tools has too many entries');
    for (const [name, raw] of Object.entries(entries)) {
      const entry = asRecord(raw, `toolPolicy.tools.${name}`);
      const parsed: { enabled?: boolean; classification?: McpToolClassification; autoApprove?: boolean } = {};
      if (entry.enabled !== undefined) parsed.enabled = booleanField(entry.enabled, `toolPolicy.tools.${name}.enabled`, true);
      if (entry.classification !== undefined) {
        if (
          entry.classification !== 'external_read' &&
          entry.classification !== 'external_write' &&
          entry.classification !== 'external_unknown'
        ) {
          throw invalid(`toolPolicy.tools.${name}.classification is not a known class`);
        }
        parsed.classification = entry.classification as McpToolClassification;
      }
      if (entry.autoApprove !== undefined) parsed.autoApprove = booleanField(entry.autoApprove, `toolPolicy.tools.${name}.autoApprove`, false);
      tools[name] = parsed;
    }
  }
  return {
    ...(allow && allow.length > 0 ? { allow } : {}),
    ...(deny && deny.length > 0 ? { deny } : {}),
    ...(Object.keys(tools).length > 0 ? { tools } : {}),
    ...(record.trustReadOnlyHint !== undefined
      ? { trustReadOnlyHint: booleanField(record.trustReadOnlyHint, 'toolPolicy.trustReadOnlyHint', false) }
      : {}),
    ...(record.autoApproveReads !== undefined
      ? { autoApproveReads: booleanField(record.autoApproveReads, 'toolPolicy.autoApproveReads', false) }
      : {}),
  };
}

/**
 * Validate one server input.
 *
 * `configRevision` is carried by the caller: an update compares expected and
 * current revision before calling this, and a create starts at 1.
 */
export function parseServerInput(
  input: ServerInput,
  options: ConfigParseOptions,
): ParsedServer {
  const now = options.now ?? (() => new Date());
  const notes: string[] = [];
  const name = stringField(input.name, 'name', 64);
  const transportRaw = input.transport;
  if (transportRaw !== 'stdio' && transportRaw !== 'http') {
    throw invalid('transport must be "stdio" or "http"');
  }
  const transport: McpTransportKind = transportRaw;
  const http = transport === 'http' ? parseHttp(input.http, options) : undefined;
  const stdio = transport === 'stdio' ? parseStdio(input.stdio, options) : undefined;
  if (transport === 'http' && input.http === undefined) throw invalid('http configuration is required');
  if (transport === 'stdio' && input.stdio === undefined) throw invalid('stdio configuration is required');
  if (http?.auth === 'oauth') {
    notes.push('OAuth 需要先完成登录，服务在授权前不会显示为可用');
  }
  const timestamp = now().toISOString();
  return {
    config: {
      id: input.id ?? (options.newId ?? randomUUID)(),
      userId: options.userId,
      name,
      // Default off: a newly added server is a draft the person reviews.
      enabled: booleanField(input.enabled, 'enabled', false),
      required: booleanField(input.required, 'required', false),
      transport,
      ...(http ? { http } : {}),
      ...(stdio ? { stdio } : {}),
      timeouts: parseTimeouts(input.timeouts, options.maxTimeouts ?? DEFAULT_MCP_TIMEOUTS),
      limits: parseLimits(input.limits, options.maxLimits ?? DEFAULT_MCP_LIMITS),
      toolPolicy: parseToolPolicy(input.toolPolicy),
      configRevision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    notes,
  };
}

export const DEFAULT_CONFIG_PARSE_OPTIONS: Omit<ConfigParseOptions, 'userId'> = {
  allowHostProcess: false,
  allowPrivateNetwork: false,
  allowInsecureLoopback: true,
  maxLimits: DEFAULT_MCP_LIMITS,
  maxTimeouts: DEFAULT_MCP_TIMEOUTS,
};

export function configParseOptionsFromEnv(
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): ConfigParseOptions {
  const flag = (value: string | undefined): boolean => {
    const normalized = value?.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  };
  return {
    ...DEFAULT_CONFIG_PARSE_OPTIONS,
    userId,
    allowHostProcess: flag(env.MCP_ALLOW_HOST_PROCESS),
    allowPrivateNetwork: flag(env.MCP_ALLOW_PRIVATE_NETWORK),
    allowInsecureLoopback: env.MCP_ALLOW_INSECURE !== '0',
  };
}

// ----------------------------------------------------------------- import ---

export interface ImportedServerPreview {
  readonly name: string;
  readonly transport: McpTransportKind;
  readonly endpoint: string | null;
  readonly runLocation: 'host' | 'sandbox' | 'browser' | null;
  readonly envNames: readonly string[];
  readonly headerNames: readonly string[];
  readonly warnings: readonly string[];
  /** Validated configuration, safe to show (references, never values). */
  readonly input: ServerInput;
}

export interface ImportPreview {
  readonly servers: readonly ImportedServerPreview[];
  readonly skipped: readonly { readonly name: string; readonly reason: string }[];
}

/**
 * Read a standard `mcpServers` JSON document.
 *
 * Nothing in the document is executed. `${VAR}` interpolation is turned into an
 * `env:` reference rather than resolved, and a value that looks like a literal
 * secret is refused with a warning instead of being imported.
 */
export function previewMcpServersImport(
  raw: unknown,
  options: ConfigParseOptions,
): ImportPreview {
  const root = asRecord(raw, 'document');
  const serversRaw = root.mcpServers ?? root.servers;
  const servers = asRecord(serversRaw, 'mcpServers');
  const previews: ImportedServerPreview[] = [];
  const skipped: { name: string; reason: string }[] = [];

  for (const [name, rawEntry] of Object.entries(servers)) {
    const warnings: string[] = [];
    try {
      const entry = asRecord(rawEntry, `mcpServers.${name}`);
      if (entry.type === 'sse' || entry.type === 'websocket') {
        skipped.push({ name, reason: `transport "${String(entry.type)}" is not supported` });
        continue;
      }
      if (entry.url !== undefined) {
        const headers = entry.headers === undefined ? {} : asRecord(entry.headers, 'headers');
        const headerRefs: Record<string, string> = {};
        const envRefs: Record<string, string> = {};
        for (const [header, value] of Object.entries(headers)) {
          const ref = referenceFromImport(String(value), header, envRefs, warnings);
          headerRefs[header] = ref;
        }
        const bearerHeader = Object.keys(headerRefs).find(
          (header) => header.toLowerCase() === 'authorization',
        );
        const input: ServerInput = {
          name,
          transport: 'http',
          enabled: false,
          http: {
            url: String(entry.url),
            auth: bearerHeader ? 'bearer' : Object.keys(headerRefs).length > 0 ? 'header' : 'none',
            ...(bearerHeader ? { bearerRef: headerRefs[bearerHeader] } : {}),
            ...(!bearerHeader && Object.keys(headerRefs).length > 0 ? { headerRefs } : {}),
          },
        };
        parseServerInput(input, options);
        previews.push({
          name,
          transport: 'http',
          endpoint: String(entry.url),
          runLocation: null,
          envNames: Object.values(envRefs).map((ref) => ref.slice('env:'.length)),
          headerNames: Object.keys(headerRefs),
          warnings,
          input,
        });
        continue;
      }
      if (entry.command === undefined) {
        skipped.push({ name, reason: 'entry has neither url nor command' });
        continue;
      }
      const env = entry.env === undefined ? {} : asRecord(entry.env, 'env');
      const envRefs: Record<string, string> = {};
      for (const [key, value] of Object.entries(env)) {
        envRefs[key] = referenceFromImport(String(value), key, envRefs, warnings);
      }
      const runLocation = (entry.runLocation ?? 'sandbox') as 'host' | 'sandbox' | 'browser';
      const input: ServerInput = {
        name,
        transport: 'stdio',
        enabled: false,
        stdio: {
          command: String(entry.command),
          args: Array.isArray(entry.args) ? entry.args.map((arg) => String(arg)) : [],
          ...(entry.cwd ? { cwd: String(entry.cwd) } : {}),
          ...(Object.keys(envRefs).length > 0 ? { envRefs } : {}),
          runLocation,
        },
      };
      parseServerInput(input, options);
      previews.push({
        name,
        transport: 'stdio',
        endpoint: String(entry.command),
        runLocation,
        envNames: Object.keys(envRefs),
        headerNames: [],
        warnings,
        input,
      });
    } catch (error) {
      skipped.push({
        name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { servers: previews, skipped };
}

/**
 * Turn an imported value into a reference.
 *
 * `"${TOKEN}"` and `"env:TOKEN"` are references. A bare literal is not imported
 * as a secret: it becomes a reference name derived from the field, with a
 * warning telling the person to set that variable. That keeps the import from
 * writing a token into the database.
 */
function referenceFromImport(
  value: string,
  field: string,
  envRefs: Record<string, string>,
  warnings: string[],
): string {
  const braced = /^\$\{([A-Z][A-Z0-9_]{0,63})\}$/.exec(value);
  if (braced) {
    const name = braced[1] as string;
    if (!name.startsWith('MCP_') && !name.startsWith('EUNOIA_MCP_')) {
      warnings.push(`${field}: ${name} 不在 MCP_ 命名空间，导入后会要求改名`);
    }
    envRefs[name] = `env:${name}`;
    return `env:${name}`;
  }
  if (value.startsWith('env:')) {
    const name = value.slice('env:'.length);
    envRefs[name] = value;
    return value;
  }
  const derived = `MCP_${field.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'SECRET'}`;
  warnings.push(`${field}: 值不是引用，已改为 env:${derived}；请设置该变量后重新连接`);
  envRefs[derived] = `env:${derived}`;
  return `env:${derived}`;
}

// ------------------------------------------------------------- display ---

/** The endpoint shown in management responses. Never includes a secret. */
export function describeEndpoint(config: McpServerConfig): string | null {
  if (config.transport === 'http') {
    try {
      const url = new URL(config.http?.url ?? '');
      url.username = '';
      url.password = '';
      url.search = '';
      return url.toString();
    } catch {
      return null;
    }
  }
  const stdio = config.stdio;
  if (!stdio) return null;
  return [stdio.command, ...stdio.args].join(' ');
}
