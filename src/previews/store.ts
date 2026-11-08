/**
 * The preview-lease store.
 *
 * One JSON file, written atomically (temp + rename) and serialized through an
 * in-process queue. It is intentionally not a second database: a lease is a
 * small, short-lived record and the only queries are list/get/put/prune.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PreviewLease } from './types.ts';

export interface PreviewLeaseStore {
  list(): Promise<PreviewLease[]>;
  get(id: string): Promise<PreviewLease | null>;
  findByRoute(routeId: string): Promise<PreviewLease | null>;
  put(lease: PreviewLease): Promise<void>;
  remove(id: string): Promise<void>;
  prune(before: Date): Promise<number>;
}

interface FileShape {
  readonly version: 1;
  readonly leases: PreviewLease[];
}

export class FilePreviewStore implements PreviewLeaseStore {
  readonly #file: string;
  #queue: Promise<void> = Promise.resolve();
  #cache: PreviewLease[] | null = null;

  constructor(file: string) {
    this.#file = file;
  }

  async list(): Promise<PreviewLease[]> {
    return [...(await this.#load()).leases];
  }

  async get(id: string): Promise<PreviewLease | null> {
    return (await this.#load()).leases.find((lease) => lease.id === id) ?? null;
  }

  async findByRoute(routeId: string): Promise<PreviewLease | null> {
    return (await this.#load()).leases.find((lease) => lease.routeId === routeId) ?? null;
  }

  async put(lease: PreviewLease): Promise<void> {
    await this.#mutate((leases) => {
      const next = leases.filter((entry) => entry.id !== lease.id);
      next.push(lease);
      return next;
    });
  }

  async remove(id: string): Promise<void> {
    await this.#mutate((leases) => leases.filter((entry) => entry.id !== id));
  }

  async prune(before: Date): Promise<number> {
    let removed = 0;
    await this.#mutate((leases) => {
      const kept = leases.filter((lease) => {
        const removable =
          (lease.status === 'stopped' || lease.status === 'expired' || lease.status === 'failed') &&
          lease.expiresAt < before.toISOString();
        if (removable) removed += 1;
        return !removable;
      });
      return kept;
    });
    return removed;
  }

  async #load(): Promise<FileShape> {
    if (this.#cache) return { version: 1, leases: this.#cache };
    try {
      const raw = await readFile(this.#file, 'utf8');
      const parsed = JSON.parse(raw) as FileShape;
      this.#cache = Array.isArray(parsed.leases) ? parsed.leases : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.#cache = [];
    }
    return { version: 1, leases: this.#cache };
  }

  async #mutate(change: (leases: PreviewLease[]) => PreviewLease[]): Promise<void> {
    const run = this.#queue.then(async () => {
      const current = (await this.#load()).leases;
      const next = change([...current]);
      await mkdir(dirname(this.#file), { recursive: true });
      const temporary = `${this.#file}.${process.pid}.tmp`;
      await writeFile(
        temporary,
        `${JSON.stringify({ version: 1, leases: next }, null, 2)}\n`,
        { mode: 0o600, encoding: 'utf8' },
      );
      await rename(temporary, this.#file);
      this.#cache = next;
    });
    this.#queue = run.catch(() => undefined);
    await run;
  }
}

/** In-memory store for tests and for a deployment with no data directory. */
export class MemoryPreviewStore implements PreviewLeaseStore {
  readonly #leases = new Map<string, PreviewLease>();

  async list(): Promise<PreviewLease[]> {
    return [...this.#leases.values()];
  }

  async get(id: string): Promise<PreviewLease | null> {
    return this.#leases.get(id) ?? null;
  }

  async findByRoute(routeId: string): Promise<PreviewLease | null> {
    return [...this.#leases.values()].find((lease) => lease.routeId === routeId) ?? null;
  }

  async put(lease: PreviewLease): Promise<void> {
    this.#leases.set(lease.id, lease);
  }

  async remove(id: string): Promise<void> {
    this.#leases.delete(id);
  }

  async prune(before: Date): Promise<number> {
    let removed = 0;
    for (const [id, lease] of this.#leases) {
      if (
        (lease.status === 'stopped' || lease.status === 'expired' || lease.status === 'failed') &&
        lease.expiresAt < before.toISOString()
      ) {
        this.#leases.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}
