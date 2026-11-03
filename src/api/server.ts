/**
 * HTTP transport.
 *
 * Built on `node:http` rather than a framework: the surface is a dozen routes
 * and none of them need routing, middleware, or content negotiation. Spec §0
 * warns against pulling in a framework that is not needed, and nothing here has
 * reached the point where one would earn its weight.
 *
 * Every route below is a thin adapter. Chat goes through `runTurn`, which is the
 * same entry point the evaluation runner uses — so what is measured and what is
 * shipped cannot diverge.
 *
 * Read `identity.ts` before deploying this anywhere. The identity here is a
 * handle, not authentication.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { installProvider } from '../agent/model-client.ts';
import { createSummaryGenerator } from '../agent/summarizer.ts';
import type { AgentOptions } from '../agent/infp-agent.ts';
import { PROMPT_VERSION } from '../agent/instructions.ts';
import { log } from '../observability/logging.ts';
import { installTracing } from '../observability/tracing.ts';
import type { ConversationPatch } from '../session/store.ts';
import type { Store } from '../store.ts';
import type { MemoryStatus } from '../memory/types.ts';
import { MEMORY_STATUSES } from '../memory/types.ts';
import { CONVERSATION_TITLE_MAX_CHARS } from '../session/types.ts';
import { sessionConfig, sessionReplayBudget } from '../session/config.ts';
import { SessionService } from '../session/service.ts';
import { MODEL_CATALOG } from '../models/catalog.ts';
import { defaultModelProfile, isKnownModelId, summaryModelProfile } from '../models/registry.ts';
import { providerFor } from '../provider/index.ts';
import { runTurn, type TurnRunner } from '../service/chat.ts';
import { selectStore } from '../db/select.ts';
import { agentMaxSteps, skillsEnabled, workspaceConfig } from '../config.ts';
import { DEFAULT_TOOL_POLICY } from '../tools/types.ts';
import type { ToolPolicy } from '../tools/types.ts';
import type { SandboxPlatform } from '../sandbox/index.ts';
import { createSandboxPlatform } from '../sandbox/index.ts';
import { sandboxSettings } from '../sandbox/config.ts';
import type {
  HumanApprovalRecord,
  PermissionRequestRecord,
} from '../sandbox/permissions/types.ts';
import { discoverSkillRegistry } from '../skills/registry.ts';
import type { SkillRegistry } from '../skills/registry.ts';
import { clearIdentity, readIdentity, resolveIdentity, singleUserId } from './identity.ts';
import {
  PERMISSION_MODE_DEFAULT_KEY,
  isPermissionMode,
  isUuid,
  parseApprovalDecision,
  parsePermissionModeChange,
  permissionModeOptions,
} from './permissions.ts';
import { pipeEventsAsSse } from './sse.ts';
import {
  WorkspaceUiService,
  handleWorkspaceRoute,
  workspaceUiConfig,
} from '../workspace-ui/index.ts';

/**
 * Reject absurd bodies rather than buffering them.
 *
 * Must stay above the worst-case encoding of `MAX_MESSAGE_CHARS`: 8,000 astral
 * characters are 32 KB of UTF-8 before JSON escaping, so a 32 KB body cap would
 * reject a message the message validator explicitly allows and report the wrong
 * reason.
 */
const MAX_BODY_BYTES = 64 * 1024;

/** Reject absurd messages. A companion turn is not a document. */
const MAX_MESSAGE_CHARS = 8_000;

/** Preference key that lets the person switch retrieval off entirely. */
export const MEMORY_ENABLED_KEY = 'memory.enabled';

/**
 * The statuses the memory panel shows.
 *
 * A soft-deleted memory is still a row — `memory_events` and `superseded_by`
 * both point at it, and removing it would strand them — so "deleted" has to be
 * filtered on read rather than prevented on write. Both stores return every
 * status when asked for nothing in particular, which is the right default for a
 * data layer and the wrong one for a screen: without this, deleting a memory
 * would leave it sitting in the panel the person deleted it from.
 */
const VISIBLE_MEMORY_STATUSES: readonly MemoryStatus[] = ['active', 'unconfirmed'];

const WEB_DIR = join(import.meta.dirname, '..', '..', 'web');

type Json = Record<string, unknown>;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function asObject(raw: unknown): Json | null {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Json) : null;
}

/**
 * Only a local socket may touch the permission surface.
 *
 * There is still no authentication (ADR 009), so "can open a TCP connection"
 * must not be the same thing as "may change what the agent is allowed to do".
 * The bind address is loopback by default; this is the second lock, for a
 * deployment that set `HOST=0.0.0.0` anyway.
 */
function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress;
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1'
  );
}

function isJsonContentType(value: string | undefined): boolean {
  return (value ?? '').split(';')[0]?.trim().toLowerCase() === 'application/json';
}

/**
 * Hostnames this process answers to.
 *
 * Loopback names are always accepted. Anything else has to be named by the
 * operator in `EUNOIA_ALLOWED_HOSTS`, or be the address the process was
 * explicitly told to bind.
 *
 * This exists because binding to `127.0.0.1` does not stop DNS rebinding: an
 * attacker's domain can resolve to loopback, and the browser then treats a
 * request to that domain as same-origin. `Origin` and `Host` are both the
 * attacker's name, so a same-origin check passes and the local token is
 * readable from `GET /`. Validating `Host` against a name the operator chose is
 * what makes "reachable from this machine" mean something again.
 */
const LOOPBACK_HOSTNAMES = ['127.0.0.1', 'localhost', '::1', '[::1]'] as const;

function allowedHostnames(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  const names = new Set<string>(LOOPBACK_HOSTNAMES);
  for (const entry of (env.EUNOIA_ALLOWED_HOSTS ?? '').split(',')) {
    const name = entry.trim().toLowerCase();
    if (name.length > 0) names.add(name);
  }
  const bound = bindHost(env).trim().toLowerCase();
  if (bound.length > 0 && bound !== '0.0.0.0' && bound !== '::') names.add(bound);
  return names;
}

