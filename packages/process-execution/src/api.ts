import type { ProcessRequest, ProcessResult } from '@mini-harness/execution/request';

export interface ProcessExecutionPort {
  run(request: ProcessRequest): Promise<ProcessResult>;
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessProcess: ProcessExecutionPort;
  }
}
