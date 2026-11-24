import type {} from 'mini-harness/cordis';
import type { ProcessRequest } from '@mini-harness/execution/request';

export interface IsolatedProcess {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface SandboxPort {
  prepare(request: ProcessRequest, attachments?: string): Promise<IsolatedProcess>;
}

declare module 'mini-harness/cordis' {
  interface Context { harnessSandbox: SandboxPort }
}
