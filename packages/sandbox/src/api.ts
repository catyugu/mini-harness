import type {} from 'cordis';
import type { ProcessRequest } from '@mini-harness/execution/request';

export interface IsolatedProcess {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface SandboxPort {
  prepare(request: ProcessRequest): Promise<IsolatedProcess>;
}

declare module '@mini-harness/kernel/services' {
  interface ServiceMap { harnessSandbox: SandboxPort }
}
