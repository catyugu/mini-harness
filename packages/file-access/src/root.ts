import { DomainError } from '@mini-harness/platform/errors';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { basename, dirname, parse, relative, resolve, sep } from 'node:path';
import type { RootedFileAccess } from './api.ts';

const linux = process.platform === 'linux';
const windows = process.platform === 'win32';
const noFollow = linux ? constants.O_NOFOLLOW | constants.O_NONBLOCK : 0;
const directories = linux ? noFollow | constants.O_DIRECTORY : 0;
const descriptor = (handle: FileHandle) => '/proc/self/fd/' + handle.fd;

import { containsPath } from '@mini-harness/platform/paths';

function checkName(name: string) {
  if (
    windows &&
    (/[<>:"|?*\x00-\x1f]/.test(name) ||
      /[ .]$/.test(name) ||
      /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name))
  ) {
    throw new DomainError('invalid_input', 'Unsupported path component');
  }
}

function samePath(a: string, b: string) {
  return relative(a, b) === '';
}
const denied = () => new DomainError('forbidden', 'Path is outside the permitted root or is a link');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

export class RootedFiles implements RootedFileAccess {
  constructor(
    private readonly cwd: string,
    private readonly exclude?: (absolutePath: string) => boolean,
  ) {}

  private async location(path: string) {
    const from = resolve(this.cwd);
    const requested = resolve(from, path);
    if (!containsPath(from, requested)) throw denied();
    const root = await realpath(from);
    if (!samePath(root, from)) throw denied();
    const parts = relative(from, requested).split(sep).filter(Boolean);
    parts.forEach(checkName);
    const target = resolve(root, ...parts);
    if (this.exclude?.(target)) throw denied();
    return { root, parts };
  }

  private async directory<T>(path: string, create: boolean, action: (dir: string) => Promise<T>): Promise<T> {
    const { root, parts } = await this.location(path);
    let dir = root;
    let handle: FileHandle | undefined;
    try {
      if (linux) {
        const expected = await lstat(root, { bigint: true });
        const anchor = parse(root).root;
        handle = await open(anchor, directories);
        for (const part of relative(anchor, root).split(sep).filter(Boolean)) {
          const previous = handle;
          handle = await open(resolve(descriptor(previous), part), directories);
          await previous.close();
        }
        const current = await handle.stat({ bigint: true });
        if (expected.dev !== current.dev || expected.ino !== current.ino) throw denied();
        dir = descriptor(handle);
      }
      for (const part of parts) {
        const next = resolve(dir, part);
        if (create) {
          try {
            await mkdir(next);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          }
        }
        if (linux) {
          const nextHandle = await open(next, directories);
          const previous = handle;
          handle = nextHandle;
          dir = descriptor(handle);
          await previous?.close();
        } else {
          const stat = await lstat(next);
          if (stat.isSymbolicLink() || !stat.isDirectory() || !samePath(await realpath(next), next))
            throw denied();
          dir = next;
        }
      }
      if (linux && !samePath(await realpath(dir), resolve(root, ...parts))) throw denied();
      return await action(dir);
    } finally {
      await handle?.close();
    }
  }

  private async openFile(path: string) {
    path = resolve(this.cwd, path);
    const name = basename(path);
    await this.location(path);
    if (!name || name === '.' || name === '..') throw denied();
    return await this.directory(dirname(path), false, async (dir) => {
      const target = resolve(dir, name);
      // Check before opening so devices and FIFOs never act as regular files.
      const before = await lstat(target, { bigint: true });
      if (!before.isFile() || before.nlink !== 1n || (!linux && !samePath(await realpath(target), target)))
        throw denied();
      const handle = await open(target, constants.O_RDONLY | noFollow);
      try {
        const actual = await handle.stat({ bigint: true });
        if (!actual.isFile() || actual.nlink !== 1n || before.dev !== actual.dev || before.ino !== actual.ino)
          throw denied();
        if (linux && !samePath(await realpath(descriptor(handle)), path)) throw denied();
        if (!linux) {
          const current = await lstat(target, { bigint: true });
          if (
            !samePath(await realpath(target), target) ||
            current.dev !== actual.dev ||
            current.ino !== actual.ino
          )
            throw denied();
        }
        return handle;
      } catch (error) {
        await handle.close();
        throw error;
      }
    });
  }

