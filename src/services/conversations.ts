import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { getPaths, readJson, writeJson } from '../config.js';
import { WorkspaceCatalog } from './workspaces.js';
import { isRunning, type RunInfo } from '../contracts/transport.js';

import type { ModelChoice, Conversation } from '../contracts/conversation.js';

type PendingDeletion = Pick<Conversation, 'id' | 'cwd' | 'file'>;
interface RegistryState { sessions: Conversation[]; pendingDelete?: PendingDeletion[] }
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

export class SessionRegistry {
  private state: RegistryState;

  readonly events = new EventTarget();

  constructor(private readonly paths: ReturnType<typeof getPaths>, readonly workspaces = new WorkspaceCatalog(paths)) {
    this.state = readJson<RegistryState>(paths.registry, { sessions: [] });
    if (!Array.isArray(this.state.sessions) || (this.state.pendingDelete && !Array.isArray(this.state.pendingDelete)))
      throw new Error('Invalid conversation index');
    this.finishDeletion();
    if (this.state.sessions.some((item) => typeof item.workspaceId !== 'string')) throw new Error('Conversation index requires a workspaceId');
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

  notify(id: string, deleted = false) {
    this.events.dispatchEvent(new CustomEvent('change', { detail: { id, deleted } }));
  }

  list(workspaceId?: string) {
    return this.state.sessions.filter((entry) => !workspaceId || entry.workspaceId === workspaceId)
      .map((entry) => structuredClone(entry)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string) {
    const entry = this.state.sessions.find((entry) => entry.id === id);
    return entry && structuredClone(entry);
  }

  create({ parentId = null, title = 'New conversation', workspaceId, model }: {
    parentId?: string | null; title?: string; workspaceId?: string; model?: ModelChoice;
  } = {}): Conversation {
    const parent = parentId && this.get(parentId);
    if (parentId && !parent) throw new Error('Parent conversation not found');
    if (parent && workspaceId !== undefined && workspaceId !== parent.workspaceId)
      throw new Error('Conversation workspace does not match its parent');
    const workspace = parent ? undefined : this.workspaces.get(workspaceId ?? this.workspaces.defaultId);
    const cwd = parent ? parent.cwd : this.workspaces.resolveRoot(workspace.path, workspace.id);
    const now = new Date().toISOString();
    const session: Conversation = { id: randomUUID(), title: String(title).slice(0, 140), cwd,
      workspaceId: parent ? parent.workspaceId : workspace.id, parentId,
      file: null, model, createdAt: now, updatedAt: now };
    this.commit({ ...this.state, sessions: [...this.state.sessions, session] });
    this.notify(session.id);
    return structuredClone(session);
  }

  update(id: string, patch: Partial<Pick<Conversation, 'title' | 'file' | 'model' | 'run'>>) {
    const item = this.get(id);
    if (!item) throw new Error('Conversation not found');
    const updated = { ...item, ...patch, updatedAt: new Date().toISOString() };
    this.commit({ ...this.state, sessions: this.state.sessions.map((entry) => entry.id === id ? updated : entry) });
    this.notify(id);
    return structuredClone(updated);
  }

  workspacePath(id: string) {
    const item = this.get(id);
    if (!item) throw new Error('Conversation not found');
    return this.workspaces.resolveRoot(item.cwd, item.workspaceId);
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

  checkSessionDirectory(expected: string) {
    const physicalDir = join(realpathSync(this.paths.home), 'sessions', basename(expected));
    if (relative(physicalDir, realpathSync(expected)) ||
        lstatSync(dirname(expected)).isSymbolicLink() || lstatSync(expected).isSymbolicLink()) {
      throw new Error('Session directory outside managed storage');
    }
    return physicalDir;
  }

  checkedFile(record: Pick<Conversation, 'file' | 'cwd'>): string | undefined {
    if (!record.file) return undefined;
    const expected = getPaths(record.cwd, { MINI_HARNESS_HOME: this.paths.home }).sessions;
    const file = resolve(record.file);
    if (!isAbsolute(record.file) || relative(expected, dirname(file)) !== '' ||
        !/^[a-z0-9_.-]+\.jsonl$/i.test(basename(file))) throw new Error('Session file outside managed storage');
    try {
      const physicalDir = this.checkSessionDirectory(expected);
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
      for (const id of all) this.notify(id, true);
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
