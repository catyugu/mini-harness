import type { TaskState } from '@mini-harness/tasks/api';
import type { HistoryEntry } from '@mini-harness/sessions/message';

/** Only conversation-specific facts; lifecycle state belongs to the task. */
export interface RunDetails {
  inputEntryId: string | null;
  answerEntryId?: string;
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

export type RunHistoryEntry = HistoryEntry | RunTermination;