  private async file<T>(path: string, action: (handle: FileHandle) => Promise<T>) {
    const handle = await this.openFile(path);
    try {
      return await action(handle);
    } finally {
      await handle.close();
    }
  }

  async *chunks(path: string, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    const handle = await this.openFile(path);
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

  readFile(path: string) {
    return this.file(path, (handle) => handle.readFile());
  }

  async validatePath(path: string) {
    await this.location(path);
    await this.directory(dirname(resolve(this.cwd, path)), false, async () => {});
  }

  access(path: string) {
    return this.file(path, async () => {});
  }

  async writeFile(path: string, content: string | Uint8Array, create = true, signal?: AbortSignal) {
    signal?.throwIfAborted();
    path = resolve(this.cwd, path);
    await this.location(path);
    const parent = dirname(path);
    await this.directory(parent, false, async (dir) => {
      const target = resolve(dir, basename(path));
      const identify = async () => {
        const info = await lstat(target, { bigint: true });
        if (!info.isFile() || info.nlink !== 1n || !samePath(await realpath(target), path)) throw denied();
        return info;
      };
      const before = await identify().catch((error: unknown) => {
        if (create && missing(error)) return undefined;
        throw error;
      });
      if (before) {
        const writable = await open(target, constants.O_WRONLY | noFollow);
        try {
          const actual = await writable.stat({ bigint: true });
          if (actual.ino !== before.ino || actual.dev !== before.dev) throw denied();
        } finally {
          await writable.close();
        }
      }
      const temporary = resolve(dir, '.mini-harness-' + randomUUID() + '.tmp');
      const handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
        0o600,
      );
      try {
        try {
          await handle.writeFile(content, { encoding: 'utf8', signal });
          if (before && !windows) await handle.chmod(Number(before.mode & 0o777n));
          await handle.sync();
        } finally {
          await handle.close();
        }
        if (!samePath(await realpath(dir), parent)) throw denied();
        signal?.throwIfAborted();
        if (!before) {
          // A hard link publishes a complete new file without overwriting a concurrent creation.
          await link(temporary, target);
        } else {
          const current = await identify();
          if (
            current.ino !== before.ino ||
            current.dev !== before.dev ||
            current.mtimeNs !== before.mtimeNs ||
            current.ctimeNs !== before.ctimeNs
          )
            throw new DomainError('conflict', 'File changed during write: ' + basename(path));
          signal?.throwIfAborted();
          await rename(temporary, target);
        }
      } finally {
        await unlink(temporary).catch((error: unknown) => {
          if (!missing(error)) throw error;
        });
      }
    });
  }

  mkdir(path: string) {
    return this.directory(path, true, async () => {});
  }

  async stat(path: string) {
    path = resolve(this.cwd, path);
    const { parts } = await this.location(path);
    if (!parts.length) return this.directory(path, false, async (dir) => stat(dir));
    return this.directory(dirname(path), false, async (dir) => {
      const target = resolve(dir, basename(path));
      const info = await lstat(target);
      if (
        info.isSymbolicLink() ||
        (!info.isDirectory() && (!info.isFile() || info.nlink !== 1)) ||
        (!linux && !samePath(await realpath(target), target))
      )
        throw denied();
      return info;
    });
  }

  async entries(path: string = this.cwd) {
    return this.directory(path, false, async (dir) => {
      const result: { name: string; directory: boolean }[] = [];
      for await (const entry of await opendir(dir)) {
        if (!(entry.isFile() || entry.isDirectory())) continue;
        const child = resolve(this.cwd, path, entry.name);
        if (this.exclude?.(child)) continue;
        checkName(entry.name);
        result.push({ name: entry.name, directory: entry.isDirectory() });
      }
      return result.sort((a, b) => a.name.localeCompare(b.name));
    });
  }
}
