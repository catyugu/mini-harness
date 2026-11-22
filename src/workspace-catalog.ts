import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { readJson, writeJson, type getPaths } from './config.js';
import { containsPath } from './workspace.js';

export interface WorkspaceRecord { id: string; path: string; name: string }
interface CatalogState { records: WorkspaceRecord[] }

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
  private readonly startupPath: string;
  readonly events = new EventTarget();

  constructor(paths: ReturnType<typeof getPaths>) {
    this.file = join(paths.home, 'workspaces.json');
    mkdirSync(paths.home, { recursive: true, mode: 0o700 });
    this.stateRoot = canonicalWorkspacePath(paths.home);
    const saved = readJson<CatalogState | string[]>(this.file, []);
    this.records = Array.isArray(saved) ? [] : saved?.records;
    if (!Array.isArray(this.records) || this.records.some((record) => !record || !/^[a-f0-9]{32}$/.test(record.id) ||
      typeof record.path !== 'string' || !isAbsolute(record.path) || typeof record.name !== 'string') ||
      new Set(this.records.map(({ id }) => id)).size !== this.records.length ||
      new Set(this.records.map(({ path }) => process.platform === 'win32' ? path.toLowerCase() : path)).size !== this.records.length)
      throw new Error('Invalid or ambiguous workspace catalog; original data was preserved');
    const cwd = this.directory(paths.cwd);
    this.startupPath = cwd;
    this.startupId = this.records.find((item) => item.path === cwd)?.id;
    if (Array.isArray(saved)) {
      this.importLegacy([cwd, ...saved]);
      if (!this.records.length) this.save([]);
    }
  }

  private save(records: WorkspaceRecord[]) {
    writeJson(this.file, { records });
    this.records = records;
    this.events.dispatchEvent(new Event('change'));
  }

  private directory(path: string) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Enter an absolute directory path');
    const target = canonicalWorkspacePath(path);
    if (!statSync(target).isDirectory() || containsPath(this.stateRoot, target))
      throw new Error('Select a directory outside mini-harness configuration');
    return target;
  }

  importLegacy(paths: string[]) {
    const records = [...this.records];
    for (const path of paths) {
      let target: string;
      try { target = this.directory(path); }
      catch { continue; }
      const id = workspaceId(target);
      if (!records.some((record) => record.path === target))
        records.push({ id, path: target, name: basename(target) || target });
    }
    if (records.length !== this.records.length) this.save(records);
  }

  get defaultId() {
    return this.records.find(({ id }) => id === this.startupId)?.id ?? this.records.find(({ path }) => path === this.startupPath)?.id ?? this.records[0]?.id;
  }

  list() { return this.records.map((record) => ({ ...record })); }

  get(id: string) {
    const record = this.records.find((item) => item.id === id);
    if (!record) throw new Error('Workspace not found');
    return { ...record };
  }

  resolveRoot(root: string, id: string) {
    const target = this.directory(root);
    if (target !== this.directory(this.get(id).path)) throw new Error('Workspace directory has changed');
    return target;
  }

  register(path: string, name?: string) {
    const target = this.directory(path);
    const id = randomUUID().replaceAll('-', '');
    const existing = this.records.find((item) => item.path === target);
    if (existing) return { ...existing };
    const record = { id, path: target, name: name === undefined ? basename(target) || target : this.name(name) };
    this.save([...this.records, record]);
    return { ...record };
  }

  private name(name: string) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 140)
      throw new Error('Workspace name must contain 1–140 characters');
    return name.trim();
  }

  rename(id: string, name: string) {
    const record = { ...this.get(id), name: this.name(name) };
    this.save(this.records.map((item) => item.id === id ? record : item));
    return { ...record };
  }

  relocate(id: string, path: string) {
    const target = this.directory(path);
    if (this.records.some((item) => item.id !== id && item.path === target)) throw new Error('Directory belongs to another workspace');
    const record = { ...this.get(id), path: target };
    this.save(this.records.map((item) => item.id === id ? record : item));
    return { ...record };
  }

  reorder(ids: string[]) {
    if (!Array.isArray(ids) || ids.length !== this.records.length || new Set(ids).size !== ids.length)
      throw new Error('Order must include every registered workspace');
    this.save(ids.map((id) => this.get(id)));
    return this.list();
  }

  remove(id: string) {
    this.get(id);
    this.save(this.records.filter((record) => record.id !== id));
  }

  browse(path: string) {
    const target = this.directory(path || this.records[0]?.path || homedir());
    const parent = dirname(target);
    const directories = readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
      const child = resolve(target, entry.name);
      if (!entry.isDirectory() || containsPath(this.stateRoot, child)) return [];
      try {
        if (lstatSync(child).isSymbolicLink() || relative(child, canonicalWorkspacePath(child))) return [];
        return [{ name: entry.name, path: child }];
      } catch { return []; }
    }).sort((a, b) => a.name.localeCompare(b.name));
    return { path: target, parent: parent === target ? null : parent, directories };
  }
}
