import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, stat, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, matchesGlob, relative, resolve, sep } from 'node:path';
import {
  createEditToolDefinition, createFindToolDefinition, createGrepToolDefinition,
  createLsToolDefinition, createReadToolDefinition, createWriteToolDefinition, truncateHead
} from '@earendil-works/pi-coding-agent';
import { RE2 } from 're2-wasm';
import ignore from 'ignore';

const linux = process.platform === 'linux';
const windows = process.platform === 'win32';
const readLimit = 16 * 1024 * 1024;
const noFollow = linux ? constants.O_NOFOLLOW | constants.O_NONBLOCK : 0;
const directories = linux ? noFollow | constants.O_DIRECTORY : 0;
const descriptor = (handle: FileHandle) => '/proc/self/fd/' + handle.fd;

import { containsPath } from '../platform/paths.js';

function checkName(name: string) {
  if (windows && (/[<>:"|?*\x00-\x1f]/.test(name) || /[ .]$/.test(name) ||
    /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name))) {
    throw new Error('Unsupported workspace path component');
  }
}

function samePath(a: string, b: string) { return relative(a, b) === ''; }
const denied = () => new Error('Path is outside the permitted workspace or is a link');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

export class Workspace {
  constructor(private readonly cwd: string, private readonly state: string, private readonly canonicalRoot = false) {}

  private async location(path: string) {
    const from = resolve(this.cwd);
    const requested = resolve(from, path);
    if (!containsPath(from, requested)) throw denied();
    const root = await realpath(from);
    if (this.canonicalRoot && !samePath(root, from)) throw denied();
    const state = await realpath(this.state);
    const parts = relative(from, requested).split(sep).filter(Boolean);
    parts.forEach(checkName);
    const target = resolve(root, ...parts);
    if (containsPath(state, target) || containsPath(this.state, requested)) throw denied();
    return { root, parts };
  }

  private async directory<T>(path: string, create: boolean, action: (dir: string) => Promise<T>): Promise<T> {
    const { root, parts } = await this.location(path);
    let dir = root;
    let handle: FileHandle | undefined;
    try {
      if (linux) {
        const expected = await lstat(root, { bigint: true });
        handle = await open(root, directories);
        const current = await handle.stat({ bigint: true });
        if (expected.dev !== current.dev || expected.ino !== current.ino) throw denied();
        dir = descriptor(handle);
      }
      for (const part of parts) {
        const next = resolve(dir, part);
        if (create) {
          try { await mkdir(next); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        }
        if (linux) {
          const nextHandle = await open(next, directories);
          const previous = handle;
          handle = nextHandle;
          dir = descriptor(handle);
          await previous.close();
        } else {
          const stat = await lstat(next);
          if (stat.isSymbolicLink() || !stat.isDirectory() || !samePath(await realpath(next), next)) throw denied();
          dir = next;
        }
      }
      return await action(dir);
    } finally { await handle?.close(); }
  }

  private async openFile(path: string, write: boolean, create: boolean) {
    path = resolve(this.cwd, path);
    const name = basename(path);
    await this.location(path);
    if (!name || name === '.' || name === '..') throw denied();
    return await this.directory(dirname(path), false, async (dir) => {
      const target = resolve(dir, name);
      let handle: FileHandle;
      let before;
      const flags = noFollow | (write ? constants.O_WRONLY : constants.O_RDONLY);
      try {
        // Check the type before opening so devices and FIFOs never act as regular files.
        before = await lstat(target, { bigint: true });
        if (!before.isFile() || before.nlink !== 1n || (!linux && !samePath(await realpath(target), target))) throw denied();
        handle = await open(target, flags);
      } catch (error) {
        if (!create || !missing(error)) throw error;
        before = undefined;
        handle = await open(target, flags | constants.O_CREAT | constants.O_EXCL, 0o600);
      }
      try {
        const actual = await handle.stat({ bigint: true });
        if (!actual.isFile() || actual.nlink !== 1n ||
            (before && (before.dev !== actual.dev || before.ino !== actual.ino))) throw denied();
        if (!linux) {
          const current = await lstat(target, { bigint: true });
          if (!samePath(await realpath(target), target) || current.dev !== actual.dev || current.ino !== actual.ino) throw denied();
        }
        return handle;
      } catch (error) {
        await handle.close();
        throw error;
      }
    });
  }

  private async file<T>(path: string, write: boolean, create: boolean, action: (handle: FileHandle) => Promise<T>) {
    const handle = await this.openFile(path, write, create);
    try { return await action(handle); }
    finally { await handle.close(); }
  }

  async *chunks(path: string, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    const handle = await this.openFile(path, false, false);
    try {
      const size = Math.min((await handle.stat()).size, readLimit);
      for (let offset = 0; offset < size;) {
        signal?.throwIfAborted();
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, size - offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) break;
        offset += bytesRead;
        yield buffer.subarray(0, bytesRead);
      }
    } finally { await handle.close(); }
  }

