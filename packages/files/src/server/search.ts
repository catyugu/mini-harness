import { DomainError } from '@mini-harness/platform/errors';
import { basename, dirname, matchesGlob, relative, resolve, sep } from 'node:path';
import type { RootedFileAccess } from '@mini-harness/file-access/api';
import { RE2 } from 're2-wasm';
import ignore from 'ignore';

const readLimit = 16 * 1024 * 1024;

export async function readLimited(
  files: RootedFileAccess,
  path: string,
  limit = readLimit,
  signal?: AbortSignal,
) {
  const chunks: Uint8Array[] = [];
  let remaining = limit;
  for await (const chunk of files.chunks(path, signal)) {
    if (chunk.length > remaining) throw new DomainError('invalid_input', 'File exceeds the read limit');
    chunks.push(chunk);
    remaining -= chunk.length;
  }
  return Buffer.concat(chunks);
}

interface SearchInput {
  pattern: string;
  path?: string;
  glob?: string;
  literal?: boolean;
  ignoreCase?: boolean;
  limit?: number;
  context?: number;
}

function samePath(a: string, b: string) {
  return relative(a, b) === '';
}

export class WorkspaceSearch {
  constructor(
    private readonly cwd: string,
    private readonly files: RootedFileAccess,
  ) {}

  private async *walk(root: string, signal?: AbortSignal) {
    type Rules = { dir: string; matcher: ReturnType<typeof ignore> };
    const withRules = async (dir: string, inherited: Rules[]) => {
      try {
        const rules = await readLimited(this.files, resolve(dir, '.gitignore'), 128 * 1024, signal);
        return [...inherited, { dir, matcher: ignore().add(rules.toString('utf8')) }];
      } catch {
        /* An absent or unreadable optional ignore file adds no rules. */
      }
      return inherited;
    };
    root = resolve(this.cwd, root);
    const rootInfo = await this.files.stat(root);
    if (!rootInfo.isDirectory()) throw new Error('Search root must be a directory');
    const ancestors: string[] = [];
    for (let dir = root; !samePath(dir, resolve(this.cwd)); ) {
      dir = dirname(dir);
      ancestors.unshift(dir);
    }
    let inherited: Rules[] = [];
    for (const dir of ancestors) inherited = await withRules(dir, inherited);
    const pending = [{ dir: root, inherited }];
    let visited = 0;
    while (pending.length) {
      signal?.throwIfAborted();
      const item = pending.pop();
      if (!item) break;
      const { dir, inherited } = item;
      const rules = await withRules(dir, inherited);
      for (const entry of await this.files.entries(dir)) {
        signal?.throwIfAborted();
        if (++visited > 20000)
          throw new DomainError('invalid_input', 'Search limit reached. Select a narrower directory.');
        if (entry.name === '.git') continue;
        const path = resolve(dir, entry.name);
        let ignored = false;
        for (const { dir, matcher } of rules) {
          const result = matcher.test(
            relative(dir, path).split(sep).join('/') + (entry.directory ? '/' : ''),
          );
          if (result.ignored || result.unignored) ignored = result.ignored;
        }
        if (ignored) continue;
        if (entry.directory) pending.push({ dir: path, inherited: rules });
        yield { path, ...entry };
      }
    }
  }

  async searchFiles(query: string, signal?: AbortSignal) {
    if (query.length > 200) throw new Error('Search is too long');
    const files: string[] = [];
    for await (const entry of this.walk('.', signal)) {
      const path = relative(this.cwd, entry.path).split(sep).join('/');
      if (!entry.directory && path.toLowerCase().includes(query.toLowerCase())) files.push(path);
      if (files.length >= 100) break;
    }
    return files;
  }

  async find(pattern: string, root: string, limit: number, signal?: AbortSignal) {
    if (pattern.length > 512) throw new Error('Glob is too long');
    const base = resolve(this.cwd, root);
    const files = [];
    for await (const entry of this.walk(base, signal)) {
      if (
        matchesGlob(
          pattern.includes('/') ? relative(base, entry.path).split(sep).join('/') : entry.name,
          pattern,
        )
      ) {
        const path = relative(this.cwd, entry.path).split(sep).join('/');
        files.push(path + (entry.directory ? '/' : ''));
        if (files.length >= limit) break;
      }
    }
    return files;
  }

  async grep(input: SearchInput, signal?: AbortSignal) {
    const { pattern, glob, literal, ignoreCase } = input;
    if (!pattern || pattern.length > 4096 || (glob?.length ?? 0) > 512)
      throw new DomainError('invalid_input', 'Invalid search pattern');
    const expression = new RE2(
      literal ? pattern.replace(/[.*+?^$${}()|[\]\\]/g, '\\$&') : pattern,
      ignoreCase ? 'ui' : 'u',
    );
    const path = resolve(this.cwd, input.path || '.');
    const directory = (await this.files.stat(path)).isDirectory();
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
      const size = (await this.files.stat(entry.path)).size;
      if (size !== undefined && size > readLimit) continue;
      const buffer = await readLimited(this.files, entry.path, readLimit, signal);
      total += buffer.length;
      if (total > 32 * 1024 * 1024)
        throw new Error('Search byte limit reached. Select a narrower directory.');
      if (buffer.includes(0)) continue;
      const lines = buffer.toString('utf8').split(/\r?\n/);
      let previous = -1;
      for (const [index, line] of lines.entries()) {
        if (!expression.test(line)) continue;
        for (
          let i = Math.max(previous + 1, index - context, 0);
          i <= Math.min(lines.length - 1, index + context);
          i++
        ) {
          matches.push(name + (i === index ? ':' : '-') + (i + 1) + ': ' + lines[i].slice(0, 500));
          previous = i;
        }
        if (++count >= limit) break search;
      }
    }
    return { matches, limited: count >= limit };
  }
}
