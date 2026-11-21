import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createApp } from '../../src/api/server.ts';
import { openSqliteStore } from '../../src/db/sqlite-store.ts';
import { ProjectService, type Project } from '../../src/projects/service.ts';
import type { Conversation } from '../../src/session/types.ts';
import { PreviewGateway } from '../../src/previews/gateway.ts';
import { PreviewService } from '../../src/previews/service.ts';
import { MemoryPreviewStore } from '../../src/previews/store.ts';
import { ProcessService } from '../../src/processes/service.ts';
import { SessionService } from '../../src/session/service.ts';
import { MemoryTeamStore } from '../../src/teams/store-memory.ts';
import { TeamWorkspaceService } from '../../src/teams/workspaces.ts';
import { TeamService } from '../../src/teams/service.ts';
import { defaultTeamConfig } from '../../src/teams/types.ts';
import { projectInstructions } from '../../src/projects/instructions.ts';
import { sandboxSettings } from '../../src/sandbox/config.ts';
import { createSandboxPlatform } from '../../src/sandbox/index.ts';
import { FakeRuntime } from '../../src/sandbox/runtime/fake.ts';
import { SqliteSandboxStore } from '../../src/sandbox/store-sqlite.ts';
import { WorkspaceChangeService } from '../../src/sandbox/workspace-change-service.ts';
import { WorkspaceUiService } from '../../src/workspace-ui/service.ts';
import { workspaceUiConfig } from '../../src/workspace-ui/config.ts';

const IMAGE = process.env.SANDBOX_TEST_IMAGE_DIGEST;
const liveDocker = process.env.SANDBOX_INTEGRATION === '1';
const token = 'project-test-token';

