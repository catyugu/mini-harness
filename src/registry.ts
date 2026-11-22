import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { getPaths, readJson, writeJson } from './config.js';
import { isRunning, type RunInfo } from './protocol.js';

export interface ModelChoice { provider: string; id: string }
export interface Conversation {
  id: string;
  title: string;
  cwd: string;
  parentId: string | null;
  file: string | null;
  model?: ModelChoice;
  run?: RunInfo;
  createdAt: string;
  updatedAt: string;
}

type PendingDeletion = Pick<Conversation, 'id' | 'cwd' | 'file'>;
interface RegistryState { sessions: Conversation[]; pendingDelete?: PendingDeletion[] }
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

export class SessionRegistry {
  private state: RegistryState;

  constructor(private readonly paths: ReturnType<typeof getPaths>) {
    this.state = readJson<RegistryState>(paths.registry, { sessions: [] });
    if (!Array.isArray(this.state.sessions) || (this.state.pendingDelete && !Array.isArray(this.state.pendingDelete)))
      throw new Error('Invalid conversation index');
    this.finishDeletion();
    if (this.state.sessions.some(({ run }) => isRunning(run))) this.commit({ ...this.state,
      sessions: this.state.sessions.map((item) => isRunning(item.run) ? { ...item,
        run: { ...item.run, state: 'interrupted', error: 'Server stopped before the run finished', finishedAt: new Date().toISOString() }
      } : item)
    });
  }

  private commit(state: RegistryState) {
    writeJson(this.paths.registry, state);
    this.state = state;
  }

  list() {
    return this.state.sessions.filter((entry) => relative(this.paths.cwd, entry.cwd) === '')
      .map((entry) => structuredClone(entry)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string) {
    const entry = this.state.sessions.find((entry) => entry.id === id && relative(this.paths.cwd, entry.cwd) === '');
    return entry && structuredClone(entry);
  }

  create({ parentId = null, title = 'New conversation', cwd = this.paths.cwd, model }: {
    parentId?: string | null; title?: string; cwd?: string; model?: ModelChoice;
  } = {}): Conversation {
    if (relative(this.paths.cwd, cwd)) throw new Error('Conversation workspace does not match the server');
    if (parentId && !this.get(parentId)) throw new Error('Parent conversation not found');
    const now = new Date().toISOString();
    const session: Conversation = { id: randomUUID(), title: String(title).slice(0, 140), cwd, parentId,
      file: null, model, createdAt: now, updatedAt: now };
    this.commit({ ...this.state, sessions: [...this.state.sessions, session] });
    return structuredClone(session);
  }

  update(id: string, patch: Partial<Pick<Conversation, 'title' | 'file' | 'model' | 'run'>>) {
    const item = this.get(id);
    if (!item) throw new Error('Conversation not found');
    const updated = { ...item, ...patch, updatedAt: new Date().toISOString() };
    this.commit({ ...this.state, sessions: this.state.sessions.map((entry) => entry.id === id ? updated : entry) });
    return structuredClone(updated);
  }

  depth(id: string) {
    let record = this.get(id);
    if (!record) throw new Error('Conversation not found');
    const ancestors = new Set([id]);
    while (record.parentId) {
      if (ancestors.has(record.parentId)) throw new Error('Invalid conversation ancestry');
      ancestors.add(record.parentId);
      record = this.get(record.parentId);
      if (!record) throw new Error('Parent conversation not found');
    }
    return ancestors.size - 1;
  }

  descendants(ids: string[]) {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !this.get(id))) throw new Error('Unknown conversation');
    const children = new Map<string, string[]>();
    for (const { id, parentId } of this.list()) {
      if (!children.has(parentId)) children.set(parentId, []);
      children.get(parentId).push(id);
    }
    const selected = new Set(ids);
    for (const id of selected) for (const child of children.get(id) ?? []) selected.add(child);
    return [...selected];
  }

  checkedFile(record: Pick<Conversation, 'file' | 'cwd'>): string | undefined {
    if (!record.file) return undefined;
    const expected = getPaths(record.cwd, { MINI_HARNESS_HOME: this.paths.home }).sessions;
    const file = resolve(record.file);
    if (!isAbsolute(record.file) || relative(expected, dirname(file)) !== '' ||
        !/^[a-z0-9_.-]+\.jsonl$/i.test(basename(file))) throw new Error('Session file outside managed storage');
    try {
      const physicalHome = realpathSync(this.paths.home);
      const physicalDir = join(physicalHome, 'sessions', basename(expected));
      if (relative(physicalDir, realpathSync(expected)) ||
          lstatSync(dirname(expected)).isSymbolicLink() || lstatSync(expected).isSymbolicLink()) {
        throw new Error('Session directory outside managed storage');
      }
      const info = lstatSync(file);
      if (!info.isFile() || info.nlink !== 1 || relative(join(physicalDir, basename(file)), realpathSync(file))) {
        throw new Error('Session file outside managed storage');
      }
      return file;
    } catch (error) { if (!missing(error)) throw error; }
  }

  export(ids: string[]) {
    return this.descendants(ids).map((id) => {
      const item = this.get(id);
      const file = this.checkedFile(item);
      // Retain Pi's original JSONL, including entries that are invisible in the displayed branch.
      const piSession = file ? readFileSync(file, 'utf8') : null;
      const { file: _file, ...metadata } = item;
      return { ...metadata, piSession };
    });
  }

  delete(ids: string[]) {
    const all = this.descendants(ids);
    this.finishDeletion();
    const chosen = new Set(all);
    const pendingDelete = all.map((id) => {
      const { cwd, file } = this.get(id);
      this.checkedFile({ cwd, file });
      if (file && this.state.sessions.some((entry) => !chosen.has(entry.id) && entry.file && !relative(entry.file, file)))
        throw new Error('Session file is shared with another conversation');
      return { id, cwd, file };
    });
    if (all.length) {
      this.commit({ sessions: this.state.sessions.filter((entry) => !chosen.has(entry.id)), pendingDelete });
      this.finishDeletion();
    }
    return all;
  }

  private finishDeletion() {
    if (!this.state.pendingDelete?.length) return;
    for (const entry of this.state.pendingDelete) {
      const file = this.checkedFile(entry);
      if (file) {
        try { unlinkSync(file); }
        catch (error) { if (!missing(error)) throw error; }
      }
    }
    this.commit({ sessions: this.state.sessions });
  }
}
