/**
 * The HTTP transport boundary.
 *
 * `StreamableHTTPClientTransport` implements the protocol; this module supplies
 * the two things the SDK deliberately leaves to the host:
 *
 *   - **network policy** — which hosts may be reached, and what a redirect may
 *     do to credentials;
 *   - **authentication material** — resolved at connect time from a reference,
 *     never stored in the configuration.
 *
 * Redirect handling is manual because the standard fetch behaviour follows a
 * `Location` to a different origin with the original `Authorization` header
 * still attached. That is how a token reaches a host the person never approved.
 *
 * See docs/adr/033-mcp-host.md §6.2.
 */

import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { OAuthClientProvider } from '@modelcontextprotocol/client';
import { McpError, type McpHttpConfig } from '../types.ts';
import { validateHttpEndpoint } from '../config.ts';
import { resolveSecretReference } from '../credentials.ts';

/** Headers that must never be forwarded to a different origin. */
const CREDENTIAL_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
  'x-auth-token',
]);

export interface PolicyFetchOptions {
  readonly allowPrivateNetwork: boolean;
  readonly allowInsecure: boolean;
  /** Bound on redirect hops. Three is enough for a well-behaved server. */
  readonly maxRedirects?: number;
  readonly baseFetch?: typeof fetch;
}

function sameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.host === b.host;
}

/**
 * A fetch that re-validates every target, including redirect targets.
 *
 * `redirect: 'manual'` is the whole point: the built-in follow would make the
 * policy check on the first URL meaningless.
 */
export function createPolicyFetch(options: PolicyFetchOptions): typeof fetch {
  const baseFetch = options.baseFetch ?? globalThis.fetch.bind(globalThis);
  const maxRedirects = options.maxRedirects ?? 3;

  const follow: typeof fetch = async (input, init) => {
    let current = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    let request = new Request(current, { ...init, redirect: 'manual' });
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      validateHttpEndpoint(current.toString(), {
        allowPrivateNetwork: options.allowPrivateNetwork,
        allowInsecure: options.allowInsecure,
      });
      const response = await baseFetch(request);
      if (response.status < 300 || response.status >= 400) return response;
      const location = response.headers.get('location');
      if (!location) return response;
      const next = new URL(location, current);
      if (!sameOrigin(current, next)) {
        // Strip credentials on a cross-origin hop. A server that redirects to a
        // different host does not get to keep the token.
        const headers = new Headers(request.headers);
        for (const name of [...headers.keys()]) {
          if (CREDENTIAL_HEADERS.has(name.toLowerCase())) headers.delete(name);
        }
        request = new Request(next, {
          method: request.method,
          headers,
          body: request.body,
          redirect: 'manual',
          // A redirected POST keeps its body only for 307/308; fetch itself
          // enforces that when a body is present with a changed method.
          signal: request.signal,
        });
      } else {
        request = new Request(next, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          redirect: 'manual',
          signal: request.signal,
        });
      }
      current = next;
    }
    throw new McpError('MCP_CONNECT_FAILED', 'too many redirects', 502, {
      detail: { maxRedirects },
    });
  };
  return follow;
}

export interface BuiltHttpTransport {
  readonly transport: StreamableHTTPClientTransport;
  /** Resolved header names only; values are redacted from every response. */
  readonly headerNames: readonly string[];
}

/**
 * Build the transport for an HTTP server.
 *
 * `authProvider` is supplied for OAuth; bearer and custom headers come from
 * this process's environment through the references in the configuration.
 */
export function createHttpTransport(
  config: McpHttpConfig,
  options: {
    readonly allowPrivateNetwork: boolean;
    readonly allowInsecure: boolean;
    readonly env?: NodeJS.ProcessEnv;
    readonly authProvider?: OAuthClientProvider;
    readonly fetch?: typeof fetch;
  },
): BuiltHttpTransport {
  const endpoint = validateHttpEndpoint(config.url, {
    allowPrivateNetwork: options.allowPrivateNetwork,
    allowInsecure: options.allowInsecure,
  });
  const env = options.env ?? process.env;
  const headers: Record<string, string> = {
    // Identify the host in a way an operator can find in the server's logs.
    'x-eunoia-client': 'eunoia-mcp-host',
  };
  const headerNames: string[] = [];

  if (config.auth === 'bearer' && config.bearerRef) {
    const value = resolveSecretReference(config.bearerRef, env, `mcp:${endpoint.host}`);
    if (value === null) {
      throw new McpError(
        'MCP_AUTH_REQUIRED',
        'Bearer 凭据引用的环境变量没有值；请在部署环境中设置它后重新连接。',
        409,
        { detail: { reference: config.bearerRef } },
      );
    }
    headers.Authorization = `Bearer ${value}`;
    headerNames.push('Authorization');
  }

  if (config.auth === 'header') {
    for (const [name, reference] of Object.entries(config.headerRefs ?? {})) {
      const value = resolveSecretReference(reference, env, `mcp:${endpoint.host}:${name}`);
      if (value === null) {
        throw new McpError(
          'MCP_AUTH_REQUIRED',
          `请求头 ${name} 引用的环境变量没有值。`,
          409,
          { detail: { header: name, reference } },
        );
      }
      headers[name] = value;
      headerNames.push(name);
    }
  }

  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers },
    fetch: createPolicyFetch({
      allowPrivateNetwork: options.allowPrivateNetwork,
      allowInsecure: options.allowInsecure,
      ...(options.fetch ? { baseFetch: options.fetch } : {}),
    }),
    ...(options.authProvider ? { authProvider: options.authProvider } : {}),
    reconnectionOptions: {
      initialReconnectionDelay: 500,
      maxReconnectionDelay: 5_000,
      reconnectionDelayGrowFactor: 1.6,
      maxRetries: 2,
    },
  });
  return { transport, headerNames };
}

/** Whether a URL is acceptable under the deployment policy. */
export function describeHttpTarget(config: McpHttpConfig): {
  readonly url: string;
  readonly private: boolean;
  readonly insecure: boolean;
} {
  const url = new URL(config.url);
  return {
    url: url.toString(),
    private: ['127.0.0.1', 'localhost', '::1'].includes(url.hostname) || url.hostname.endsWith('.internal'),
    insecure: url.protocol === 'http:',
  };
}
