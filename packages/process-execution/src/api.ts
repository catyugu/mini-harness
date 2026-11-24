import type {} from 'cordis';
import type { ProcessRequest, ProcessResult } from '@mini-harness/execution/request';

export interface ProcessExecutionPort {
  run(request: ProcessRequest): Promise<ProcessResult>;
}


declare module '@mini-harness/kernel/services' {
  interface ServiceMap { harnessProcess: ProcessExecutionPort }
}
