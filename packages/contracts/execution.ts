import type {} from 'cordis';

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

export interface ProcessExecutionPort {
  run(request: ProcessRequest): Promise<ProcessResult>;
}

export interface IsolatedProcess {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface SandboxPort {
  prepare(request: ProcessRequest): Promise<IsolatedProcess>;
}

declare module 'cordis' {
  interface Context { harnessProcess: ProcessExecutionPort; harnessSandbox: SandboxPort }
}
