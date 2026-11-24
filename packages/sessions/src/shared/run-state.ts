export interface RunInfo {
  id: string;
  sessionId: string;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /** User message responsible for the current turn, null while input is being accepted. */
  inputEntryId?: string | null;
  sequence: number;
  changedFiles?: string[];
}

export const isRunning = (run?: RunInfo) => run?.state === 'queued' || run?.state === 'running';
