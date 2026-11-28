import type { TaskSnapshot, TaskState } from '@mini-harness/tasks/api';

/** Only conversation-specific facts; lifecycle state belongs to the task. */
export interface RunDetails {
  inputEntryId: string | null;
  sequence: number;
  changedFiles?: string[];
}

export interface RunInfo extends RunDetails {
  id: string;
  sessionId: string;
  state: TaskState;
  startedAt: string;
  /** Actual admission time; startedAt is the existing UI's acceptance timestamp. */
  executedAt?: string;
  finishedAt?: string;
  error?: string;
}

export function projectRun(sessionId: string, task: TaskSnapshot, details: RunDetails): RunInfo {
  return {
    ...details,
    id: task.id,
    sessionId,
    state: task.state,
    startedAt: task.createdAt,
    executedAt: task.startedAt,
    finishedAt: task.finishedAt,
    error: task.error,
  };
}

export interface RunTermination {
  type: 'termination';
  id: string;
  state: 'failed' | 'cancelled' | 'interrupted';
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export const isRunning = (run?: RunInfo) =>
  run?.state === 'queued' || run?.state === 'running' || run?.state === 'waiting';
