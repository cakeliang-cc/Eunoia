/**
 * Test fixtures for the memory layer.
 *
 * `makeMemory` fills in every field so a test only states the ones it is about.
 * The defaults are deliberately *boring* — middling importance, active status, a
 * timestamp slightly in the past — so that a test which passes did so because of
 * the field it actually set.
 */

import { randomUUID } from 'node:crypto';
import type { Memory, MemoryType } from '../../src/memory/types.ts';

export interface MemoryOverrides {
  readonly id?: string;
  readonly userId?: string;
  readonly type?: MemoryType;
  readonly content: string;
  readonly importance?: number;
  readonly confidence?: number;
  readonly source?: Memory['source'];
  readonly status?: Memory['status'];
  readonly tags?: readonly string[];
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
  readonly lastAccessedAt?: Date | null;
  readonly accessCount?: number;
}

const ONE_DAY_MS = 86_400_000;

export function makeMemory(overrides: MemoryOverrides): Memory {
  const createdAt = overrides.createdAt ?? new Date(Date.now() - ONE_DAY_MS);
  return {
    id: overrides.id ?? randomUUID(),
    userId: overrides.userId ?? 'user-1',
    type: overrides.type ?? 'semantic',
    content: overrides.content,
    importance: overrides.importance ?? 0.5,
    confidence: overrides.confidence ?? 0.8,
    source: overrides.source ?? 'user_stated',
    status: overrides.status ?? 'active',
    tags: overrides.tags ?? [],
    supersededBy: null,
    sourceMessageId: null,
    createdAt,
    updatedAt: overrides.updatedAt ?? createdAt,
    lastAccessedAt: overrides.lastAccessedAt ?? null,
    accessCount: overrides.accessCount ?? 0,
  };
}