it('keeps workbench, concurrent tasks and undo bound to their projects across restart', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'eunoia-projects-')));
  const a = join(base, 'alpha');
  const b = join(base, 'beta');
  const privateRoot = join(base, 'private');
  const database = join(privateRoot, 'state.sqlite');
  for (const [root, label] of [[a, 'alpha'], [b, 'beta']] as const) {
    await mkdir(root);
    await writeFile(join(root, 'same.txt'), label);
    await writeFile(join(root, 'AGENTS.md'), 'instructions for ' + label);
  }
  await mkdir(privateRoot);
  let store = openSqliteStore(database);
  let projects = new ProjectService(store, a, [base], [privateRoot]);
  let server: ReturnType<typeof createApp> | undefined;
  let platform: Awaited<ReturnType<typeof createSandboxPlatform>> | undefined;
  let previewGateway: PreviewGateway | undefined;
  let releaseRoot: (() => void) | undefined;
  let cookie = '';
  const createdTasks: Array<{ taskId: string; userId: string; sandboxId: string }> = [];

  async function stopServer() {
    await previewGateway?.stop();
    previewGateway = undefined;
    if (!server) return;
    const current = server;
    server = undefined;
    await new Promise<void>((resolve) => {
      current.close(() => resolve());
      current.closeAllConnections();
    });
  }

  async function startServer() {
    const settings = sandboxSettings({
      WORKSPACE_ROOT: a,
      SANDBOX_IMAGE_DIGEST: IMAGE ?? 'sha256:' + 'a'.repeat(64),
      SANDBOX_RUNTIME_CLASS: 'runc',
      SANDBOX_ALLOW_NON_GVISOR: '1',
      SANDBOX_WORKSPACE_ROOT: join(privateRoot, 'sandboxes'),
      SANDBOX_PERMISSION_MODE: 'auto',
      WORKSPACE_WRITES: '1',
      WORKSPACE_COMMANDS: '1',
    })!;
    const sandboxStore = new SqliteSandboxStore(store.database);
    const sandbox = await createSandboxPlatform({
      settings,
      store: sandboxStore,
      ...(liveDocker ? {} : { runtime: new FakeRuntime() }),
      projectRootFor: async (user, conversation) => (await projects.forConversation(user, conversation))?.root,
    });
    platform = sandbox;
    const changes = new WorkspaceChangeService({
      store: sandboxStore, workspaces: sandbox.workspaces, changesets: store,
      journalRoot: join(privateRoot, 'journal'),
    });
    sandbox.gateway.setChangeRecorder(changes);
    const ui = await WorkspaceUiService.create({
      configuredRoot: a, git: false, config: workspaceUiConfig({ loopback: true, env: {} }),
    });
    const processes = new ProcessService({ store });
    let previews: PreviewService | undefined;
    if (liveDocker) {
      const gateway = new PreviewGateway({ host: '127.0.0.1', port: 0, baseDomain: 'preview.localhost' });
      previewGateway = gateway;
      const address = await gateway.start();
      previews = new PreviewService({ processes, gateway, store: new MemoryPreviewStore(),
        gatewayPort: address.port, baseDomain: 'preview.localhost' });
    }
    server = createApp({ store, projects, sandbox, workspaceUi: ui, workspaceChanges: changes,
      processes, ...(previews ? { previews } : {}), localToken: token });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return { sandbox, changes };
  }

  async function api(path: string, body?: object, authenticated = true) {
    const { port } = server!.address() as AddressInfo;
    const response = await fetch('http://127.0.0.1:' + port + path, {
      headers: {
        ...(authenticated ? { cookie, 'x-eunoia-token': token } : {}),
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
    if (authenticated && !cookie) cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
    const payload = await response.json() as {
      defaultId: string;
      project: Project;
      conversation: Conversation;
      conversations: Conversation[];
      status: string;
      preview: { userUrl: string };
    };
    return { status: response.status, body: payload };
  }

  try {
    const { sandbox, changes } = await startServer();
    const initial = await api('/api/projects');
    expect(initial.status).toBe(200);
    const alpha = initial.body.defaultId as string;
    const legacy = await store.createConversation(decodeURIComponent(cookie.split('=')[1]!), 'Legacy');
    expect((await api('/api/projects', { path: b }, false)).status).toBe(403);
    expect((await api('/api/projects', { path: privateRoot })).status).toBe(403);
    expect((await api('/api/projects', { path: base })).status).toBe(403);
    const opened = await api('/api/projects', { path: b });
    expect(opened.status).toBe(200);
    const beta = opened.body.project.id as string;
    expect((await api('/api/projects', { path: b })).body.project.id).toBe(beta);
    expect((await api('/api/conversations', { projectId: randomUUID() })).status).toBe(404);
    const ca = (await api('/api/conversations', { projectId: alpha })).body.conversation;
    const cb = (await api('/api/conversations', { projectId: beta })).body.conversation;
    const other = randomUUID();
    await store.ensureUser(other);
    await expect(projects.get(other, beta)).rejects.toMatchObject({ statusCode: 404 });
    expect((await api('/api/conversations?projectId=' + beta)).body.conversations.map((row: { id: string }) => row.id)).toEqual([cb.id]);
    expect((await api('/api/conversations?projectId=' + alpha)).body.conversations.map((row: { id: string }) => row.id)).toEqual(expect.arrayContaining([ca.id, legacy.id]));
    const [viewA, viewB] = await Promise.all([alpha, beta].map((projectId) =>
      api('/api/workspace/file?path=same.txt&projectId=' + projectId)));
    expect(JSON.stringify(viewA)).toContain('alpha');
    expect(JSON.stringify(viewB)).toContain('beta');

    const [sa, sb] = await Promise.all([ca, cb].map((c) =>
      sandbox.provider.forTask({ taskId: c.id, sessionId: c.id, userId: c.userId })));
    expect((await sa!.workspace.readLines('same.txt')).text).toContain('alpha');
    expect((await sb!.workspace.readLines('same.txt')).text).toContain('beta');
    expect(await projectInstructions(sb!)).toContain('instructions for beta');

    if (liveDocker) {
      for (const c of [ca, cb]) createdTasks.push(await sandboxStoreTask(sandbox, c.id, c.userId));
      const results = await Promise.all([sa!, sb!].map((session) =>
        session.executor.run({ command: ['cat', '/workspace/same.txt'], toolCallId: randomUUID() })));
      expect(results.map((result) => result.stdout.trim())).toEqual(['alpha', 'beta']);
      const command = `node -e "require('node:http').createServer((q,r)=>r.end(require('node:fs').readFileSync('same.txt'))).listen(4400,'127.0.0.1')"`;
      const leases = await Promise.all([ca, cb].map((c) =>
        api('/api/previews', { conversationId: c.id, command, port: 4400 })));
      expect(leases.map((lease) => lease.status)).toEqual([201, 201]);
      const pages = await Promise.all(leases.map(({ body }) => previewBody(body.preview.userUrl)));
      expect(pages).toEqual(['alpha', 'beta']);
    }

    const turnId = randomUUID();
    await changes.arm({ userId: cb.userId, conversationId: cb.id, turnId, taskId: cb.id });
    await sb!.workspace.writeText('same.txt', 'changed beta');
    const change = await changes.finish({ userId: cb.userId, turnId });
    expect(await readFile(join(a, 'same.txt'), 'utf8')).toBe('alpha');
    expect(await readFile(join(b, 'same.txt'), 'utf8')).toBe('changed beta');

    await stopServer();
    sandbox.stop();
    await store.close();
    store = openSqliteStore(database);
    projects = new ProjectService(store, b, [base], [privateRoot]);
    const reopened = await startServer();
    expect((await api('/api/projects')).body.defaultId).toBe(alpha);
    const continued = await reopened.sandbox.provider.forTask({ taskId: cb.id, sessionId: cb.id, userId: cb.userId });
    expect((await continued.workspace.readLines('same.txt')).text).toContain('changed beta');
    expect((await api('/api/conversations/' + cb.id + '/changes/' + change!.id + '/undo', {})).body.status).toBe('undone');
    expect(await readFile(join(b, 'same.txt'), 'utf8')).toBe('beta');
    expect(await readFile(join(a, 'same.txt'), 'utf8')).toBe('alpha');

    const sessions = new SessionService(store);
    const teamWorkspace = (root: string) => new TeamWorkspaceService({
      store: new SqliteSandboxStore(store.database),
      options: { sourceRoot: root, storageRoot: join(privateRoot, 'teams') },
    });
    const rootGate = new Promise<void>((resolve) => { releaseRoot = resolve; });
    const team = new TeamService({
      teamStore: new MemoryTeamStore(),
      store, sessions, workspace: teamWorkspace(a),
      projectWorkspaceFor: async (entry) =>
        teamWorkspace((await projects.forConversation(entry.ownerId, entry.rootConversationId))!.root),
      ceiling: defaultTeamConfig('deepseek-flash'),
      toolPolicy: { allowWorkspaceWrites: true, allowCommands: false, maxOutputChars: 60000 },
      resolveModelTurn: async (member) => async function* () {
        if (member.role === 'root') await rootGate;
        yield { type: 'done', output: [{ type: 'message', role: 'assistant', content: 'ok' }] };
      },
    });
    const teamRun = await team.createRun({
      ownerId: cb.userId, conversationId: cb.id, requestId: randomUUID(), message: 'beta publication',
    });
    const member = await team.spawnMember({
      ownerId: cb.userId, runId: teamRun.run.id, parentMemberId: teamRun.rootMember!.id,
      name: 'worker', message: 'check beta',
    });
    const memberPath = await teamWorkspace(b).workspacePathFor(member.member.workspaceId!);
    expect(await readFile(join(memberPath!, 'same.txt'), 'utf8')).toBe('beta');
    await writeFile(join(memberPath!, 'same.txt'), 'published beta');
    const task = await team.createTask({ run: teamRun.run, member: null, userId: cb.userId }, {
      title: 'publish beta', specification: '', acceptance: 'only beta changes', required: true,
    });
    const candidate = await team.createIntegrationCandidate({
      ownerId: cb.userId, runId: teamRun.run.id, taskId: task.id, memberId: member.member.id,
    });
    const published = await team.publishIntegration({
      ownerId: cb.userId, integrationId: candidate.integration.id, memberId: member.member.id,
    });
    expect(published.integration.status).toBe('published');
    expect(await readFile(join(b, 'same.txt'), 'utf8')).toBe('published beta');
    expect(await readFile(join(a, 'same.txt'), 'utf8')).toBe('alpha');

    releaseRoot?.();
    await expect.poll(async () => (await team.getRun(cb.userId, teamRun.run.id)).status).not.toBe('running');
    await rename(b, join(base, 'moved'));
    await symlink(a, b);
    expect((await api('/api/workspace?projectId=' + beta)).status).toBe(409);
  } finally {
    releaseRoot?.();
    await stopServer();
    for (const task of createdTasks) {
      await platform?.gateway.destroy(task, task.sandboxId);
    }
    platform?.stop();
    await store.close();
    await rm(base, { recursive: true, force: true });
  }
}, 90_000);

async function sandboxStoreTask(
  platform: Awaited<ReturnType<typeof createSandboxPlatform>>, taskId: string, userId: string,
) {
  const sandbox = await platform.gateway.ensureSandbox({ taskId, userId });
  return { taskId, userId, sandboxId: sandbox.sandboxId };
}

function previewBody(address: string): Promise<string> {
  const url = new URL(address);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: url.port, path: url.pathname,
      headers: { host: url.host } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (part: string) => { body += part; });
      res.on('end', () => {
        if (res.statusCode === 200) resolve(body);
        else reject(new Error('preview response ' + res.statusCode));
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('preview timeout')));
    req.on('error', reject);
    req.end();
  });
}