/** The hostname a request addressed, or null when the header is absent/invalid. */
function requestHostname(req: IncomingMessage): string | null {
  const raw = req.headers.host;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    // `URL` strips the port and normalises bracketed IPv6 literals.
    return new URL(`http://${raw}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function hostAllowed(req: IncomingMessage, env: NodeJS.ProcessEnv = process.env): boolean {
  const hostname = requestHostname(req);
  return hostname !== null && allowedHostnames(env).has(hostname);
}

/**
 * Constant-time token comparison.
 *
 * The token is not a password and the socket is local, but comparing secrets
 * with `===` is the kind of habit that survives into a deployment where it
 * matters, so it is done properly here.
 */
function tokensMatch(given: string, expected: string): boolean {
  const left = Buffer.from(given);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isSandboxNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'not_found'
  );
}

/**
 * HTTP status for an error raised by the permission layer.
 *
 * The permission classes deliberately do not know about HTTP, so the mapping
 * lives at the transport edge. Anything unrecognised is a 500: a bug in the
 * permission layer must not read as "your request was fine and we said no".
 */
function permissionErrorStatus(error: unknown): number {
  if (typeof error !== 'object' || error === null) return 500;
  const name = (error as { name?: unknown }).name;
  const code = (error as { code?: unknown }).code;
  if (name === 'SandboxNotFoundError' || code === 'not_found') return 404;
  if (code === 'forbidden') return 403;
  if (name === 'PermissionConflictError' || name === 'ApprovalError') return 409;
  if (name === 'PermissionPolicyError' || name === 'GrantError' || code === 'invalid_input') {
    return 400;
  }
  return 500;
}

export interface ChatPayload {
  readonly message: string;
  readonly conversationId: string | null;
}

export function parseChatRequest(raw: unknown): ChatPayload | string {
  const body = asObject(raw);
  if (!body) return 'body must be a JSON object';

  const message = body.message;
  if (typeof message !== 'string') return 'field "message" must be a string';
  const trimmed = message.trim();
  if (trimmed.length === 0) return 'field "message" must not be empty';
  if (trimmed.length > MAX_MESSAGE_CHARS) {
    return `field "message" exceeds ${MAX_MESSAGE_CHARS} characters`;
  }

  const conversationId = body.conversationId;
  if (conversationId !== undefined && conversationId !== null && typeof conversationId !== 'string') {
    return 'field "conversationId" must be a string or null';
  }

  return { message: trimmed, conversationId: (conversationId as string | null) ?? null };
}

export interface CreateConversationPayload {
  readonly title: string | null;
  readonly modelId: string | null;
}

type StringOrNullResult =
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false; readonly error: string };

function normalizeModelId(raw: unknown): StringOrNullResult {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== 'string') {
    return { ok: false, error: 'field "modelId" must be a string or null' };
  }
  const id = raw.trim();
  if (id.length === 0) return { ok: true, value: null };
  if (!isKnownModelId(id)) {
    return { ok: false, error: `unknown model id ${JSON.stringify(id)}` };
  }
  return { ok: true, value: id };
}

type TitleResult =
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false; readonly error: string };

function normalizeTitle(raw: unknown): TitleResult {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') {
    return { ok: false, error: 'field "title" must be a string or null' };
  }
  const title = raw.replace(/\s+/g, ' ').trim();
  if (title.length > CONVERSATION_TITLE_MAX_CHARS) {
    return {
      ok: false,
      error: `field "title" exceeds ${CONVERSATION_TITLE_MAX_CHARS} characters`,
    };
  }
  return { ok: true, value: title.length > 0 ? title : null };
}

/** `POST /api/conversations`: an empty conversation, optionally named or pinned. */
export function parseCreateConversation(raw: unknown): CreateConversationPayload | string {
  const body = asObject(raw);
  if (!body) return 'body must be a JSON object';
  if ('archived' in body) {
    return 'field "archived" is not allowed when creating a conversation';
  }

  const title = 'title' in body ? normalizeTitle(body.title) : ({ ok: true, value: null } as const);
  if (!title.ok) return title.error;
  const model = 'modelId' in body
    ? normalizeModelId(body.modelId)
    : ({ ok: true, value: null } as const);
  if (!model.ok) return model.error;

  return { title: title.value, modelId: model.value };
}

/** `PATCH /api/conversations/:id`: rename, archive, or pin a model. */
export function parseConversationPatch(raw: unknown): ConversationPatch | string {
  const body = asObject(raw);
  if (!body) return 'body must be a JSON object';

  const patch: { title?: string | null; archived?: boolean; modelId?: string | null } = {};
  if ('title' in body) {
    const title = normalizeTitle(body.title);
    if (!title.ok) return title.error;
    patch.title = title.value;
  }
  if ('archived' in body) {
    if (typeof body.archived !== 'boolean') {
      return 'field "archived" must be a boolean';
    }
    patch.archived = body.archived;
  }
  if ('modelId' in body) {
    const model = normalizeModelId(body.modelId);
    if (!model.ok) return model.error;
    patch.modelId = model.value;
  }
  if (
    patch.title === undefined &&
    patch.archived === undefined &&
    patch.modelId === undefined
  ) {
    return 'at least one of "title", "archived" or "modelId" is required';
  }
  return patch;
}

export interface AppDependencies {
  readonly store: Store;
  /**
   * The session service, including its summary generator in production.
   *
   * Tests may omit it: a service without a summarizer simply never compacts,
   * which is the right default for a test that is not about compaction.
   */
  readonly sessions?: SessionService;
  /**
   * Which store the process actually selected.
   *
   * Reported by `/health` because the in-memory fallback is silent on the page
   * and looks exactly like "my history disappeared": the server keeps working,
   * but every restart starts from nothing. Tests inject a store directly and
   * leave this unset, which reports as `unknown` rather than claiming
   * persistence the test never asked for.
   */
  readonly storeKind?: 'sqlite' | 'memory';
  /** Explicit provider for the companion run; supplied by the composition root. */
  readonly modelProvider?: AgentOptions['modelProvider'];
  /**
   * The sandbox platform, when one is configured.
   *
   * Supplied by the composition root, never by a request. Null means no file or
   * command tools at all; the memory tools still work.
   */
  readonly sandbox?: SandboxPlatform | null;
  /** Write/command permissions; fail-closed defaults when omitted. */
  readonly toolPolicy?: ToolPolicy;
  /** Per-turn model/tool step cap. */
  readonly maxSteps?: number;
  /**
   * The person-facing workbench, when it is enabled.
   *
   * This is a view over a directory: file tree, preview, git status, terminal.
   * It is separate from `sandbox`, which is the agent's execution boundary.
   */
  readonly workspaceUi?: WorkspaceUiService | null;
  /**
   * Discovered skills. Null when no workspace is configured or discovery is
   * disabled; the `/api/skills` response then reports an empty list rather than
   * pretending skills exist.
   */
  readonly skills?: SkillRegistry | null;
  /**
   * Injected so the routes can be tested over real HTTP without a model call.
   * Production leaves it unset and `runTurn` uses the real runner.
   */
  readonly runner?: TurnRunner;
  /**
   * Token the browser must echo on permission mutations.
   *
   * Generated per process and injected into the served HTML, so a page on
   * another origin cannot read it (same-origin policy) and a DNS-rebinding
   * attacker who reaches loopback still cannot guess it. Tests pass a known
   * value instead of scraping the page.
   */
  readonly localToken?: string;
}

export function createApp(deps: AppDependencies) {
  const store = deps.store;
  const sessions = deps.sessions ?? new SessionService(store);
  const localToken = deps.localToken ?? randomUUID();

  /**
   * Resolve the caller, and make sure their row exists.
   *
   * Every per-user table has a foreign key to `users`, and the in-memory store
   * enforces none of them — so a route that wrote before the user row existed
   * worked perfectly in every test and failed in the only environment that
   * mattered. `/api/chat` created a conversation before its user, and
   * `/api/preferences` inserted a preference before its user; both were a 500
   * against Postgres, both passed offline.
   *
   * Doing it here rather than in each route means no route has to remember, and
   * a new route is safe by default instead of safe by review.
   */
  async function identify(req: IncomingMessage, res: ServerResponse): Promise<string> {
    const { userId } = resolveIdentity(req, res);
    await store.ensureUser(userId);
    return userId;
  }

  /** Retrieval can be switched off by the person; it is their history. */
  async function retrievalEnabled(userId: string): Promise<boolean> {
    const value = await store.getPreference(userId, MEMORY_ENABLED_KEY).catch(() => null);
    return value !== false;
  }

  /**
   * The read side of the permission surface.
   *
   * Loopback only, but no token: this is a policy summary, not an action, and
   * the page needs it on first paint. A page that can reach loopback can already
   * read `/health`, which is the same class of information.
   */
  function guardPermissionRead(req: IncomingMessage, res: ServerResponse): boolean {
    if (isLoopbackRequest(req)) return true;
    sendJson(res, 403, { error: 'permission routes are loopback-only' });
    return false;
  }

  /**
   * The write side.
   *
   * Three independent conditions, each answering a different attacker:
   *
   *   - loopback: there is no login, so reachability must not equal authority;
   *   - a JSON content type: an HTML form on another site cannot send it, and a
   *     cross-origin `fetch` with it needs a preflight that fails;
   *   - the per-process token: the page is served here and receives the token in
   *     a meta tag, which another origin cannot read. That is also what stops
   *     DNS rebinding, where the request looks same-origin to the browser.
   */
  function guardPermissionWrite(req: IncomingMessage, res: ServerResponse): boolean {
    if (!guardPermissionRead(req, res)) return false;
    if (!isJsonContentType(req.headers['content-type'])) {
      sendJson(res, 415, { error: 'content-type must be application/json' });
      return false;
    }
    const given = req.headers['x-eunoia-token'];
    if (typeof given !== 'string' || !tokensMatch(given, localToken)) {
      sendJson(res, 403, { error: 'missing or invalid local token' });
      return false;
    }
    return true;
  }

  async function readBodyOrReject(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false }> {
    try {
      return { ok: true, value: await readJsonBody(req) };
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad request' });
      return { ok: false };
    }
  }

  /**
   * The whole permission surface for one conversation.
   *
   * `permissionStatus` needs a task row, and a brand-new conversation has none
   * until its first tool call. That is not an error: a task policy can exist
   * before the task does, so the fallback resolves the same policy without
   * asking for the row.
   */
  async function permissionState(
    sandbox: SandboxPlatform,
    conversationId: string | null,
    userId: string,
  ): Promise<Record<string, unknown>> {
    const settings = sandbox.settings.permission;
    const remembered = await store
      .getPreference(userId, PERMISSION_MODE_DEFAULT_KEY)
      .catch(() => null);
    const shared = {
      enabled: true,
      allowed_modes: settings.allowedModes,
      modes: permissionModeOptions(settings.allowedModes),
      operator: settings.operatorId,
      default_mode: isPermissionMode(remembered) ? remembered : null,
      deployment: {
        mode: settings.mode,
        auto_review: settings.autoReview,
        approval: settings.approval,
        restricted: settings.restricted,
      },
      sandbox: {
        writes: sandbox.settings.allowWrites,
        commands: sandbox.settings.allowCommands,
        network: sandbox.settings.network.mode,
      },
    };

    if (conversationId === null) {
      return {
        ...shared,
        mode: settings.mode,
        permission_policy_version: null,
        scopes: [],
        pending: [],
        requests: [],
        approvals: [],
        grants: [],
      };
    }

    let status: Record<string, unknown>;
    try {
      status = await sandbox.gateway.permissionStatus({
        taskId: conversationId,
        sessionId: conversationId,
        userId,
      });
    } catch (error) {
      if (!isSandboxNotFound(error)) throw error;
      const effective = await sandbox.gateway.effectivePermissionPolicy(
        conversationId,
        conversationId,
      );
      status = {
        mode: effective.mode,
        permission_policy_version: effective.version,
        scopes: effective.scopes,
        auto_review: effective.autoReview,
        approval: effective.approval,
        restricted: effective.restricted,
        requests: [],
        approvals: [],
        grants: [],
      };
    }

    const requests = (status.requests ?? []) as readonly PermissionRequestRecord[];
    const approvals = (status.approvals ?? []) as readonly HumanApprovalRecord[];
    // The queue entry and the request that produced it are separate rows; a card
    // needs both (id to act on, action/resource/reason to decide with).
    const pending = approvals
      .filter((approval) => approval.status === 'PENDING')
      .map((approval) => {
        const request =
          requests.find(
            (entry) =>
              entry.approvalRequestId === approval.approvalRequestId ||
              entry.requestId === approval.requestId,
          ) ?? null;
        return {
          approvalRequestId: approval.approvalRequestId,
          requestId: approval.requestId,
          tool: request?.toolName ?? null,
          action: request?.action ?? null,
          resource: request?.resourceIdentifier ?? null,
          risk_level: request?.riskLevel ?? null,
          reason: request?.reason ?? '',
          expires_at: approval.expiresAt,
          requested_at: request?.createdAt ?? approval.createdAt,
        };
      });

    return { ...shared, ...status, pending };
  }

  /**
   * Give a brand-new conversation the mode the person asked to remember.
   *
   * This writes a task-scoped policy rather than touching deployment settings,
   * so it goes through the same resolver, audit trail and container rebuild as a
   * manual switch, and a deployment that later drops a mode simply ignores it.
   * Failure is logged, never fatal: a conversation that opens in the deployment
   * default is a smaller problem than one that refuses to open.
   */
  async function applyDefaultPermissionMode(
    userId: string,
    conversationId: string,
  ): Promise<void> {
    const sandbox = deps.sandbox;
    if (!sandbox) return;
    const stored = await store
      .getPreference(userId, PERMISSION_MODE_DEFAULT_KEY)
      .catch(() => null);
    if (!isPermissionMode(stored)) return;
    if (!sandbox.settings.permission.allowedModes.includes(stored)) return;
    if (stored === sandbox.settings.permission.mode) return;
    try {
      await sandbox.gateway.setPermissionPolicy({
        scopeType: 'task',
        scopeId: conversationId,
        mode: stored,
        actor: sandbox.settings.permission.operatorId,
      });
    } catch (error) {
      log.warn('permission.default_mode_failed', {
        conversation_id: conversationId,
        mode: stored,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw: unknown;
    try {
      raw = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad request' });
      return;
    }

    const parsed = parseChatRequest(raw);
    if (typeof parsed === 'string') {
      sendJson(res, 400, { error: parsed });
      return;
    }

    const userId = await identify(req, res);
    const controller = new AbortController();
    res.on('close', () => controller.abort());

    log.info('chat.request', {
      message_fingerprint: `len=${parsed.message.length}`,
      conversation_id: parsed.conversationId,
    });

    const retrieve = await retrievalEnabled(userId);

    // A chat can start a conversation implicitly. When it does, create it here
    // instead of letting `runTurn` do it, because the remembered mode has to be
    // written before the first tool call — afterwards is too late to matter for
    // the turn that needed it. `runTurn` still names the conversation from the
    // message; `nameConversation` only fills a null title.
    let conversationId = parsed.conversationId;
    if (conversationId === null) {
      const conversation = await sessions.create(userId);
      conversationId = conversation.id;
      await applyDefaultPermissionMode(userId, conversationId);
    }

    await pipeEventsAsSse(
      runTurn(
        {
          store,
          session: sessions,
          modelProvider: deps.modelProvider,
          runner: deps.runner,
          ...(deps.sandbox ? { sandbox: deps.sandbox.provider } : {}),
          ...(deps.toolPolicy ? { toolPolicy: deps.toolPolicy } : {}),
          ...(deps.maxSteps ? { maxSteps: deps.maxSteps } : {}),
          ...(deps.skills ? { skills: deps.skills } : {}),
        },
        {
          userId,
          conversationId,
          message: parsed.message,
          signal: controller.signal,
          // Retrieval happens inside `runTurn`; turning it off here means the
          // promise is not made rather than made and ignored.
          ...(retrieve ? {} : { retrieve: false }),
        },
      ),
      res,
      { onClose: () => controller.abort() },
    );
  }

  async function handleRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    if (
      deps.workspaceUi &&
      (await handleWorkspaceRoute(req, res, url, deps.workspaceUi, { token: localToken }))
    ) {
      return true;
    }

    // Each group owns a disjoint set of paths, so first-match-wins is a
    // property of the list, not of the order inside one 480-line function.
    for (const group of [
      handleStatusRoutes,
      handlePermissionRoutes,
      handleConversationRoutes,
      handleMemoryRoutes,
      handlePreferenceRoutes,
    ]) {
      if (await group(req, res, url)) return true;
    }

    return false;
  }

  async function handleStatusRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const { pathname } = url;

    if (req.method === 'GET' && pathname === '/health') {
      const ok = await store.ping();
      sendJson(res, ok ? 200 : 503, {
        status: ok ? 'ok' : 'degraded',
        prompt_version: PROMPT_VERSION,
        store: deps.storeKind ?? 'unknown',
        persistent: deps.storeKind === 'sqlite',
        single_user: singleUserId() !== null,
        workspace: deps.sandbox?.settings.workspace.sourceRoot ?? null,
        workspace_mode: deps.sandbox?.settings.workspace.mode ?? null,
        workspace_writes: deps.toolPolicy?.allowWorkspaceWrites ?? false,
        workspace_commands: deps.toolPolicy?.allowCommands ?? false,
        sandbox: deps.sandbox?.health() ?? null,
        max_steps: deps.maxSteps ?? agentMaxSteps(),
        skills: deps.skills?.count() ?? 0,
        skills_version: deps.skills?.version() || null,
      });
      return true;
    }

    if (req.method === 'GET' && pathname === '/app.js') {
      await serveWebAsset(res, 'app.js', 'text/javascript; charset=utf-8');
      return true;
    }

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      await serveIndex(res, localToken);
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/chat') {
      await handleChat(req, res);
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/skills') {
      const skills = deps.skills;
      sendJson(res, 200, {
        version: skills?.version() || null,
        skills:
          skills?.list().map((skill) => ({
            name: skill.manifest.name,
            description: skill.manifest.description,
            source: skill.source,
            version: skill.manifest.version ?? null,
            allowedTools: skill.manifest.allowedTools,
            references: skill.references,
            scripts: skill.scripts,
            assets: skill.assets,
            hash: skill.hash,
          })) ?? [],
        diagnostics: skills?.diagnostics() ?? [],
      });
      return true;
    }

    // ------------------------------------------------------------- me -----

    if (req.method === 'DELETE' && pathname === '/api/me') {
      // Deliberately not `identify`: that mints an identity when it finds none,
      // and creating a person in order to delete them would also hand back a
      // cookie for a row that no longer exists.
      const userId = readIdentity(req);
      const deleted = userId === null ? false : await store.deleteUser(userId);
      clearIdentity(res);
      // `deleted: false` is a 200, not a 404. The caller asked for a state, and
      // somebody with no row here is already in it — the only interesting
      // outcome is the one where a cookie was pointing at real data.
      sendJson(res, 200, { deleted });
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/models') {
      sendJson(res, 200, {
        models: Object.values(MODEL_CATALOG).map((profile) => ({
          id: profile.id,
          providerId: profile.providerId,
          contextWindowTokens: profile.contextWindowTokens,
          defaultInputBudgetTokens: profile.defaultInputBudgetTokens,
        })),
      });
      return true;
    }

    return false;
  }

  async function handlePermissionRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const { pathname } = url;

    // ------------------------------------------------------- permissions -----

    if (req.method === 'GET' && pathname === '/api/permissions') {
      if (!guardPermissionRead(req, res)) return true;
      const userId = await identify(req, res);
      const sandbox = deps.sandbox;
      if (!sandbox) {
        // No sandbox means no file or command tools, so there is no permission
        // surface to show. The client hides the control instead of drawing a
        // switch that changes nothing.
        sendJson(res, 200, { enabled: false });
        return true;
      }

      const requested = url.searchParams.get('conversationId');
      let conversationId: string | null = null;
      if (requested !== null) {
        if (!isUuid(requested)) {
          sendJson(res, 400, { error: 'conversationId must be a uuid' });
          return true;
        }
        if (!(await sessions.get(userId, requested))) {
          sendJson(res, 404, { error: 'conversation not found' });
          return true;
        }
        conversationId = requested;
      }

      try {
        sendJson(res, 200, await permissionState(sandbox, conversationId, userId));
      } catch (error) {
        log.warn('permission.state_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        sendJson(res, 500, { error: 'permission state unavailable' });
      }
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/permissions/mode') {
      if (!guardPermissionWrite(req, res)) return true;
      const userId = await identify(req, res);
      const body = await readBodyOrReject(req, res);
      if (!body.ok) return true;

      const sandbox = deps.sandbox;
      if (!sandbox) {
        sendJson(res, 404, { error: 'the sandbox is not enabled' });
        return true;
      }

      const change = parsePermissionModeChange(body.value);
      if (typeof change === 'string') {
        sendJson(res, 400, { error: change });
        return true;
      }
      if (!(await sessions.get(userId, change.conversationId))) {
        sendJson(res, 404, { error: 'conversation not found' });
        return true;
      }
      const allowed = sandbox.settings.permission.allowedModes;
      if (!allowed.includes(change.mode)) {
        sendJson(res, 403, {
          error: `mode ${change.mode} is not allowed by the deployment (${allowed.join(', ')})`,
        });
        return true;
      }

      try {
        const policy = await sandbox.gateway.setPermissionPolicy({
          scopeType: 'task',
          scopeId: change.conversationId,
          mode: change.mode,
          ...(change.ttlMs === null ? {} : { ttlMs: change.ttlMs }),
          actor: sandbox.settings.permission.operatorId,
        });
        if (change.remember) {
          await store
            .setPreference(userId, PERMISSION_MODE_DEFAULT_KEY, change.mode)
            .catch((error: unknown) => {
              log.warn('permission.default_mode_failed', {
                error: error instanceof Error ? error.message : String(error),
              });
            });
        }
        log.info('permission.mode.changed_from_ui', {
          conversation_id: change.conversationId,
          mode: policy.mode,
          ttl_ms: change.ttlMs,
          remember: change.remember,
        });
        sendJson(res, 200, {
          ok: true,
          mode: policy.mode,
          // The numeric scope version, not the composite `ppv1:…` string the
          // read side reports; the client refetches the effective policy after
          // a change, so this is only for the audit trail and tests.
          policy_version: policy.version,
          expires_at: policy.expiresAt,
        });
      } catch (error) {
        sendJson(res, permissionErrorStatus(error), {
          error: error instanceof Error ? error.message : 'permission policy rejected the change',
        });
      }
      return true;
    }

    const approvalMatch = /^\/api\/permissions\/approvals\/([0-9a-f-]{36})\/(approve|deny)$/.exec(
      pathname,
    );
    if (req.method === 'POST' && approvalMatch) {
      if (!guardPermissionWrite(req, res)) return true;
      const userId = await identify(req, res);
      const sandbox = deps.sandbox;
      if (!sandbox) {
        sendJson(res, 404, { error: 'the sandbox is not enabled' });
        return true;
      }
      const body = await readBodyOrReject(req, res);
      if (!body.ok) return true;
      const decision = parseApprovalDecision(body.value);
      if (typeof decision === 'string') {
        sendJson(res, 400, { error: decision });
        return true;
      }

      const approvalRequestId = approvalMatch[1] as string;
      const action = approvalMatch[2] as 'approve' | 'deny';
      const approval = await sandbox.gateway.getPermissionApproval(approvalRequestId);
      // Ownership is checked against the conversation, because the approval id
      // alone is not a capability: knowing an id must not be enough to approve
      // somebody else's request.
      if (!approval || !(await sessions.get(userId, approval.taskId))) {
        sendJson(res, 404, { error: 'approval not found' });
        return true;
      }

      const context = {
        taskId: approval.taskId,
        sessionId: approval.sessionId,
        userId,
      };
      try {
        if (action === 'approve') {
          const result = await sandbox.gateway.approvePermissionRequest(context, {
            approvalRequestId,
            decidedBy: sandbox.settings.permission.operatorId,
            scope: decision.scope,
            ...(decision.ttlSeconds === null ? {} : { ttlSeconds: decision.ttlSeconds }),
            ...(decision.reason === null ? {} : { reason: decision.reason }),
          });
          log.info('permission.approved_from_ui', {
            conversation_id: approval.taskId,
            approval_request_id: approvalRequestId,
            scope: decision.scope,
            grant_id: result.grantId,
          });
          sendJson(res, 200, { ok: true, approval: result.approval, grantId: result.grantId });
        } else {
          const denied = await sandbox.gateway.denyPermissionRequest(context, {
            approvalRequestId,
            decidedBy: sandbox.settings.permission.operatorId,
            ...(decision.reason === null ? {} : { reason: decision.reason }),
          });
          log.info('permission.denied_from_ui', {
            conversation_id: approval.taskId,
            approval_request_id: approvalRequestId,
          });
          sendJson(res, 200, { ok: true, approval: denied, grantId: null });
        }
      } catch (error) {
        sendJson(res, permissionErrorStatus(error), {
          error: error instanceof Error ? error.message : 'the approval could not be decided',
        });
      }
      return true;
    }

    return false;
  }

  async function handleConversationRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const { pathname } = url;

    // ---------------------------------------------------------- history -----

    if (req.method === 'POST' && pathname === '/api/conversations') {
      const userId = await identify(req, res);

      let raw: unknown;
      try {
        raw = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad request' });
        return true;
      }

      const parsed = parseCreateConversation(raw);
      if (typeof parsed === 'string') {
        sendJson(res, 400, { error: parsed });
        return true;
      }

      const conversation = await sessions.create(userId, parsed.title, parsed.modelId);
      await applyDefaultPermissionMode(userId, conversation.id);
      sendJson(res, 201, { conversation });
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/conversations') {
      const userId = await identify(req, res);
      const conversations = await sessions.list(userId, {
        includeArchived: url.searchParams.get('includeArchived') === '1',
      });
      sendJson(res, 200, { conversations });
      return true;
    }

    const messagesMatch = /^\/api\/conversations\/([0-9a-f-]{36})\/messages$/.exec(pathname);
    if (req.method === 'GET' && messagesMatch) {
      const userId = await identify(req, res);
      const id = messagesMatch[1] as string;
      // A missing conversation is a 404, not an empty transcript: "this id does
      // not exist" and "you have not said anything yet" are different answers.
      if (!(await sessions.get(userId, id))) {
        sendJson(res, 404, { error: 'conversation not found' });
        return true;
      }
      const messages = await sessions.messages(userId, id);
      sendJson(res, 200, { messages });
      return true;
    }

    const conversationMatch = /^\/api\/conversations\/([0-9a-f-]{36})$/.exec(pathname);

    if (req.method === 'GET' && conversationMatch) {
      const userId = await identify(req, res);
      const conversation = await sessions.get(userId, conversationMatch[1] as string);
      if (!conversation) {
        sendJson(res, 404, { error: 'conversation not found' });
        return true;
      }
      sendJson(res, 200, { conversation });
      return true;
    }

    if (req.method === 'PATCH' && conversationMatch) {
      const userId = await identify(req, res);

      let raw: unknown;
      try {
        raw = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : 'bad request' });
        return true;
      }

      const parsed = parseConversationPatch(raw);
      if (typeof parsed === 'string') {
        sendJson(res, 400, { error: parsed });
        return true;
      }

      const id = conversationMatch[1] as string;
      const conversation = await sessions.update(userId, id, parsed);
      if (!conversation) {
        sendJson(res, 404, { error: 'conversation not found' });
        return true;
      }
      sendJson(res, 200, { conversation });
      return true;
    }

    if (req.method === 'DELETE' && conversationMatch) {
      const userId = await identify(req, res);
      const id = conversationMatch[1] as string;
      const deleted = await sessions.delete(userId, id);
      if (!deleted) {
        sendJson(res, 404, { error: 'conversation not found' });
        return true;
      }
      sendJson(res, 200, { deleted: id });
      return true;
    }

    return false;
  }

  async function handleMemoryRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const { pathname } = url;

    // ----------------------------------------------------------- memory -----

    if (req.method === 'GET' && pathname === '/api/memory') {
      const userId = await identify(req, res);
      const memories = await store.listMemories(userId, {
        limit: 200,
        statuses: [...VISIBLE_MEMORY_STATUSES],
      });
      const enabled = await retrievalEnabled(userId);
      sendJson(res, 200, { memories, enabled });
      return true;
    }

    const memoryMatch = /^\/api\/memory\/([0-9a-f-]{36})$/.exec(pathname);

    if (req.method === 'PATCH' && memoryMatch) {
      const userId = await identify(req, res);
      const body = asObject(await readJsonBody(req)) ?? {};

      const status = body.status;
      if (status !== undefined && !MEMORY_STATUSES.includes(status as MemoryStatus)) {
        sendJson(res, 400, { error: `status must be one of ${MEMORY_STATUSES.join(', ')}` });
        return true;
      }

      const updated = await store.updateMemory(userId, memoryMatch[1] as string, {
        content: typeof body.content === 'string' ? body.content : undefined,
        importance: typeof body.importance === 'number' ? body.importance : undefined,
        status: status as MemoryStatus | undefined,
      });

      if (!updated) {
        sendJson(res, 404, { error: 'memory not found' });
        return true;
      }

      // Recorded as an actor of `user`, not `agent`: the distinction is the
      // whole reason the column exists, and a person correcting a memory is
      // exactly the event it needs to capture.
      await store.logMemoryEvent({
        memoryId: updated.id,
        userId,
        action: 'updated',
        actor: 'user',
        detail: { fields: Object.keys(body) },
      });

      sendJson(res, 200, { memory: updated });
      return true;
    }

    if (req.method === 'DELETE' && memoryMatch) {
      const userId = await identify(req, res);
      const id = memoryMatch[1] as string;
      const deleted = await store.deleteMemory(userId, id);
      if (!deleted) {
        sendJson(res, 404, { error: 'memory not found' });
        return true;
      }
      await store.logMemoryEvent({ memoryId: id, userId, action: 'deleted', actor: 'user' });
      sendJson(res, 200, { deleted: id });
      return true;
    }

    return false;
  }

  async function handlePreferenceRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const { pathname } = url;

    // ------------------------------------------------------- preferences -----

    if (req.method === 'GET' && pathname === '/api/preferences') {
      const userId = await identify(req, res);
      const preferences = await store.listPreferences(userId);
      sendJson(res, 200, { preferences, memoryEnabled: preferences[MEMORY_ENABLED_KEY] !== false });
      return true;
    }

    if (req.method === 'PUT' && pathname === '/api/preferences') {
      const userId = await identify(req, res);
      const body = asObject(await readJsonBody(req));
      if (!body) {
        sendJson(res, 400, { error: 'body must be a JSON object' });
        return true;
      }
      for (const [key, value] of Object.entries(body)) {
        await store.setPreference(userId, key, value);
      }
      sendJson(res, 200, { ok: true });
      return true;
    }

    // ---------------------------------------------------------- feedback -----

    if (req.method === 'POST' && pathname === '/api/feedback') {
      const userId = await identify(req, res);
      const body = asObject(await readJsonBody(req)) ?? {};

      const messageId = body.messageId;
      const rating = body.rating;
      if (typeof messageId !== 'string' || (rating !== 'good' && rating !== 'bad')) {
        sendJson(res, 400, { error: 'messageId (string) and rating ("good"|"bad") are required' });
        return true;
      }

      await store.saveFeedback({
        messageId,
        userId,
        rating,
        note: typeof body.note === 'string' ? body.note : null,
      });
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/feedback') {
      const userId = await identify(req, res);
      sendJson(res, 200, { feedback: await store.listFeedback(userId) });
      return true;
    }

    return false;
  }

  return createServer((req, res) => {
    // Before parsing a URL or reading a cookie: a request addressed to a name
    // this process does not answer to is not from this application, whatever
    // its Origin header claims. See `allowedHostnames` for the DNS-rebinding
    // reasoning.
    if (!hostAllowed(req)) {
      sendJson(res, 403, { error: 'host not allowed' });
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');

    void (async () => {
      try {
        if (await handleRoutes(req, res, url)) return;
        sendJson(res, 404, { error: 'not found' });
      } catch (error) {
        log.error('http.unhandled', {
          path: url.pathname,
          error: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
        else res.end();
      }
    })();
  });
}

/** A missing file is a 404; a permissions or I/O failure is not. */
function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * Serve the page with the local permission token in a meta tag.
 *
 * The token is generated per process, so it is not a build artefact and cannot
 * be committed; it is read back off `index.html` by the client and echoed on
 * permission mutations. Injecting it here rather than templating the file keeps
 * `web/index.html` a plain static page that still opens from disk for layout
 * work (in that case the permission control simply stays hidden).
 */
async function serveIndex(res: ServerResponse, token: string): Promise<void> {
  try {
    const html = await readFile(join(WEB_DIR, 'index.html'), 'utf8');
    const page = html.replace(
      '</head>',
      `<meta name="eunoia-token" content="${token}">\n</head>`,
    );
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(page),
    });
    res.end(page);
  } catch (error) {
    // A missing client is a 404; an unreadable one (EACCES, EIO) is a server
    // failure, and pretending it is "not found" hides the thing to fix.
    log.error('web.index_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    if (isMissingFile(error)) sendJson(res, 404, { error: 'web client not found' });
    else sendJson(res, 500, { error: 'web client unavailable' });
  }
}

/**
 * Serve one file from `web/` with an explicit name.
 *
 * There is no path parameter, so this is not a static-file server: the caller
 * names a literal, and the only way to reach another file is to add a route.
 * That keeps a `..` in a URL meaningless even before the path guard exists.
 */
async function serveWebAsset(
  res: ServerResponse,
  name: string,
  contentType: string,
): Promise<void> {
  try {
    const body = await readFile(join(WEB_DIR, name));
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'Content-Length': body.byteLength,
    });
    res.end(body);
  } catch (error) {
    log.error('web.asset_failed', {
      asset: name,
      error: error instanceof Error ? error.message : String(error),
    });
    if (isMissingFile(error)) sendJson(res, 404, { error: 'web asset not found' });
    else sendJson(res, 500, { error: 'web asset unavailable' });
  }
}

/** Start the server. Exported so tests can bind an ephemeral port. */
export async function startServer(port = Number(process.env.PORT ?? 8787)) {
  installTracing();

  // Validate before the process starts listening: a typo in SINGLE_USER_ID
  // should refuse to boot, not hand every request a new identity later.
  const single = singleUserId();
  if (single) log.info('server.single_user', { userId: single });

  installProvider();

  const { store, sandboxStore, kind, detail } = await selectStore();
  log.info('server.store', { kind, detail });

  const config = sessionConfig();
  const model = defaultModelProfile();
  const summaryModel = summaryModelProfile();
  const provider = providerFor(model.providerId);
  const modelProvider = provider.createModelProvider();
  const sessions = new SessionService(store, {
    config,
    model,
    summaryModel,
    summarize: createSummaryGenerator(provider, summaryModel.id),
  });
  log.info('server.session', {
    compaction: config.compactionEnabled,
    model: model.id,
    provider: provider.profile.id,
    context_window: model.contextWindowTokens,
    input_budget: sessionReplayBudget(config, model),
    max_input_budget:
      model.contextWindowTokens - model.maxOutputTokens - model.safetyBufferTokens,
    prompt_reserve: config.promptReserveTokens,
    trigger_ratio: config.compactTriggerRatio,
    keep_recent_messages: config.keepRecentMessages,
    keep_recent_tokens: config.keepRecentTokens,
    summary_model: summaryModel.id,
    summary_chunk_tokens: config.summaryMaxInputTokens,
    idle_compact_minutes: config.idleCompactMinutes,
    token_estimator: config.tokenEstimator,
  });

  const workspaceSettings = workspaceConfig();
  const settings = sandboxSettings();
  const sandboxPlatform = settings
    ? await createSandboxPlatform({ store: sandboxStore, settings })
    : null;
  const toolPolicy: ToolPolicy = settings
    ? {
        ...DEFAULT_TOOL_POLICY,
        allowWorkspaceWrites: settings.allowWrites,
        allowCommands: settings.allowCommands,
        maxOutputChars: Math.min(DEFAULT_TOOL_POLICY.maxOutputChars, settings.limits.maxOutputBytes),
      }
    : DEFAULT_TOOL_POLICY;
  const maxSteps = agentMaxSteps();
  if (workspaceSettings) {
    log.info('server.workspace', {
      root: workspaceSettings.root,
      sandbox: Boolean(sandboxPlatform),
      writes: toolPolicy.allowWorkspaceWrites,
      commands: toolPolicy.allowCommands,
      allow_sensitive: workspaceSettings.allowSensitive,
    });
  }

  const workspaceUi = await WorkspaceUiService.create({
    configuredRoot: workspaceSettings?.root ?? null,
    config: workspaceUiConfig({ loopback: isLoopback(bindHost()) }),
  });
  const workspaceUiState = workspaceUi.state();
  log.info('server.workspace_ui', {
    root: workspaceUiState.root,
    source: workspaceUiState.source,
    terminal: workspaceUiState.terminal,
    git: workspaceUiState.git,
  });

  const skills = workspaceSettings && skillsEnabled()
    ? await discoverSkillRegistry([
        { dir: join(workspaceSettings.root, '.eunoia', 'skills'), source: 'project' },
        { dir: join(workspaceSettings.root, '.agents', 'skills'), source: 'agents' },
        {
          dir: fileURLToPath(new URL('../skills/builtin/', import.meta.url)),
          source: 'builtin',
        },
      ])
    : null;
  if (skills) {
    log.info('server.skills', {
      count: skills.count(),
      version: skills.version(),
      names: skills.list().map((skill) => skill.manifest.name),
    });
    for (const diagnostic of skills.diagnostics()) {
      log.warn('server.skill_diagnostic', {
        source: diagnostic.source,
        path: diagnostic.path,
        reason: diagnostic.reason,
      });
    }
  }

  const server = createApp({
    store,
    sessions,
    storeKind: kind,
    modelProvider,
    sandbox: sandboxPlatform,
    toolPolicy,
    maxSteps,
    workspaceUi,
    skills,
  });

  server.on('close', () => {
    sandboxPlatform?.stop();
    void store.close();
  });

  if (config.idleCompactMinutes > 0) {
    if (!single) {
      log.warn('server.idle_compact_disabled', {
        reason: 'SINGLE_USER_ID is not set; there is no user to scan',
      });
    } else {
      const every = Math.max(1, config.compactCheckIntervalSeconds) * 1_000;
      const timer = setInterval(() => {
        void sessions
          .compactIdle(single, config.idleCompactMinutes)
          .catch((error: unknown) =>
            log.warn('session.idle_compact_failed', {
              error: error instanceof Error ? error.message : String(error),
            }),
          );
      }, every);
      timer.unref();
      server.on('close', () => clearInterval(timer));
    }
  }

  const host = bindHost();
  if (!isLoopback(host)) {
    log.warn('server.public_bind', {
      host,
      note: 'no authentication is enabled; anyone who can reach this port is the user',
    });
  }
  server.listen(port, host, () => {
    log.info('server.listening', { host, port });
    // Recovery runs after the listener exists so a slow container rescan cannot
    // delay the health endpoint; the Gateway already fails closed until it
    // finishes.
    if (sandboxPlatform) {
      void sandboxPlatform.start().catch((error: unknown) => {
        log.error('sandbox.start_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  });
  return server;
}

/**
 * Where the HTTP server listens.
 *
 * Loopback by default. The previous version used the runtime's default, which
 * is every interface — the page looked local at `127.0.0.1:8787`, but the
 * socket was reachable from the LAN. With no login, that is the whole account.
 * Remote access has to be an explicit decision (`HOST=0.0.0.0`) and still needs
 * a real auth layer before it is safe.
 */
export function bindHost(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.HOST?.trim();
  return value && value.length > 0 ? value : '127.0.0.1';
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

// Run directly: `node src/api/server.ts`
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  startServer().catch((error: unknown) => {
    log.error('server.start_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  });
}
