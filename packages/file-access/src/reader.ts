import { DomainError } from '@mini-harness/platform/errors';
import { constants, type BigIntStats, type Dir, type Stats } from 'node:fs';
import type * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';

export class FileTypeError extends DomainError {
  constructor(readonly kind: 'directory' | 'not-directory' | 'unsupported') {
    super(
      'invalid_input',
      {
        directory: 'Path is a directory',
        'not-directory': 'Path is not a directory',
        unsupported: 'Unsupported file type',
      }[kind],
    );
  }
}

export interface FileReader {
  chunks(path: string, signal?: AbortSignal): AsyncIterable<Uint8Array>;
  entries(path?: string, signal?: AbortSignal): Promise<{ name: string; directory: boolean }[]>;
}

/** Resolve explicit paths relative to cwd through the caller's native file provider. */
export function explicitFileReader(
  native: Pick<typeof fs, 'open' | 'stat' | 'opendir'>,
  cwd: string,
): FileReader {
  async function openFile(path: string) {
    const target = resolve(cwd, path);
    const info = await native.stat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOTDIR') throw new FileTypeError('not-directory');
      throw error;
    });
    checkType(info);
    return native.open(target, constants.O_RDONLY);
  }
  return {
    chunks(path, signal) {
      return fileChunks(() => openFile(path), signal);
    },
    async entries(path = '.', signal) {
      return directoryEntries(await native.opendir(resolve(cwd, path)), undefined, signal);
    },
  };
}

export function checkType(info: Stats | BigIntStats, allowDirectory = false) {
  if (info.isDirectory()) {
    if (allowDirectory) return;
    throw new FileTypeError('directory');
  }
  if (!info.isFile()) throw new FileTypeError('unsupported');
}

export async function* fileChunks(open: () => Promise<FileHandle>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const handle = await open();
  try {
    for (;;) {
      signal?.throwIfAborted();
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const { bytesRead } = await handle.read(chunk);
      if (!bytesRead) break;
      yield chunk.subarray(0, bytesRead);
    }
  } finally {
    await handle.close();
  }
}

export async function directoryEntries(
  directory: Dir,
  exclude?: (name: string) => boolean,
  signal?: AbortSignal,
) {
  const result: { name: string; directory: boolean }[] = [];
  for await (const entry of directory) {
    signal?.throwIfAborted();
    // Follow explicitly requested links and skip links encountered during enumeration.
    if (!(entry.isFile() || entry.isDirectory())) continue;
    if (exclude?.(entry.name)) continue;
    result.push({ name: entry.name, directory: entry.isDirectory() });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}
