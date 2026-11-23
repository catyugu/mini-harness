import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeJson } from '../platform/config.js';
import type { Paths } from '../contracts/config.js';
import type { SessionStore, WorkspacePort } from '../contracts/services.js';
import type { SessionRecords } from '../contracts/plugins.js';
import type { ScopePort } from '../contracts/capabilities.js';
import type { CapabilityObservation } from '../contracts/events.js';
import type { SessionRecord } from '../contracts/conversation.js';
import { SessionLog, syncDirectory } from './log.js';
import { loadCatalog, type CatalogState } from './catalog.js';
import { missing, nativeFile } from './storage.js';

type Participant = Parameters<SessionStore['beforeDelete']>[0];

export class SessionRegistry implements SessionStore {
  private state: CatalogState;
  private readonly deleting = new Set<string>();
  private readonly deletingWorkspaces = new Set<string>();
  private readonly participants = new Set<Participant>();
  private readonly logs = new Map<string, SessionLog>();
  private closing = false;
  readonly events = new EventTarget();

  constructor(private readonly paths: Paths, readonly workspaces: WorkspacePort,
    private readonly scopes?: ScopePort, private readonly observe?: (event: CapabilityObservation) => void,
    private readonly forgetScopes?: (keys: string[]) => void) {
    this.state = loadCatalog(paths, workspaces);
    this.finishDeletion();
    // Recovery does not require a model or a mounted Agent provider.
    for (const record of this.state.sessions) {
      const file = this.nativeFile(record);
      if (!existsSync(file)) continue;
      const log = new SessionLog(file, record.id, record.createdAt);
      try { log.recover(); } finally { log.close(); }
    }
  }

  private commit(state: CatalogState) {
    writeJson(this.paths.registry, state);
    syncDirectory(this.paths.home);
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

  /** Stop accepting work; existing writers remain available while runs drain. */
  close() { this.closing = true; }

  dispose() {
    this.closing = true;
    for (const log of this.logs.values()) log.close();
    this.logs.clear();
  }

  create({ parentId = null, title, workspaceId }: Parameters<SessionStore['create']>[0] = {}) {
    const parent = parentId && this.get(parentId);
    if (parentId && !parent) throw new Error('Parent conversation not found');
    if (parent && workspaceId !== undefined && workspaceId !== parent.workspaceId)
      throw new Error('Conversation workspace does not match its parent');
    const workspace = this.workspaces.get(parent?.workspaceId ?? workspaceId ?? this.workspaces.defaultId);
    this.assertAvailable(parentId, workspace.id);
    this.workspaces.resolveRoot(workspace.path, workspace.id);
    const session: SessionRecord = { id: randomUUID(), title: title?.slice(0, 140) || 'New conversation',
      titleSource: title ? 'manual' : 'auto', workspaceId: workspace.id, parentId, createdAt: new Date().toISOString() };
    this.commit({ ...this.state, sessions: [...this.state.sessions, session] });
    this.notify(session.id);
    this.observe?.({ type: 'session-created', sessionId: session.id });
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

  nativeFile(record: Pick<SessionRecord, 'id' | 'workspaceId'>) { return nativeFile(this.paths, this.workspaces, record); }

  log(id: string) {
    const existing = this.logs.get(id);
    if (existing) return existing;
    this.assertAvailable(id);
    const record = this.get(id);
    if (!record) throw new Error('Conversation not found');
    const log = new SessionLog(this.nativeFile(record), id, record.createdAt, () => this.notify(id));
    this.logs.set(id, log);
    return log;
  }

  records(id: string, namespace: string): SessionRecords {
    this.assertAvailable(id);
    const log = this.log(id);
    return {
      list: () => log.branch().flatMap((entry) => entry.type === 'custom' && entry.namespace === namespace
        ? [{ id: entry.id, timestamp: entry.timestamp, data: structuredClone(entry.data) }] : []),
      append: async (data) => {
        this.assertAvailable(id);
        const value = JSON.parse(JSON.stringify(data));
        return log.append({ type: 'custom', namespace, data: value }).id;
      }
    };
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

  modifiedAt(record: SessionRecord) {
    try { return lstatSync(this.nativeFile(record)).mtime.toISOString(); }
    catch (error) { if (!missing(error)) throw error; return record.createdAt; }
  }

  export(ids: string[]) {
    return this.descendants(ids).map((id) => {
      this.assertAvailable(id);
      if ([...this.participants].some(({ busy }) => busy?.(id)))
        throw new Error('Stop active conversations before exporting them');
      const record = this.get(id);
      this.nativeFile(record);
      const log = this.log(id);
      return { ...record, log: log.serialize() };
    });
  }

  async deleteWorkspace(id: string) {
    this.assertAvailable(undefined, id);
    this.workspaces.get(id);
    this.deletingWorkspaces.add(id);
    try {
      const deleted = await this.delete(this.list(id).map((record) => record.id));
      await this.scopes?.release([], id);
      this.workspaces.remove(id);
      this.forgetScopes?.(['workspace:' + id]);
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
      await this.scopes?.release(all);
      this.finishDeletion();
      const chosen = new Set(all);
      const pendingDelete = all.map((id) => {
        const record = this.get(id);
        this.nativeFile(record);
        this.logs.get(id)?.close();
        this.logs.delete(id);
        return { id, workspaceId: record.workspaceId };
      });
      if (all.length) {
        const locations = all.map((id) => ({ id, keys: this.scopes?.address(id) ?? [] }));
        this.commit({ ...this.state, sessions: this.state.sessions.filter((entry) => !chosen.has(entry.id)), pendingDelete });
        this.finishDeletion();
        for (const { id, keys } of locations) {
          this.notify(id, true);
          this.observe?.({ type: 'session-deleted', sessionId: id, scopeKeys: keys });
        }
      }
      return all;
    } finally { for (const id of all) this.deleting.delete(id); }
  }

  private finishDeletion() {
    if (!this.state.pendingDelete?.length) return;
    for (const entry of this.state.pendingDelete) {
      if (this.state.sessions.some((record) => record.id === entry.id)) throw new Error('Deletion journal includes an active conversation');
      const file = this.nativeFile(entry);
      try { unlinkSync(file); syncDirectory(dirname(file)); }
      catch (error) { if (!missing(error)) throw error; }
    }
    this.forgetScopes?.(this.state.pendingDelete.map(({ id }) => 'session:' + id));
    this.commit({ sessions: this.state.sessions });
  }
}
