import type { DevJobRecord } from './types.ts';

export interface ProcessStore {
  createDevJob(record: DevJobRecord): Promise<void>;
  updateDevJob(
    userId: string,
    id: string,
    patch: Partial<
      Pick<DevJobRecord, 'pid' | 'status' | 'exitCode' | 'endedAt' | 'error' | 'expiresAt'>
    >,
  ): Promise<void>;
  getDevJob(userId: string, id: string): Promise<DevJobRecord | null>;
  getDevJobByCall(
    userId: string,
    conversationId: string,
    toolCallId: string,
  ): Promise<DevJobRecord | null>;
  listDevJobs(userId: string, conversationId: string): Promise<DevJobRecord[]>;
  listRunningDevJobs(): Promise<DevJobRecord[]>;
}
