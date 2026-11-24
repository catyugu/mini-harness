export type ProcessMode = 'isolated' | 'host';

export interface ProcessRequest {
  /** Conversation scope used to select the execution environment. */
  sessionId?: string;
  command: string;
  cwd: string;
  mode: ProcessMode;
  timeoutSeconds: number;
  signal?: AbortSignal;
}

export interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  reason?: 'timeout' | 'cancelled' | 'output-limit';
  stdout: string;
  stderr: string;
  truncated: boolean;
}
