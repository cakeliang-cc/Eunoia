/**
 * Fixtures shared by the Team store contract and by the backend-specific tests.
 *
 * The point of a factory is that a test that only cares about task CAS does not
 * have to spell out nineteen fields, while a test that does care can override
 * exactly one. Every date is an explicit ISO string: the store under test must
 * never need a wall clock to reproduce a case.
 */

import { randomUUID } from 'node:crypto';
import {
  DEFAULT_TEAM_BUDGET,
  DEFAULT_TEAM_LIMITS,
  TeamError,
} from '../../src/teams/types.ts';
import type {
  Activation,
  Artifact,
  ArtifactManifest,
  Member,
  MemberPermissions,
  MemberProfile,
  RunBudgetSnapshot,
  Task,
  Team,
  TeamConfig,
  TeamErrorCode,
  TeamMessage,
  TeamRun,
} from '../../src/teams/types.ts';
import type { CreateRunInput, CreateTeamInput, Integration } from '../../src/teams/store.ts';

export const NOW = '2026-01-01T00:00:00.000Z';

export function isoAfter(base: string, milliseconds: number): string {
  return new Date(Date.parse(base) + milliseconds).toISOString();
}

export function teamConfig(
  overrides: {
    readonly mode?: TeamConfig['mode'];
    readonly autoDispatch?: boolean;
    readonly dispatchPaused?: boolean;
    readonly limits?: Partial<TeamConfig['limits']>;
    readonly budget?: Partial<TeamConfig['budget']>;
  } = {},
): TeamConfig {
  return {
    mode: overrides.mode ?? 'team',
    defaultModelId: 'deepseek-chat',
    autoDispatch: overrides.autoDispatch ?? true,
    dispatchPaused: overrides.dispatchPaused ?? false,
    limits: { ...DEFAULT_TEAM_LIMITS, ...overrides.limits },
    budget: { ...DEFAULT_TEAM_BUDGET, ...overrides.budget },
  };
}

export function makeTeam(overrides: Partial<Team> = {}): Team {
  return {
    id: `team_${randomUUID()}`,
    ownerId: 'user_team_test',
    rootConversationId: `conv_${randomUUID()}`,
    enabled: true,
    configRevision: 1,
    config: teamConfig(),
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function createTeamInputFrom(team: Team): CreateTeamInput {
  return {
    id: team.id,
    ownerId: team.ownerId,
    rootConversationId: team.rootConversationId,
    enabled: team.enabled,
    config: team.config,
    now: team.createdAt,
  };
}

/** Tight enough that a single oversubscription is visible, wide enough to use. */
export const DEFAULT_RUN_BUDGET: RunBudgetSnapshot = {
  maxInputTokens: 1_000,
  maxOutputTokens: 500,
  maxRequests: 100,
  maxEstimatedCostUsd: null,
};

export function makeRun(overrides: Partial<TeamRun> = {}): TeamRun {
  return {
    id: `run_${randomUUID()}`,
    teamId: 'team_test',
    ownerId: 'user_team_test',
    rootConversationId: 'conv_test',
    rootTurnId: `turn_${randomUUID()}`,
    rootRequestId: `request_${randomUUID()}`,
    inputHash: `hash_${randomUUID()}`,
    status: 'queued',
    budget: { ...DEFAULT_RUN_BUDGET },
    rootMemberId: null,
    reason: null,
    createdAt: NOW,
    updatedAt: NOW,
    finishedAt: null,
    ...overrides,
  };
}

export function createRunInputFrom(run: TeamRun): CreateRunInput {
  return {
    id: run.id,
    teamId: run.teamId,
    ownerId: run.ownerId,
    rootConversationId: run.rootConversationId,
    rootTurnId: run.rootTurnId,
    rootRequestId: run.rootRequestId,
    inputHash: run.inputHash,
    budget: run.budget,
    now: run.createdAt,
  };
}

export function memberProfile(overrides: Partial<MemberProfile> = {}): MemberProfile {
  return {
    modelId: 'deepseek-chat',
    providerId: 'deepseek',
    maxSteps: 12,
    supportsTools: true,
    supportsImages: true,
    contextWindowTokens: 128_000,
    maxOutputTokens: 8_192,
    ...overrides,
  };
}

export function memberPermissions(overrides: Partial<MemberPermissions> = {}): MemberPermissions {
  return {
    allowWorkspaceWrites: true,
    allowCommands: true,
    allowedTools: ['file_read', 'file_write'],
    canSpawn: false,
    canWriteMemory: false,
    maxOutputChars: 20_000,
    imageAssetIds: [],
    ...overrides,
  };
}

export function makeMember(overrides: Partial<Member> = {}): Member {
  return {
    id: `member_${randomUUID()}`,
    teamId: 'team_test',
    parentMemberId: null,
    internalConversationId: `iconv_${randomUUID()}`,
    name: 'root',
    role: 'root',
    depth: 1,
    status: 'provisioning',
    profile: memberProfile(),
    permissions: memberPermissions(),
    workspaceId: null,
    workspaceMode: 'copy',
    contextMode: 'fresh',
    forkSeq: null,
    createdAt: NOW,
    updatedAt: NOW,
    closedAt: null,
    currentActivationId: null,
    error: null,
    ...overrides,
  };
}

export function makeActivation(overrides: Partial<Activation> = {}): Activation {
  return {
    id: `act_${randomUUID()}`,
    runId: 'run_test',
    memberId: 'member_test',
    requestId: `request_${randomUUID()}`,
    generation: 1,
    status: 'queued',
    checkpoint: {},
    input: { kind: 'spawn', text: 'do the work' },
    result: null,
    error: null,
    createdAt: NOW,
    startedAt: null,
    finishedAt: null,
    leaseExpiresAt: null,
    ...overrides,
  };
}

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: `task_${randomUUID()}`,
    teamId: 'team_test',
    runId: 'run_test',
    revision: 1,
    title: 'Write the parser',
    specification: 'Parse the input format described in the plan.',
    acceptance: 'The contract tests pass.',
    required: true,
    dependencies: [],
    ownerId: null,
    status: 'pending',
    writeScopes: ['src/parser.ts'],
    createdBy: 'root',
    createdAt: NOW,
    updatedAt: NOW,
    submittedAt: null,
    acceptedAt: null,
    failureReason: null,
    currentAttemptId: null,
    ...overrides,
  };
}

