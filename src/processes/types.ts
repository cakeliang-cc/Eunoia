/**
 * Long-running development jobs.
 *
 * A job is a container process group with a stable id, a marker (so PID reuse
 * after a restart is detectable), append-only stdout/stderr files and an exit
 * code file. It is not a shell session: state that matters is in files, so a
 * restarted host can tell "still running", "exited" and "unknown" apart without
 * resending the command.
 */

export type JobStatus = 'starting' | 'running' | 'exited' | 'stopping' | 'stopped' | 'unknown';

export interface DevJobRecord {
  readonly id: string;
  readonly userId: string;
  readonly conversationId: string;
  readonly turnId: string | null;
  readonly memberId: string | null;
  readonly taskId: string;
  readonly toolCallId: string | null;
  readonly command: string;
  readonly cwd: string;
  readonly marker: string;
  readonly pid: number | null;
  readonly status: JobStatus;
  readonly exitCode: number | null;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly stdinFifo: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly expiresAt: string | null;
  readonly error: string | null;
}

export interface ProcessLimits {
  readonly maxJobsPerConversation: number;
  readonly maxCommandChars: number;
  readonly maxReadChars: number;
  readonly ttlMs: number;
  readonly maxInputChars: number;
}

export const DEFAULT_PROCESS_LIMITS: ProcessLimits = {
  maxJobsPerConversation: 3,
  maxCommandChars: 8_000,
  maxReadChars: 16_000,
  ttlMs: 60 * 60_000,
  maxInputChars: 4_000,
};

export class ProcessError extends Error {
  readonly code:
    | 'PROCESS_INVALID'
    | 'PROCESS_NOT_FOUND'
    | 'PROCESS_LIMIT'
    | 'PROCESS_CONFLICT'
    | 'PROCESS_NOT_RUNNING'
    | 'PROCESS_NO_INPUT'
    | 'PROCESS_UNKNOWN'
    | 'PROCESS_TIMEOUT';
  readonly status: number;

  constructor(code: ProcessError['code'], message: string, status = 400) {
    super(message);
    this.name = 'ProcessError';
    this.code = code;
    this.status = status;
  }
}
