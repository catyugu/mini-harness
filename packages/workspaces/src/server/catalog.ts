import { DomainError } from '@mini-harness/platform/errors';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { readJson, writeJson } from '@mini-harness/platform/json';
import { type getPaths, containsPath } from '@mini-harness/platform/paths';

import type { WorkspaceRecord } from '../shared/record.js';
interface CatalogState {
  records: WorkspaceRecord[];
}

// Use the same native resolver as fs/promises.realpath, including Windows long path names.
export const canonicalWorkspacePath = realpathSync.native;

export function workspaceId(path: string) {
  const key = process.platform === 'win32' ? path.toLowerCase() : path;
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

export class WorkspaceCatalog {
  private readonly file: string;
  private readonly stateRoot: string;
  private records: WorkspaceRecord[];
  private readonly startupId: string;
  readonly events = new EventTarget();
  private readonly removalHooks = new Set<(id: string) => Promise<string[]>>();
  private readonly removing = new Map<string, Promise<{ removed: string; deleted: string[] }>>();
  private closing = false;

  constructor(paths: ReturnType<typeof getPaths>) {
    this.file = join(paths.home, 'workspaces.json');
    mkdirSync(paths.home, { recursive: true, mode: 0o700 });
    this.stateRoot = canonicalWorkspacePath(paths.home);
    const cwd = this.directory(paths.cwd);
    this.startupId = workspaceId(cwd);
    const saved = readJson<CatalogState | null>(this.file, null);
    if (saved !== null && !Array.isArray(saved?.records)) throw new Error('Invalid workspace index');
    this.records = saved?.records ?? [];
    if (saved === null) this.save([{ id: this.startupId, path: cwd, name: basename(cwd) || cwd }]);
  }

  private save(records: WorkspaceRecord[]) {
    writeJson(this.file, { records });
    this.records = records;
    this.events.dispatchEvent(new Event('change'));
  }

  private directory(path: string) {
    if (typeof path !== 'string' || !isAbsolute(path))
      throw new DomainError('invalid_input', 'Enter an absolute directory path');
    const target = canonicalWorkspacePath(path);
    if (!statSync(target).isDirectory() || containsPath(this.stateRoot, target))
      throw new DomainError('invalid_input', 'Select a directory outside mini-harness configuration');
    return target;
  }

  get defaultId() {
    return this.records.find(({ id }) => id === this.startupId)?.id ?? this.records[0]?.id;
  }

  list() {
    return this.records.map((record) => ({ ...record }));
  }

  get(id: string) {
    const record = this.records.find((item) => item.id === id);
    if (!record) throw new DomainError('not_found', 'Workspace not found');
    return { ...record };
  }

  resolveRoot(root: string, id: string) {
    const target = this.directory(root);
    if (workspaceId(target) !== id) throw new DomainError('conflict', 'Workspace directory has changed');
    return target;
  }

  register(path: string, name?: string) {
    const target = this.directory(path);
    const id = workspaceId(target);
    const existing = this.records.find((item) => item.id === id);
    if (existing) return { ...existing };
    const record = {
      id,
      path: target,
      name: name === undefined ? basename(target) || target : this.name(name),
    };
    this.save([...this.records, record]);
    return { ...record };
  }

  private name(name: string) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 140)
      throw new DomainError('invalid_input', 'Workspace name must contain 1–140 characters');
    return name.trim();
  }

  rename(id: string, name: string) {
    const record = { ...this.get(id), name: this.name(name) };
    this.save(this.records.map((item) => (item.id === id ? record : item)));
    return { ...record };
  }

  reorder(ids: string[]) {
    if (!Array.isArray(ids) || ids.length !== this.records.length || new Set(ids).size !== ids.length)
      throw new DomainError('invalid_input', 'Order must include every registered workspace');
    this.save(ids.map((id) => this.get(id)));
    return this.list();
  }

  assertAvailable(id: string) {
    if (this.removing.has(id)) throw new DomainError('conflict', 'Workspace is being deleted');
  }

  beforeRemove(handler: (id: string) => Promise<string[]>) {
    this.removalHooks.add(handler);
    return () => {
      this.removalHooks.delete(handler);
    };
  }

  remove(id: string, release: () => Promise<void>) {
    if (this.closing) throw new DomainError('unavailable', 'Workspaces are closing');
    this.assertAvailable(id);
    this.get(id);
    const work = Promise.resolve()
      .then(async () => {
        const groups = await Promise.all([...this.removalHooks].map((hook) => hook(id)));
        await release();
        this.save(this.records.filter((record) => record.id !== id));
        return { removed: id, deleted: groups.flat() };
      })
      .finally(() => this.removing.delete(id));
    this.removing.set(id, work);
    return work;
  }

  async close() {
    this.closing = true;
    await Promise.allSettled(this.removing.values());
  }

  browse(path: string) {
    const target = this.directory(path || this.records[0]?.path || homedir());
    const parent = dirname(target);
    const directories = readdirSync(target, { withFileTypes: true })
      .flatMap((entry) => {
        const child = resolve(target, entry.name);
        if (!entry.isDirectory() || containsPath(this.stateRoot, child)) return [];
        try {
          if (lstatSync(child).isSymbolicLink() || relative(child, canonicalWorkspacePath(child))) return [];
          return [{ name: entry.name, path: child }];
        } catch {
          return [];
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return { path: target, parent: parent === target ? null : parent, directories };
  }
}
