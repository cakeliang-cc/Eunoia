/**
 * OAuth for an MCP server: discovery, registration, PKCE, refresh and logout.
 *
 * The SDK owns the protocol — metadata discovery, the authorization request,
 * token exchange, refresh and scope step-up. This module supplies what only the
 * host can know:
 *
 *   - where the tokens live (sealed, per owner/server, never in plaintext);
 *   - which callback URL is allowed (loopback only, this deployment's);
 *   - a one-shot `state` bound to the server, so a callback for one service
 *     cannot exchange a code with another;
 *   - a redaction registration for every access token, so a server that echoes
 *     one back cannot get it into a log or a model result.
 *
 * See docs/adr/033-mcp-host.md §9.
 */

import { randomBytes } from 'node:crypto';
import type {
  OAuthClientProvider,
  OAuthClientMetadata,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import { MCP_REDACTOR, resolveSecretReference, type McpCredentialVault } from './credentials.ts';
import { McpError, type McpServerConfig } from './types.ts';

interface SealedPkce {
  readonly state: string;
  readonly verifier: string;
  readonly createdAt: string;
}

interface SealedClient {
  readonly client: StoredOAuthClientInformation;
  readonly issuer: string;
}

const DEFAULT_SCOPES: readonly string[] = [];

/** A callback URL this deployment owns. Overridable for a non-default port. */
export function defaultRedirectUri(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.MCP_OAUTH_REDIRECT_URI?.trim();
  if (explicit) {
    const url = new URL(explicit);
    if (!isLoopbackHost(url.hostname)) {
      throw new McpError(
        'MCP_CONFIG_INVALID',
        'OAuth 回调地址必须是本机回环地址（127.0.0.1/localhost），否则授权码会经过第三方。',
        400,
      );
    }
    return url.toString();
  }
  const port = env.PORT?.trim() || '8787';
  return `http://127.0.0.1:${port}/api/mcp/oauth/callback`;
}

function isLoopbackHost(hostname: string): boolean {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname);
}

export interface OAuthProviderOptions {
  readonly config: McpServerConfig;
  readonly vault: McpCredentialVault;
  readonly identity: string;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Called when the SDK needs a person to visit an authorization page. The
   * transport is supplied so the callback can complete on the flow that started.
   */
  readonly onAuthorizationUrl: (url: string, state: string, transport: unknown) => void;
}

/**
 * A persistent `OAuthClientProvider`.
 *
 * Tokens, client registration and the PKCE verifier are sealed through the same
 * vault as every other secret. When no master key is configured the provider
 * refuses to save rather than writing a plaintext token.
 */
