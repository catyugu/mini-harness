import type { Context } from 'mini-harness/cordis';
import type { ProcessExecutionPort } from 'mini-harness/process-execution';

export const provide = ['harnessProcess'];
export function apply(ctx: Context) {
  const process: ProcessExecutionPort = {
    async run({ file, args = [], cwd, signal }) {
      signal?.throwIfAborted();
      return {
        code: 0,
        signal: null,
        stdout: '[' + cwd + '] ' + [file, ...args].join(' '),
        stderr: '',
        truncated: false,
      };
    },
  };
  ctx.provide('harnessProcess', process);
}
