import { DomainError } from '@mini-harness/platform/errors';
import { containsPath } from '@mini-harness/platform/paths';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import type { FileAccessPort, RootedFileAccess } from './api.ts';
import {
  checkType,
  directoryEntries,
  fileChunks,
  FileTypeError,
  openRegularFile,
  statPath,
} from './reader.ts';

const windows = process.platform === 'win32';

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

const denied = () => new DomainError('forbidden', 'Path is outside the permitted root');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** A workspace view, not an operating-system security boundary. */
class RootedFiles implements RootedFileAccess {
  constructor(
    private readonly files: FileAccessPort,
    private readonly cwd: string,
    private readonly exclude?: (absolutePath: string) => boolean,
  ) {}

  private check(root: string, path: string) {
    if (!containsPath(root, path) || this.exclude?.(path)) throw denied();
    return path;
  }

  private async location(path: string, allowMissing = false): Promise<string> {
    const root = resolve(this.cwd);
    const requested = this.check(root, resolve(root, path));
    relative(root, requested).split(sep).filter(Boolean).forEach(checkName);
    const physicalRoot = await this.files.realpath(root);
    const locate = async (target: string): Promise<string> => {
      try {
        return this.check(physicalRoot, await this.files.realpath(target));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') throw new FileTypeError('not-directory');
        if (!missing(error) || target === root) throw error;
        const parent = await locate(dirname(target));
        const info = await this.files.stat(parent).catch((error: unknown) => {
          if (!missing(error)) throw error;
          return undefined;
        });
        if (info && !info.isDirectory()) throw new FileTypeError('not-directory');
        if (!allowMissing) throw error;
        // A dangling link is not an ordinary absent file.
        if (
          await this.files.lstat(target).catch((error: unknown) => {
            if (!missing(error)) throw error;
            return undefined;
          })
        )
          throw error;
        return this.check(physicalRoot, resolve(parent, basename(target)));
      }
    };
    return locate(requested);
  }

  private async openFile(path: string) {
    return openRegularFile(this.files, await this.location(path));
  }

  chunks(path: string, signal?: AbortSignal) {
    return fileChunks(() => this.openFile(path), signal);
  }

  async readFile(path: string) {
    const handle = await this.openFile(path);
    try {
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  async validatePath(path: string) {
    await this.location(path, true);
  }

  async access(path: string) {
    const handle = await this.openFile(path);
    await handle.close();
  }

  async writeFile(path: string, content: string | Uint8Array, create = true, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const target = await this.location(path, create);
    const identify = async () => {
      const info = await this.files.stat(target, { bigint: true });
      checkType(info);
      return info;
    };
    const before = await identify().catch((error: unknown) => {
      if (create && missing(error)) return undefined;
      throw error;
    });
    if (before) {
      const writable = await this.files.open(target, constants.O_WRONLY);
      await writable.close();
    }
    const temporary = resolve(dirname(target), '.mini-harness-' + randomUUID() + '.tmp');
    const handle = await this.files.open(temporary, 'wx', 0o600);
    try {
      try {
        await handle.writeFile(content, { encoding: 'utf8', signal });
        if (before && !windows) await handle.chmod(Number(before.mode & 0o777n));
        await handle.sync();
      } finally {
        await handle.close();
      }
      signal?.throwIfAborted();
      if (!before) {
        await this.files.link(temporary, target);
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
        await this.files.rename(temporary, target);
      }
    } finally {
      await this.files.unlink(temporary).catch((error: unknown) => {
        if (!missing(error)) throw error;
      });
    }
  }

  async mkdir(path: string) {
    await this.files.mkdir(await this.location(path, true), { recursive: true });
  }

  async stat(path: string) {
    const info = await statPath(this.files, await this.location(path));
    checkType(info, true);
    return info;
  }

  async entries(path: string = this.cwd, signal?: AbortSignal) {
    const dir = await this.location(path);
    return directoryEntries(
      await this.files.opendir(dir),
      (name) => Boolean(this.exclude?.(resolve(dir, name))),
      signal,
    );
  }
}

export function rootedFileAccess(
  files: FileAccessPort,
  root: string,
  options?: { exclude?: (absolutePath: string) => boolean },
): RootedFileAccess {
  return new RootedFiles(files, resolve(root), options?.exclude);
}
