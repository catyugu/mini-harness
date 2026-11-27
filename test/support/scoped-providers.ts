import * as fs from 'node:fs/promises';
import type { Stats, BigIntStats } from 'node:fs';
import { basename } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import type { FileAccessPort } from '@mini-harness/file-access/api';
import type { ProcessExecutionPort } from '@mini-harness/process-execution/api';

/** Map one logical file to fixture bytes, retaining ordinary filesystem operations otherwise. */
export function fileProvider(name: string, backingFile: string): FileAccessPort {
  const matches = (path: string) => basename(path) === name;
  const target = (path: string) => (matches(path) ? backingFile : path);
  function stat(path: string): Promise<Stats>;
  function stat(path: string, options: { bigint: true }): Promise<BigIntStats>;
  function stat(path: string, options?: { bigint: true }) {
    return options ? fs.stat(target(path), options) : fs.stat(target(path));
  }
  return {
    ...fs,
    stat,
    realpath: (path) => (matches(path) ? Promise.resolve(path) : fs.realpath(path)),
    lstat: (path) => fs.lstat(target(path)),
    open: (path, flags, mode) => fs.open(target(path), flags, mode),
  };
}

export function processProvider(output: string): ProcessExecutionPort {
  return {
    start(request) {
      if (!request.file) throw new Error('Missing executable');
      return {
        stdin: new PassThrough(),
        stdout: Readable.from([Buffer.from(output)]),
        stderr: Readable.from([]),
        finished: Promise.resolve({ code: 0, signal: null }),
      };
    },
  };
}
