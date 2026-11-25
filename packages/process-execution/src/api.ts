import type { Readable, Writable } from 'node:stream';

export interface ProcessCommand {
  file: string;
  args?: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
}

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface RunningProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Settles after the child and its stdio close. */
  readonly finished: Promise<ProcessExit>;
}

export interface ProcessExecutionPort {
  start(command: ProcessCommand, signal?: AbortSignal): RunningProcess;
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessProcess: ProcessExecutionPort;
  }
}