  readFile(path: string) {
    return this.file(path, false, false, async (handle) => {
      const size = (await handle.stat()).size;
      if (size > readLimit) throw new Error('File exceeds the 16 MiB read limit');
      const buffer = Buffer.allocUnsafe(size);
      let offset = 0;
      while (offset < size) {
        const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      return buffer.subarray(0, offset);
    });
  }

  async validatePath(path: string) {
    await this.location(path);
    await this.directory(dirname(resolve(this.cwd, path)), false, async () => {});
  }

  access(path: string) { return this.file(path, false, false, async () => {}); }

  writeFile(path: string, content: string, create = true) {
    return this.file(path, true, create, async (handle) => {
      await handle.writeFile(content, 'utf8');
      await handle.truncate(Buffer.byteLength(content));
    });
  }

  mkdir(path: string) { return this.directory(path, true, async () => {}); }

  private async stat(path: string) {
    path = resolve(this.cwd, path);
    const { parts } = await this.location(path);
    if (!parts.length) return this.directory(path, false, async (dir) => stat(dir));
    return this.directory(dirname(path), false, async (dir) => {
      const target = resolve(dir, basename(path));
      const info = await lstat(target);
      if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1)) ||
          (!linux && !samePath(await realpath(target), target))) throw denied();
      return info;
    });
  }

  async entries(path: string = this.cwd) {
    return this.directory(path, false, async (dir) => {
      const result: { name: string; directory: boolean }[] = [];
      for await (const entry of await opendir(dir)) {
        if (!(entry.isFile() || entry.isDirectory())) continue;
        const child = resolve(path, entry.name);
        if (containsPath(this.state, child)) continue;
        checkName(entry.name);
        if (result.length >= 20000) throw new Error('Directory exceeds the listing limit');
        result.push({ name: entry.name, directory: entry.isDirectory() });
      }
      return result.sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  private async *walk(root: string, signal?: AbortSignal) {
    type Rules = { dir: string; matcher: ReturnType<typeof ignore> };
    const withRules = async (dir: string, inherited: Rules[]) => {
      try {
        const rules = await this.readFile(resolve(dir, '.gitignore'));
        if (rules.length <= 128 * 1024) return [...inherited, { dir, matcher: ignore().add(rules.toString('utf8')) }];
      } catch { /* An absent or unreadable optional ignore file adds no rules. */ }
      return inherited;
    };
    root = resolve(this.cwd, root);
    await this.location(root);
    const ancestors: string[] = [];
    for (let dir = root; !samePath(dir, resolve(this.cwd));) {
      dir = dirname(dir);
      ancestors.unshift(dir);
    }
    let inherited: Rules[] = [];
    for (const dir of ancestors) inherited = await withRules(dir, inherited);
    const pending = [{ dir: root, inherited }];
    let visited = 0;
    while (pending.length) {
      signal?.throwIfAborted();
      const { dir, inherited } = pending.pop();
      const rules = await withRules(dir, inherited);
      for (const entry of await this.entries(dir)) {
        signal?.throwIfAborted();
        if (++visited > 20000) throw new Error('Search limit reached. Select a narrower directory.');
        if (entry.name === '.git') continue;
        const path = resolve(dir, entry.name);
        let ignored = false;
        for (const { dir, matcher } of rules) {
          const result = matcher.test(relative(dir, path).split(sep).join('/') + (entry.directory ? '/' : ''));
          if (result.ignored || result.unignored) ignored = result.ignored;
        }
        if (ignored) continue;
        if (entry.directory) pending.push({ dir: path, inherited: rules });
        yield { path, ...entry };
      }
    }
  }

  async searchFiles(query: string) {
    if (query.length > 200) throw new Error('Search is too long');
    const files: string[] = [];
    for await (const entry of this.walk('.')) {
      const path = relative(this.cwd, entry.path).split(sep).join('/');
      if (!entry.directory && path.toLowerCase().includes(query.toLowerCase())) files.push(path);
      if (files.length >= 100) break;
    }
    return files;
  }

  imageType(path: string) {
    return this.file(path, false, false, async (handle) => {
      const buffer = Buffer.alloc(12);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const prefix = buffer.subarray(0, bytesRead);
      if (prefix.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
      if (prefix.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'image/jpeg';
      if (/^GIF8[79]a/.test(prefix.toString('ascii', 0, 6))) return 'image/gif';
      if (prefix.toString('ascii', 0, 4) === 'RIFF' && prefix.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
      return null;
    });
  }

  tools() {
    const cwd = this.cwd;
    const readFile = (path: string) => this.readFile(path);
    const access = (path: string) => this.access(path);
    const find = createFindToolDefinition(cwd, { operations: {
      exists: async (path) => { await this.stat(path); return true; },
      glob: async (pattern, root, { limit }) => this.find(pattern, root, limit)
    } });
    const grep = createGrepToolDefinition(cwd);
    return [
      createReadToolDefinition(cwd, { operations: { readFile, access, detectImageMimeType: (path) => this.imageType(path), createReadStream: (path, { signal }) => this.chunks(path, signal) } }),
      createEditToolDefinition(cwd, { operations: { readFile, access, writeFile: (path, content) => this.writeFile(path, content, false) } }),
      createWriteToolDefinition(cwd, { operations: { writeFile: (path, content) => this.writeFile(path, content), mkdir: (path) => this.mkdir(path) } }),
      createLsToolDefinition(cwd, { operations: {
        exists: async (path) => { await this.stat(path); return true; },
        stat: (path) => this.stat(path),
        readdir: async (path) => (await this.entries(path)).map(({ name }) => name)
      } }),
      { ...find, description: 'Find files and directories matching a glob in the workspace. Respects .gitignore and skips links.',
        promptSnippet: 'Find files by workspace glob' },
      { ...grep, description: 'Search workspace text files with a literal or RE2 pattern. Respects .gitignore and skips links.',
        promptSnippet: 'Search text files in the workspace',
        execute: async (_id: string, input: Parameters<typeof grep.execute>[1], signal?: AbortSignal) => this.grep(input, signal) }
    ];
  }

  private async find(pattern: string, root: string, limit: number) {
    if (pattern.length > 512) throw new Error('Glob is too long');
    const files = [];
    for await (const entry of this.walk(root)) {
      if (matchesGlob(pattern.includes('/') ? relative(root, entry.path).split(sep).join('/') : entry.name, pattern)) {
        files.push(entry.path);
        if (files.length >= limit) break;
      }
    }
    return files;
  }

  private async grep(input: Parameters<ReturnType<typeof createGrepToolDefinition>['execute']>[1], signal?: AbortSignal) {
    const { pattern, glob, literal, ignoreCase } = input;
    if (!pattern || pattern.length > 4096 || (glob?.length ?? 0) > 512) throw new Error('Invalid search pattern');
    const expression = new RE2(literal ? pattern.replace(/[.*+?^$${}()|[\]\\]/g, '\\$&') : pattern, ignoreCase ? 'ui' : 'u');
    const path = resolve(this.cwd, input.path || '.');
    const directory = (await this.stat(path)).isDirectory();
    const files = directory ? this.walk(path, signal) : [{ path, directory: false, name: basename(path) }];
    const matches: string[] = [];
    const limit = Math.max(1, Math.min(1000, Math.floor(input.limit ?? 100)));
    const context = Math.max(0, Math.min(20, Math.floor(input.context ?? 0)));
    let total = 0;
    let count = 0;
    search: for await (const entry of files) {
      signal?.throwIfAborted();
      const name = directory ? relative(path, entry.path).split(sep).join('/') : entry.name;
      if (entry.directory || (glob && !matchesGlob(glob.includes('/') ? name : entry.name, glob))) continue;
      const size = (await this.stat(entry.path)).size;
      if (size > readLimit) continue;
      const buffer = await this.readFile(entry.path);
      total += buffer.length;
      if (total > 32 * 1024 * 1024) throw new Error('Search byte limit reached. Select a narrower directory.');
      if (buffer.includes(0)) continue;
      const lines = buffer.toString('utf8').split(/\r?\n/);
      let previous = -1;
      for (const [index, line] of lines.entries()) {
        if (!expression.test(line)) continue;
        for (let i = Math.max(previous + 1, index - context, 0); i <= Math.min(lines.length - 1, index + context); i++) {
          matches.push(name + (i === index ? ':' : '-') + (i + 1) + ': ' + lines[i].slice(0, 500));
          previous = i;
        }
        if (++count >= limit) break search;
      }
    }
    const result = truncateHead(matches.join('\n'));
    return { content: [{ type: 'text' as const, text: (result.content || 'No matches found') +
      (result.truncated || count >= limit ? '\n[Results limited]' : '') }], details: undefined };
  }
}
