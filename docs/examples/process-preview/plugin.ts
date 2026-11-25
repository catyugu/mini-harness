import { PassThrough, Readable } from 'node:stream';
import type { Context } from 'mini-harness/cordis';
import type { ProcessExecutionPort } from 'mini-harness/process-execution';

export const provide = ['harnessProcess'];
export function apply(ctx: Context) {
  const process: ProcessExecutionPort = {
    start({ file, args = [], cwd }, signal) {
      signal?.throwIfAborted();
      return {
        stdin: new PassThrough(),
        stdout: Readable.from([Buffer.from('[' + cwd + '] ' + [file, ...args].join(' '))]),
        stderr: Readable.from([]),
        finished: Promise.resolve({ code: 0, signal: null }),
      };
    },
  };
  ctx.provide('harnessProcess', process);
}
