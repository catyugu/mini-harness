import type { ProcessCommand } from '@mini-harness/process-execution/api';

export interface SandboxMount {
  source: string;
  target: string;
  readOnly?: boolean;
}

export interface SandboxOptions {
  /** Working directory inside the isolation environment. */
  workingDirectory: string;
  limits?: { cpuSeconds?: number; openFiles?: number; fileBytes?: number; coreBytes?: number };
  mounts?: readonly SandboxMount[];
  signal?: AbortSignal;
}

export interface SandboxPort {
  prepare(command: ProcessCommand, options: SandboxOptions): Promise<ProcessCommand>;
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessSandbox: SandboxPort;
  }
}