export function createOAuthProvider(options: OAuthProviderOptions): OAuthClientProvider & {
  attachTransport(transport: unknown): void;
  lastAuthorizationUrl(): string | null;
} {
  const { config, vault } = options;
  const env = options.env ?? process.env;
  const redirectUri = config.http?.oauth?.redirectUri ?? defaultRedirectUri(env);
  const authServerKey = `oauth:${options.identity}`;

  let transport: unknown = null;
  let lastUrl: string | null = null;
  let pendingState: string | null = null;
  let verifierCache: string | null = null;

  const clientMetadata: OAuthClientMetadata = {
    client_name: 'Eunoia',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: config.http?.oauth?.clientSecretRef ? 'client_secret_post' : 'none',
    ...(config.http?.oauth?.scopes?.length
      ? { scope: config.http.oauth.scopes.join(' ') }
      : {}),
    ...(config.http?.oauth?.clientMetadataUrl
      ? { client_uri: config.http.oauth.clientMetadataUrl }
      : {}),
  } as OAuthClientMetadata;

  const provider = {
    get redirectUrl(): string {
      return redirectUri;
    },

    get clientMetadataUrl(): string | undefined {
      return config.http?.oauth?.clientMetadataUrl;
    },

    get clientMetadata(): OAuthClientMetadata {
      return clientMetadata;
    },

    state(): string {
      if (pendingState) return pendingState;
      const state = randomBytes(24).toString('base64url');
      pendingState = state;
      return state;
    },

    async clientInformation(): Promise<StoredOAuthClientInformation | undefined> {
      const registered = await vault
        .get<SealedClient>({
          userId: config.userId,
          serverId: config.id,
          kind: authServerKey,
        })
        .catch(() => null);
      if (registered) {
        return registered.value.client;
      }
      const preRegistered = config.http?.oauth?.clientId;
      if (!preRegistered) return undefined;
      const secretRef = config.http?.oauth?.clientSecretRef;
      const secret = secretRef ? resolveSecretReference(secretRef, env, 'mcp-oauth-client') : null;
      if (secretRef && secret === null) {
        throw new McpError(
          'MCP_AUTH_REQUIRED',
          'OAuth 客户端密钥引用的环境变量没有值。',
          409,
        );
      }
      return {
        client_id: preRegistered,
        ...(secret ? { client_secret: secret } : {}),
        ...(config.http?.oauth?.scopes?.length
          ? { scope: config.http.oauth.scopes.join(' ') }
          : {}),
      } as StoredOAuthClientInformation;
    },

    async saveClientInformation(clientInformation: StoredOAuthClientInformation): Promise<void> {
      await vault.put({
        userId: config.userId,
        serverId: config.id,
        kind: authServerKey,
        value: { client: clientInformation, issuer: authServerKey },
      });
    },

    async tokens(): Promise<StoredOAuthTokens | undefined> {
      const stored = await vault
        .get<StoredOAuthTokens>({
          userId: config.userId,
          serverId: config.id,
          kind: 'oauth-tokens',
        })
        .catch((error: unknown) => {
          // A missing key is a state, not a crash: the UI says "log in again".
          if (error instanceof McpError) return null;
          throw error;
        });
      if (!stored) return undefined;
      // Register before returning: the transport will put it on a wire next.
      MCP_REDACTOR.registerToken(stored.value.access_token, 'mcp-oauth-access');
      if (stored.value.refresh_token) {
        MCP_REDACTOR.registerToken(stored.value.refresh_token, 'mcp-oauth-refresh');
      }
      return stored.value;
    },

    async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
      MCP_REDACTOR.registerToken(tokens.access_token, 'mcp-oauth-access');
      if (tokens.refresh_token) MCP_REDACTOR.registerToken(tokens.refresh_token, 'mcp-oauth-refresh');
      const expiresAt =
        typeof tokens.expires_in === 'number'
          ? new Date(Date.now() + tokens.expires_in * 1_000).toISOString()
          : null;
      await vault.put({
        userId: config.userId,
        serverId: config.id,
        kind: 'oauth-tokens',
        value: tokens,
        account: options.identity.split('|').slice(1).join('|') || null,
        scope: tokens.scope ?? null,
        expiresAt,
      });
    },

    redirectToAuthorization(authorizationUrl: URL): void {
      lastUrl = authorizationUrl.toString();
      const state = pendingState ?? randomBytes(24).toString('base64url');
      pendingState = state;
      options.onAuthorizationUrl(lastUrl, state, transport);
    },

    async saveCodeVerifier(codeVerifier: string): Promise<void> {
      verifierCache = codeVerifier;
      if (!pendingState) pendingState = randomBytes(24).toString('base64url');
      await vault.put({
        userId: config.userId,
        serverId: config.id,
        kind: 'oauth-pkce',
        value: {
          state: pendingState,
          verifier: codeVerifier,
          createdAt: new Date().toISOString(),
        } satisfies SealedPkce,
      });
    },

    async codeVerifier(): Promise<string> {
      if (verifierCache) return verifierCache;
      const stored = await vault
        .get<SealedPkce>({
          userId: config.userId,
          serverId: config.id,
          kind: 'oauth-pkce',
        })
        .catch(() => null);
      if (!stored) {
        throw new McpError(
          'MCP_AUTH_REQUIRED',
          'OAuth 流程没有可用的 PKCE 校验值；请重新发起登录。',
          409,
        );
      }
      pendingState = stored.value.state;
      verifierCache = stored.value.verifier;
      return stored.value.verifier;
    },

    /** Custom client authentication, e.g. a pre-registered confidential client. */
    async addClientAuthentication(
      headers: Headers,
      params: URLSearchParams,
      _url: string | URL,
      metadata?: unknown,
    ): Promise<void> {
      void headers;
      void params;
      void metadata;
      const auth = await provider.clientInformation();
      if (auth && 'client_secret' in auth && typeof auth.client_secret === 'string') {
        // `client_secret_post` is already in clientMetadata; the SDK sends the
        // body fields. Nothing else belongs here.
        return;
      }
    },

    attachTransport(next: unknown): void {
      transport = next;
    },

    lastAuthorizationUrl(): string | null {
      return lastUrl;
    },
  };

  return provider as unknown as OAuthClientProvider & {
    attachTransport(transport: unknown): void;
    lastAuthorizationUrl(): string | null;
  };
}

/** The registration path this configuration will take. */
export function registrationPath(
  config: McpServerConfig,
): 'pre_registered' | 'client_metadata_document' | 'dynamic' {
  if (config.http?.oauth?.clientMetadataUrl) return 'client_metadata_document';
  if (config.http?.oauth?.clientId) return 'pre_registered';
  return 'dynamic';
}

/** Scopes requested by this configuration, for the consent diff. */
export function requestedScopes(config: McpServerConfig): readonly string[] {
  return config.http?.oauth?.scopes ?? DEFAULT_SCOPES;
}

/** A redacted description of the client, for a management response. */
export function describeOAuthClient(config: McpServerConfig): {
  readonly registration: string;
  readonly scopes: readonly string[];
  readonly redirectUri: string;
} {
  return {
    registration: registrationPath(config),
    scopes: requestedScopes(config),
    redirectUri: config.http?.oauth?.redirectUri ?? defaultRedirectUri(),
  };
}