export function makeMessage(overrides: Partial<TeamMessage> = {}): TeamMessage {
  return {
    id: `msg_${randomUUID()}`,
    teamId: 'team_test',
    runId: 'run_test',
    senderId: 'root',
    senderKind: 'root',
    recipientId: 'member_test',
    clientMessageId: `client_${randomUUID()}`,
    body: 'please continue',
    sequence: 1,
    state: 'accepted',
    createdAt: NOW,
    injectedAt: null,
    processedAt: null,
    activationId: null,
    error: null,
    ...overrides,
  };
}

export function artifactManifest(overrides: Partial<ArtifactManifest> = {}): ArtifactManifest {
  return {
    files: [
      {
        path: 'src/parser.ts',
        change: 'modified',
        baseHash: 'base_1',
        contentHash: 'content_1',
        bytes: 42,
        executable: false,
        binary: false,
        content: 'export const parsed = true;\n',
      },
    ],
    sourceVersion: 'v1',
    candidateHash: 'candidate_1',
    ...overrides,
  };
}

export function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: `artifact_${randomUUID()}`,
    teamId: 'team_test',
    runId: 'run_test',
    taskId: null,
    attemptId: null,
    memberId: 'member_test',
    kind: 'patch',
    manifest: artifactManifest(),
    testEvidence: ['npx vitest run tests/teams'],
    createdAt: NOW,
    ...overrides,
  };
}

export function makeIntegration(overrides: Partial<Integration> = {}): Integration {
  return {
    id: `integration_${randomUUID()}`,
    teamId: 'team_test',
    runId: 'run_test',
    taskId: null,
    baseVersion: 'v1',
    candidateHash: 'candidate_1',
    status: 'candidate',
    conflicts: [],
    baseHashes: { 'src/parser.ts': 'base_1' },
    resultHashes: { 'src/parser.ts': 'content_1' },
    verification: null,
    journal: [{ at: NOW, action: 'created' }],
    createdAt: NOW,
    updatedAt: NOW,
    publishedAt: null,
    ...overrides,
  };
}

/**
 * Assert that a promise fails with a specific `TeamError` code and hand the
 * error back for detail assertions. Written as a helper so a failure message
 * names the code instead of "promise resolved".
 */
export async function expectTeamError(
  promise: Promise<unknown>,
  code: TeamErrorCode,
): Promise<TeamError> {
  try {
    await promise;
  } catch (error) {
    return assertTeamError(error, code);
  }
  throw new Error(`expected ${code}, but the promise resolved`);
}

function assertTeamError(error: unknown, code: TeamErrorCode): TeamError {
  if (!(error instanceof TeamError)) {
    throw new Error(`expected TeamError ${code}, got ${String(error)}`);
  }
  if (error.code !== code) {
    throw new Error(`expected TeamError ${code}, got ${error.code}`);
  }
  return error;
}
