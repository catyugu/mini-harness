export interface ProcessCommand {
  file: string;
  args?: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
}

export interface ProcessRequest extends ProcessCommand {
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

declare module 'mini-harness/cordis' {
  interface Context {
    harnessProcess: ProcessExecutionPort;
  }
}
