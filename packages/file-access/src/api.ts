import type * as fs from 'node:fs/promises';
import type { Stats, BigIntStats } from 'node:fs';

import type { FileReader } from './reader.ts';

export { explicitFileReader, FileTypeError, type FileReader } from './reader.ts';
export { rootedFileAccess } from './root.ts';

/** The filesystem operations used by the reader and workspace views. */
export interface FileAccessPort extends Pick<typeof fs, 'opendir' | 'mkdir' | 'link' | 'rename' | 'unlink'> {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<Stats>;
  stat(path: string, options: { bigint: true }): Promise<BigIntStats>;
  lstat(path: string): Promise<Stats>;
  open(path: string, flags: string | number, mode?: number): Promise<fs.FileHandle>;
}

export interface RootedFileAccess extends FileReader {
  validatePath(path: string): Promise<void>;
  access(path: string): Promise<void>;
  readFile(path: string): Promise<Buffer>;
  writeFile(
    path: string,
    content: string | Uint8Array,
    create?: boolean,
    signal?: AbortSignal,
  ): Promise<void>;
  mkdir(path: string): Promise<void>;
  stat(path: string): Promise<Stats>;
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessFileAccess: FileAccessPort;
  }
}
