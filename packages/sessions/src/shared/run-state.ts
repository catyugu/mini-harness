import type { TaskState } from '@mini-harness/tasks/api';

export interface RunInfo {
  id: string;
  sessionId: string;
  state: TaskState;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /** User message responsible for the current turn, null while input is being accepted. */
  inputEntryId?: string | null;
  sequence: number;
  changedFiles?: string[];
}

export interface RunTermination {
  type: 'termination';
  id: string;
  state: 'failed' | 'cancelled' | 'interrupted';
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export const isRunning = (run?: RunInfo) => run?.state === 'queued' || run?.state === 'running' || run?.state === 'waiting';
