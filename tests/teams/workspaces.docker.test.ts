/**
 * T31 — two writable members are isolated in a real container.
 *
 * Gated on `TEAM_INTEGRATION=1` and a pinned image digest, like the sandbox
 * integration suite. The host-side copy tests prove the directories differ; this
 * proves the container mount cannot reach a sibling member's directory or the
 * source root.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandboxPlatform, type SandboxPlatform } from '../../src/sandbox/index.ts';
import { MemorySandboxStore } from '../../src/sandbox/store-memory.ts';
import { RESOURCE_PROFILES, SANDBOX_POLICY_VERSION } from '../../src/sandbox/types.ts';
import type { SandboxSettings } from '../../src/sandbox/config.ts';
import { TeamWorkspaceService } from '../../src/teams/workspaces.ts';
import { testPermissionSettings } from '../sandbox/helpers.ts';

const execFileAsync = promisify(execFile);

const ENABLED = process.env.TEAM_INTEGRATION === '1';
const IMAGE = process.env.SANDBOX_TEST_IMAGE_DIGEST?.trim() ?? '';
const enabled = ENABLED && /^sha256:[a-f0-9]{64}$/.test(IMAGE);

describe.skipIf(!enabled)('T31 — team member workspace isolation in a container', () => {
  let base = '';
  let sourceRoot = '';
  let platform: SandboxPlatform;
  let service: TeamWorkspaceService;
  let first: Awaited<ReturnType<TeamWorkspaceService['provision']>>;
  let second: Awaited<ReturnType<TeamWorkspaceService['provision']>>;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'eunoia-team-docker-'));
    sourceRoot = join(base, 'repo');
    await mkdir(join(sourceRoot, 'src'), { recursive: true });
    await writeFile(join(sourceRoot, 'README.md'), '# source\n');
    await writeFile(join(sourceRoot, 'src', 'shared.ts'), 'export const shared = 1;\n');
    const settings: SandboxSettings = {
      enabled: true,
      imageDigest: IMAGE,
      policyVersion: SANDBOX_POLICY_VERSION,
      runtime: {
        kind: 'docker',
        binary: 'docker',
        globalArgs: [],
        runtimeClass: 'runc',
        requireGvisor: false,
        seccompProfile: null,
        apparmorProfile: null,
        egressNetwork: null,
      },
      workspace: {
        storageRoot: join(base, 'platform-sandboxes'),
        sourceRoot,
        mode: 'copy',
        ignore: [],
        allowSensitive: false,
        maxFileBytes: 2 * 1024 * 1024,
      },
      network: { mode: 'none', allowedDomains: [], allowedPorts: [], proxyUrl: null },
      resources: { ...RESOURCE_PROFILES.small!.limits, executionTimeoutMs: 60_000 },
      limits: {
        maxConcurrentGlobal: 4,
        maxConcurrentPerUser: 4,
        maxConcurrentPerTask: 2,
        maxExecutionTimeoutMs: 60_000,
        maxOutputBytes: 64 * 1024,
      },
      allowWrites: true,
      allowCommands: true,
      deniedTools: [],
      permission: testPermissionSettings({ mode: 'auto' }),
      heartbeatMs: 30_000,
      nonGvisorAcknowledged: true,
    };
    const sandboxStore = new MemorySandboxStore();
    platform = await createSandboxPlatform({ store: sandboxStore, settings });
    await platform.start();
    service = new TeamWorkspaceService({
      store: sandboxStore,
      provider: platform.provider,
      options: {
        sourceRoot,
        storageRoot: join(base, 'team-storage'),
      },
    });
    first = await service.provision({
      teamId: 'team-1',
      runId: 'run-1',
      ownerId: 'user-1',
      memberId: 'member-a',
      name: '甲',
      mode: 'copy',
    });
    second = await service.provision({
      teamId: 'team-1',
      runId: 'run-1',
      ownerId: 'user-1',
      memberId: 'member-b',
      name: '乙',
      mode: 'copy',
    });
  }, 120_000);

  afterAll(async () => {
    platform?.stop();
    if (base) await rm(base, { recursive: true, force: true });
  });

  it('mounts only the member copy and cannot read a sibling or the source', async () => {
    const a = await service.session({
      userId: 'user-1',
      workspaceTaskId: first.workspaceTaskId,
      sessionId: first.workspaceTaskId,
    });
    const b = await service.session({
      userId: 'user-1',
      workspaceTaskId: second.workspaceTaskId,
      sessionId: second.workspaceTaskId,
    });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();

    const wrote = await a!.executor.run({
      command: [
        'sh',
        '-c',
        'printf member-a > /workspace/a.txt && mkdir -p /workspace/node_modules/pkg && printf cache-a > /workspace/node_modules/pkg/cache.txt && cat /workspace/a.txt && cat /workspace/README.md',
      ],
      toolCallId: 'tool-a-1',
    });
    expect(wrote.status).toBe('SUCCEEDED');
    expect(wrote.stdout).toContain('member-a');
    expect(wrote.stdout).toContain('# source');

    const bList = await b!.executor.run({
      command: [
        'sh',
        '-c',
        'ls -a /workspace; test ! -e /workspace/a.txt; test ! -e /workspace/node_modules/pkg/cache.txt',
      ],
      toolCallId: 'tool-b-1',
    });
    expect(bList.status).toBe('SUCCEEDED');
    expect(bList.stdout).not.toContain('a.txt');
    expect(bList.stdout).not.toContain('cache.txt');

    // T33: no shared writable dependency directory and no published port.
    expect(platform.settings.network.mode).toBe('none');
    for (const workspace of [first, second]) {
      const { stdout } = await execFileAsync('docker', [
        'ps',
        '-a',
        '--filter',
        `label=eunoia.task=${workspace.workspaceTaskId}`,
        '--format',
        '{{.Names}}|{{.Ports}}',
      ]);
      for (const line of stdout.trim().split('\n').filter(Boolean)) {
        const ports = line.split('|')[1] ?? '';
        expect(ports.trim()).toBe('');
      }
      const mounts = await execFileAsync('docker', [
        'ps',
        '-a',
        '--filter',
        `label=eunoia.task=${workspace.workspaceTaskId}`,
        '--format',
        '{{.Names}}',
      ]);
      for (const name of mounts.stdout.trim().split('\n').filter(Boolean)) {
        const inspect = await execFileAsync('docker', [
          'inspect',
          '--format',
          '{{json .Mounts}}',
          name,
        ]);
        const parsed = JSON.parse(inspect.stdout) as Array<{ Source?: string }>;
        for (const mount of parsed) {
          expect(mount.Source ?? '').not.toContain('node_modules');
        }
      }
    }

    // A sibling workspace is not mounted anywhere in the container; the host
    // source root is not either.
    const escape = await a!.executor.run({
      command: ['sh', '-c', `cat ${JSON.stringify(second.workspacePath + '/README.md')} 2>&1; cat ${JSON.stringify(sourceRoot + '/README.md')} 2>&1`],
      toolCallId: 'tool-a-2',
    });
    expect(escape.stdout).not.toContain('# source');
    expect(escape.stdout).not.toContain('README.md\n');

    // The member's write stays in its copy.
    expect(await readFile(join(first.workspacePath, 'a.txt'), 'utf8')).toBe('member-a');
    await expect(readFile(join(second.workspacePath, 'a.txt'))).rejects.toThrow();
    expect(await readFile(join(sourceRoot, 'README.md'), 'utf8')).toBe('# source\n');
  }, 120_000);
});
