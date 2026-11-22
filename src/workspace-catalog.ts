import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { readJson, writeJson, type getPaths } from './config.js';
import { containsPath } from './workspace.js';
import type { Conversation } from './registry.js';

export interface WorkspaceRecord { id: string; path: string; name: string }
interface CatalogState { records: WorkspaceRecord[] }

// Use the same native resolver as fs/promises.realpath, including Windows long path names.
export const canonicalWorkspacePath = realpathSync.native;

const newWorkspaceId = () => randomUUID().replaceAll('-', '');

function workspaceDirectory(stateRoot: string, path: string) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Enter an absolute directory path');
  const target = canonicalWorkspacePath(path);
  if (!statSync(target).isDirectory() || containsPath(stateRoot, target))
    throw new Error('Select a directory outside mini-harness configuration');
  return target;
}

export class WorkspaceCatalog {
  readonly events = new EventTarget();
  private readonly startupId?: string;

  constructor(private readonly file: string, private readonly stateRoot: string,
    private readonly startupPath: string, private records: WorkspaceRecord[]) {
    this.startupId = records.find(({ path }) => relative(path, startupPath) === '')?.id;
  }

  private save(records: WorkspaceRecord[]) {
    writeJson(this.file, { records });
    this.records = records;
    this.events.dispatchEvent(new Event('change'));
  }

  get defaultId() {
    return this.records.find(({ id }) => id === this.startupId)?.id ??
      this.records.find(({ path }) => relative(path, this.startupPath) === '')?.id ?? this.records[0]?.id;
  }

  list() { return this.records.map((record) => ({ ...record })); }

  get(id: string) {
    const record = this.records.find((item) => item.id === id);
    if (!record) throw new Error('Workspace not found');
    return { ...record };
  }

  resolveRoot(root: string, id: string) {
    const target = workspaceDirectory(this.stateRoot, root);
    if (relative(target, workspaceDirectory(this.stateRoot, this.get(id).path)) !== '') throw new Error('Workspace directory has changed');
    return target;
  }

  register(path: string, name?: string) {
    const target = workspaceDirectory(this.stateRoot, path);
    const id = newWorkspaceId();
    const existing = this.records.find((item) => relative(item.path, target) === '');
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
    const target = workspaceDirectory(this.stateRoot, path);
    if (this.records.some((item) => item.id !== id && relative(item.path, target) === '')) throw new Error('Directory belongs to another workspace');
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
    const target = workspaceDirectory(this.stateRoot, path || this.records[0]?.path || homedir());
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

/** Convert old path lists and recover missing catalog records before serving requests. */
export function openWorkspaceCatalog(paths: ReturnType<typeof getPaths>, sessions: Conversation[]) {
  const file = join(paths.home, 'workspaces.json');
  const hasLegacyData = existsSync(file) || existsSync(paths.registry);
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  const root = canonicalWorkspacePath(paths.home);
  const startup = workspaceDirectory(root, paths.cwd);
  const saved = readJson<CatalogState | string[]>(file, []);
  const records = Array.isArray(saved) ? [] : saved?.records;
  const recordsByPath = new Map<string, WorkspaceRecord>();
  const recordsById = new Map<string, WorkspaceRecord>();
  const pathKey = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;

  function index(record: WorkspaceRecord) {
    if (!record || !/^[a-f0-9]{32}$/.test(record.id) || typeof record.path !== 'string' ||
      !isAbsolute(record.path) || typeof record.name !== 'string' ||
      recordsById.has(record.id) || recordsByPath.has(pathKey(record.path)))
      throw new Error('Invalid or ambiguous workspace catalog; original data was preserved');
    recordsById.set(record.id, record);
    recordsByPath.set(pathKey(record.path), record);
  }
  if (!Array.isArray(records)) throw new Error('Invalid workspace catalog; original data was preserved');
  records.forEach(index);

  const offline = new Set<string>();
  function migrationPath(path: string) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Invalid legacy workspace path: ' + path);
    const absolute = resolve(path);
    if (containsPath(root, absolute)) throw new Error('Legacy workspace is inside mini-harness configuration: ' + absolute);
    try { return workspaceDirectory(root, absolute); }
    catch (error) {
      if (!(error as NodeJS.ErrnoException).code) throw error;
      offline.add(absolute);
      return absolute;
    }
  }

  function add(path: string, id: string) {
    const record = { id, path, name: basename(path) || path };
    index(record);
    return record;
  }
  const recovered = new Map<string, string>();
  for (const { workspaceId, cwd } of sessions) {
    if (!workspaceId || (recordsById.has(workspaceId) && !recovered.has(workspaceId))) continue;
    const path = migrationPath(cwd);
    if (!recovered.has(workspaceId)) {
      add(path, workspaceId);
      recovered.set(workspaceId, path);
    } else if (relative(recovered.get(workspaceId), path) !== '') {
      throw new Error('Ambiguous workspace references; original indexes were preserved');
    }
  }

  const migratePath = (path: string) => {
    const key = pathKey(path);
    return recordsByPath.get(key) ?? add(path,
      hasLegacyData ? createHash('sha256').update(key).digest('hex').slice(0, 32) : newWorkspaceId());
  };
  if (Array.isArray(saved)) {
    migratePath(startup);
    for (const path of saved) migratePath(migrationPath(path));
  }
  const migrated = sessions.some(({ workspaceId }) => !workspaceId) ? sessions.map((session) => session.workspaceId ? session : {
    ...session, workspaceId: migratePath(migrationPath(session.cwd)).id
  }) : sessions;

  // Write the catalog first so a restart can reuse IDs if the session index is still old.
  const nextRecords = [...recordsById.values()];
  if (Array.isArray(saved) || nextRecords.length !== records.length) writeJson(file, { records: nextRecords });
  for (const path of offline) console.warn('Workspace directory unavailable during migration. Saved for repair: ' + path);
  return { catalog: new WorkspaceCatalog(file, root, startup, nextRecords), sessions: migrated };
}
