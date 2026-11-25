import type * as fs from 'node:fs/promises';
import type { createReadStream } from 'node:fs';

export interface FileAccessPort {
  /** Node file operations, with the same access as the hosting process. */
  readonly native: typeof fs & { createReadStream: typeof createReadStream };
  /** A directory view for paths supplied to a scoped consumer. */
  open(root: string, options?: { exclude?: (absolutePath: string) => boolean }): RootedFileAccess;
}

export interface RootedFileAccess {
  validatePath(path: string): Promise<void>;
  access(path: string): Promise<void>;
  readFile(path: string): Promise<Buffer>;
  writeFile(
    path: string,
    content: string | Uint8Array,
    create?: boolean,
    signal?: AbortSignal,
  ): Promise<void>;
  chunks(path: string, signal?: AbortSignal): AsyncIterable<Uint8Array>;
  mkdir(path: string): Promise<void>;
  stat(path: string): Promise<{ isDirectory(): boolean; size?: number }>;
  entries(path?: string): Promise<{ name: string; directory: boolean }[]>;
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessFileAccess: FileAccessPort;
  }
}
