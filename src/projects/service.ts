import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Store } from '../store.ts';

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly root: string;
  readonly openedAt: string;
}

interface ProjectRegistry {
  readonly defaultId: string;
  readonly projects: readonly Project[];
}

export const REGISTRY_KEY = 'workspace.projects.v1';

export class ProjectError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

function contains(root: string, path: string): boolean {
  const difference = relative(root, path);
  return !isAbsolute(difference) && difference !== '..' && !difference.startsWith('..' + sep);
}

async function directory(path: string): Promise<string> {
  if (!isAbsolute(path) || /[,\n\0]/.test(path)) {
    throw new ProjectError('请选择可挂载的绝对目录路径。', 400);
  }
  const canonical = await realpath(path).catch(() => null);
  if (!canonical || !(await stat(canonical).catch(() => null))?.isDirectory()) {
    throw new ProjectError('项目目录已不存在或无法访问。', 409);
  }
  if (/[,\n\0]/.test(canonical)) throw new ProjectError('项目目录包含不支持的字符。', 400);
  return canonical;
}

export class ProjectService {
  private writes: Promise<unknown> = Promise.resolve();

  private readonly store: Pick<Store, 'getPreference' | 'setPreference' | 'getConversation'>;
  private readonly defaultRoot: string;
  private readonly allowedRoots: readonly string[];
  private readonly protectedRoots: readonly string[];

  constructor(
    store: Pick<Store, 'getPreference' | 'setPreference' | 'getConversation'>,
    defaultRoot: string,
    allowedRoots: readonly string[],
    protectedRoots: readonly string[] = [],
  ) {
    this.store = store;
    this.defaultRoot = defaultRoot;
    this.allowedRoots = allowedRoots;
    this.protectedRoots = protectedRoots;
  }

  private async read(userId: string): Promise<ProjectRegistry | null> {
    return await this.store.getPreference(userId, REGISTRY_KEY) as ProjectRegistry | null;
  }

  private update<T>(write: () => Promise<T>): Promise<T> {
    const result = this.writes.then(write);
    this.writes = result.catch(() => undefined);
    return result;
  }

  async list(userId: string): Promise<ProjectRegistry> {
    const existing = await this.read(userId);
    if (existing) return existing;
    return this.update(async () => {
      const current = await this.read(userId);
      if (current) return current;
      const root = await directory(resolve(this.defaultRoot));
      const project = this.newProject(root);
      const registry = { defaultId: project.id, projects: [project] };
      await this.store.setPreference(userId, REGISTRY_KEY, registry);
      return registry;
    });
  }

  async open(userId: string, path: string): Promise<Project> {
    await this.list(userId);
    const root = await directory(path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path);
    return this.update(async () => {
      const registry = await this.read(userId);
      if (!registry) throw new ProjectError('项目列表已失效，请重新打开。', 409);
      const existing = registry.projects.find((project) => project.root === root);
      if (!existing) await this.checkNewRoot(root);
      if (!existing && registry.projects.some((project) => contains(project.root, root) || contains(root, project.root))) {
        throw new ProjectError('这个目录与已登记的项目重叠，请选择项目本身或独立目录。', 409);
      }
      const project = existing ? { ...existing, openedAt: new Date().toISOString() } : this.newProject(root);
      await this.store.setPreference(userId, REGISTRY_KEY, {
        ...registry,
        projects: [project, ...registry.projects.filter((entry) => entry.id !== project.id)],
      });
      return project;
    });
  }

  private async checkNewRoot(root: string): Promise<void> {
    const canonical = (path: string) => realpath(path).catch(() => null);
    const allowed = await Promise.all(this.allowedRoots.map(canonical));
    if (!allowed.some((entry) => entry !== null && contains(entry, root))) {
      throw new ProjectError('目录超出允许打开的项目范围。', 403);
    }
    const home = await realpath(homedir());
    const homeDirectory = relative(home, root).split(sep)[0];
    if (root === home || (contains(home, root) && homeDirectory?.startsWith('.'))) {
      throw new ProjectError('请选择项目目录。', 403);
    }
    const protectedRoots = await Promise.all(this.protectedRoots.map(async (entry) =>
      (await canonical(entry)) ?? resolve(entry),
    ));
    if (protectedRoots.some((entry) => contains(entry, root) || contains(root, entry))) {
      throw new ProjectError('这个目录与应用数据目录重叠。', 403);
    }
  }

  async get(userId: string, projectId: string | null): Promise<Project> {
    const registry = await this.list(userId);
    const project = registry.projects.find((entry) => entry.id === (projectId ?? registry.defaultId));
    if (!project) throw new ProjectError('找不到这个项目。', 404);
    if (await directory(project.root) !== project.root) {
      throw new ProjectError('项目路径已指向另一个目录，请重新打开项目。', 409);
    }
    return project;
  }

  async forConversation(userId: string, conversationId: string): Promise<Project | null> {
    const conversation = await this.store.getConversation(userId, conversationId);
    return conversation ? this.get(userId, conversation.projectId ?? null) : null;
  }

  private newProject(root: string): Project {
    return { id: randomUUID(), name: basename(root), root, openedAt: new Date().toISOString() };
  }
}
