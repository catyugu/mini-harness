import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { getPaths, readJson, writeJson } from '../platform/config.js';
import type { SessionStore, WorkspacePort } from '../contracts/services.js';
import type { SessionRecord } from '../contracts/conversation.js';

type StoredFile = Pick<SessionRecord, 'workspaceId' | 'piSessionRef'>;
interface CatalogState { version: 2; sessions: SessionRecord[]; pendingDelete?: StoredFile[] }
type Participant = Parameters<SessionStore['beforeDelete']>[0];
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

export class SessionRegistry implements SessionStore {
  private state: CatalogState;
  private readonly deleting = new Set<string>();
  private readonly deletingWorkspaces = new Set<string>();
  private readonly participants = new Set<Participant>();
  private closing = false;
  readonly events = new EventTarget();

  constructor(private readonly paths: ReturnType<typeof getPaths>, readonly workspaces: WorkspacePort) {
    this.state = readJson<CatalogState>(paths.registry, { version: 2, sessions: [] });
    if (this.state.version !== 2 || !Array.isArray(this.state.sessions) ||
        (this.state.pendingDelete && !Array.isArray(this.state.pendingDelete))) throw new Error('Invalid conversation index');
    this.finishDeletion();
  }

  private commit(state: CatalogState) {
    writeJson(this.paths.registry, state);
    this.state = state;
  }

  private notify(id: string, deleted = false) {
    this.events.dispatchEvent(new CustomEvent('change', { detail: { id, deleted } }));
  }

  list(workspaceId?: string) {
    return this.state.sessions.filter((entry) => !workspaceId || entry.workspaceId === workspaceId)
      .map((entry) => ({ ...entry }));
  }

  get(id: string) {
    const entry = this.state.sessions.find((entry) => entry.id === id);
    return entry && { ...entry };
  }

  assertAvailable(id?: string, workspaceId = id && this.get(id)?.workspaceId) {
    if (this.closing) throw new Error('Agent service is unavailable during shutdown');
    if (id && this.deleting.has(id)) throw new Error('Conversation is being deleted');
    if (this.deletingWorkspaces.has(workspaceId)) throw new Error('Workspace is being deleted');
  }

  beforeDelete(handler: Participant) {
    this.participants.add(handler);
    return () => { this.participants.delete(handler); };
  }

  close() { this.closing = true; }

  create({ parentId = null, title, workspaceId }: Parameters<SessionStore['create']>[0] = {}) {
    const parent = parentId && this.get(parentId);
    if (parentId && !parent) throw new Error('Parent conversation not found');
    if (parent && workspaceId !== undefined && workspaceId !== parent.workspaceId)
      throw new Error('Conversation workspace does not match its parent');
    const workspace = this.workspaces.get(parent?.workspaceId ?? workspaceId ?? this.workspaces.defaultId);
    this.assertAvailable(parentId, workspace.id);
    this.workspaces.resolveRoot(workspace.path, workspace.id);
    const session: SessionRecord = { id: randomUUID(), title: title?.slice(0, 140) || 'New conversation',
      titleSource: title ? 'manual' : 'auto', workspaceId: workspace.id, parentId,
      piSessionRef: null, createdAt: new Date().toISOString() };
    this.commit({ ...this.state, sessions: [...this.state.sessions, session] });
    this.notify(session.id);
    return { ...session };
  }

  private replace(id: string, patch: Partial<SessionRecord>) {
    const item = this.get(id);
    if (!item) throw new Error('Conversation not found');
    const updated = { ...item, ...patch };
    this.commit({ ...this.state, sessions: this.state.sessions.map((entry) => entry.id === id ? updated : entry) });
    this.notify(id);
    return { ...updated };
  }

  rename(id: string, title: string, source: SessionRecord['titleSource'] = 'manual') {
    const record = this.get(id);
    if (!record) throw new Error('Conversation not found');
    if (source === 'auto' && (record.titleSource === 'manual' || record.title !== 'New conversation')) return record;
    return this.replace(id, { title, titleSource: source });
  }

