/**
 * The read-only skill endpoint.
 *
 * This is what a UI needs to list skills without loading bodies: names,
 * descriptions, sources and resource paths. The body is intentionally absent —
 * it is loaded per turn by `load_skill`, not shipped to every client.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/api/server.ts';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { SkillRegistry } from '../../src/skills/registry.ts';
import type { Skill } from '../../src/skills/types.ts';

let server: Server | null = null;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve) => {
    server?.close(() => resolve());
    server?.closeAllConnections?.();
  });
  server = null;
});

const skill: Skill = {
  manifest: {
    name: 'docs-sync',
    description: '在代码或配置改动后检查文档是否仍然准确。',
    allowedTools: ['read_file', 'grep'],
    metadata: {},
  },
  root: '/tmp/skills/docs-sync',
  entry: '/tmp/skills/docs-sync/SKILL.md',
  body: 'BODY_SENTINEL',
  source: 'builtin',
  hash: 'abc123',
  references: ['references/checklist.md'],
  scripts: [],
  assets: [],
};

describe('GET /api/skills', () => {
  it('lists metadata without bodies', async () => {
    server = createApp({
      store: new InMemoryStore(),
      skills: new SkillRegistry([skill]),
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/api/skills`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      skills: { name: string; description: string; source: string; references: string[] }[];
      version: string | null;
    };

    expect(body.skills).toHaveLength(1);
    expect(body.skills[0]).toMatchObject({
      name: 'docs-sync',
      source: 'builtin',
      references: ['references/checklist.md'],
    });
    expect(JSON.stringify(body)).not.toContain('BODY_SENTINEL');
    expect(body.version).toMatch(/^[0-9a-f]{12}$/);
  });

  it('reports the skill count on /health', async () => {
    server = createApp({
      store: new InMemoryStore(),
      skills: new SkillRegistry([skill]),
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/health`);
    const body = (await response.json()) as { skills: number; skills_version: string | null };
    expect(body.skills).toBe(1);
    expect(body.skills_version).toMatch(/^[0-9a-f]{12}$/);
  });
});
