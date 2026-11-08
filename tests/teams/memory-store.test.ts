/**
 * The reference store, against the shared contract.
 */

import { describe, expect, it } from 'vitest';
import { MemoryTeamStore } from '../../src/teams/store-memory.ts';
import { runStoreContract } from './store-contract.ts';
import { createTeamInputFrom, makeTeam } from './helpers.ts';

runStoreContract('memory', async () => ({ store: new MemoryTeamStore() }));

describe('MemoryTeamStore', () => {
  it('keeps separate instances separate', async () => {
    const left = new MemoryTeamStore();
    const right = new MemoryTeamStore();
    const team = await left.createTeam(createTeamInputFrom(makeTeam()));

    expect(await left.getTeam(team.id)).toEqual(team);
    expect(await right.getTeam(team.id)).toBeNull();
    expect(await right.listTeams(team.ownerId)).toEqual([]);
    expect(await right.ping()).toBe(true);
  });
});