  link(id: string, file: string) {
    const record = this.get(id);
    if (!record) throw new Error('Conversation not found');
    if (record.piSessionRef === file) return;
    this.checkedFile({ workspaceId: record.workspaceId, piSessionRef: file });
    this.replace(id, { piSessionRef: file });
  }

  workspacePath(id: string) {
    const item = this.get(id);
    if (!item) throw new Error('Conversation not found');
    const workspace = this.workspaces.get(item.workspaceId);
    return this.workspaces.resolveRoot(workspace.path, workspace.id);
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
    for (const { id, parentId } of this.state.sessions) {
      const siblings = children.get(parentId) ?? [];
      siblings.push(id);
      children.set(parentId, siblings);
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

  checkedFile({ workspaceId, piSessionRef }: StoredFile) {
    if (!piSessionRef) return undefined;
    const { path } = this.workspaces.get(workspaceId);
    const expected = getPaths(path, { MINI_HARNESS_HOME: this.paths.home }).sessions;
    const file = resolve(piSessionRef);
    if (!isAbsolute(piSessionRef) || relative(expected, dirname(file)) !== '' ||
        !/^[a-z0-9_.-]+\.jsonl$/i.test(basename(file))) throw new Error('Session file outside managed storage');
    try {
      const physicalDir = this.checkSessionDirectory(expected);
      const info = lstatSync(file);
      if (!info.isFile() || info.nlink !== 1 || relative(join(physicalDir, basename(file)), realpathSync(file)))
        throw new Error('Session file outside managed storage');
      return file;
    } catch (error) { if (!missing(error)) throw error; }
  }

  modifiedAt(record: SessionRecord) {
    try {
      const file = this.checkedFile(record);
      return file ? lstatSync(file).mtime.toISOString() : record.createdAt;
    } catch { return record.createdAt; }
  }

  export(ids: string[]) {
    return this.descendants(ids).map((id) => {
      this.assertAvailable(id);
      if ([...this.participants].some(({ busy }) => busy?.(id)))
        throw new Error('Stop active conversations before exporting them');
      const item = this.get(id);
      const file = this.checkedFile(item);
      const { piSessionRef: _reference, ...metadata } = item;
      return { ...metadata, piSession: file ? readFileSync(file, 'utf8') : null };
    });
  }

  async deleteWorkspace(id: string) {
    this.assertAvailable(undefined, id);
    this.workspaces.get(id);
    this.deletingWorkspaces.add(id);
    try {
      const deleted = await this.delete(this.list(id).map((record) => record.id));
      this.workspaces.remove(id);
      return { removed: id, deleted };
    } finally { this.deletingWorkspaces.delete(id); }
  }

  async delete(ids: string[]) {
    this.assertAvailable();
    const all = this.descendants(ids);
    if (all.some((id) => this.deleting.has(id))) throw new Error('Conversation is being deleted');
    for (const id of all) this.deleting.add(id);
    try {
      const participants = [...this.participants];
      await Promise.all(participants.map(({ quiesce }) => quiesce(all)));
      for (const { release } of participants) release?.(all);
      this.finishDeletion();
      const chosen = new Set(all);
      const pendingDelete = all.map((id) => {
        const { workspaceId, piSessionRef } = this.get(id);
        this.checkedFile({ workspaceId, piSessionRef });
        if (piSessionRef && this.state.sessions.some((entry) => !chosen.has(entry.id) && entry.piSessionRef && !relative(entry.piSessionRef, piSessionRef)))
          throw new Error('Session file is shared with another conversation');
        return { workspaceId, piSessionRef };
      });
      if (all.length) {
        this.commit({ ...this.state, sessions: this.state.sessions.filter((entry) => !chosen.has(entry.id)), pendingDelete });
        this.finishDeletion();
        for (const id of all) this.notify(id, true);
      }
      return all;
    } finally { for (const id of all) this.deleting.delete(id); }
  }

  private finishDeletion() {
    if (!this.state.pendingDelete?.length) return;
    for (const entry of this.state.pendingDelete) {
      const file = this.checkedFile(entry);
      if (!file) continue;
      try { unlinkSync(file); }
      catch (error) { if (!missing(error)) throw error; }
    }
    this.commit({ version: 2, sessions: this.state.sessions });
  }
}
