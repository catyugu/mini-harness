import type { ProcessCommand } from '@mini-harness/process-execution/api';

export interface SandboxMount {
  source: string;
  target: string;
  readOnly?: boolean;
}

export interface SandboxOptions {
  cpuSeconds: number;
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
