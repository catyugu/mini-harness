import type { RunInfo } from '@mini-harness/contracts/transport';
import type { SessionEntry } from '@mini-harness/contracts/session-log';
import { HttpError } from '@mini-harness/contracts/routes';
import { randomUUID } from 'node:crypto';
import { lstatSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeJson } from '@mini-harness/platform/config';
import type { Paths } from '@mini-harness/contracts/config';
import type { SessionStore } from '@mini-harness/contracts/session-store';
import type { WorkspacePort } from '@mini-harness/contracts/workspace';
import type { SessionRecords } from '@mini-harness/contracts/session-records';
import type { ScopePort } from '@mini-harness/contracts/capabilities';
import type { CapabilityObservation } from '@mini-harness/contracts/events';
import type { ConversationPermission, SessionRecord } from '@mini-harness/contracts/conversation';
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
  private readonly latestRuns = new Map<string, RunInfo>();
  private readonly logErrors = new Map<string, string>();
  private closing = false;
  readonly events = new EventTarget();

  constructor(private readonly paths: Paths, readonly workspaces: WorkspacePort,
    private readonly scopes?: ScopePort, private readonly observe?: (event: CapabilityObservation) => void,
    private readonly forgetScopes?: (keys: string[]) => void) {
    this.state = loadCatalog(paths, workspaces);
    this.finishDeletion();
    for (const record of this.state.sessions) {
      try { this.openLog(record, 'recover')?.close(); }
      catch (error) { if (!(error instanceof HttpError && error.code === 'unavailable')) throw error; }
    }
  }

  private commit(state: CatalogState) {
    writeJson(this.paths.registry, state);
    syncDirectory(this.paths.home);
    this.state = state;
  }

  private notify(id: string, deleted = false, queue = false) {
    this.events.dispatchEvent(new CustomEvent('change', { detail: { id, deleted, queue } }));
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
    if (this.closing) throw new HttpError('unavailable', 'Agent service is unavailable during shutdown');
    if (id && this.deleting.has(id)) throw new HttpError('conflict', 'Conversation is being deleted');
    if (workspaceId && this.deletingWorkspaces.has(workspaceId)) throw new HttpError('conflict', 'Workspace is being deleted');
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

  create({ parentId = null, title, workspaceId, permission = 'standard' }: Parameters<SessionStore['create']>[0] = {}) {
    const parent = parentId ? this.get(parentId) : undefined;
    if (parentId && !parent) throw new HttpError('not_found', 'Parent conversation not found');
    if (parent && workspaceId !== undefined && workspaceId !== parent.workspaceId)
      throw new HttpError('invalid_input', 'Conversation workspace does not match its parent');
    const targetWorkspace = parent?.workspaceId ?? workspaceId ?? this.workspaces.defaultId;
    if (!targetWorkspace) throw new HttpError('invalid_input', 'Create a workspace before starting a conversation');
    const workspace = this.workspaces.get(targetWorkspace);
    this.assertAvailable(parentId ?? undefined, workspace.id);
    this.workspaces.resolveRoot(workspace.path, workspace.id);
    const session: SessionRecord = { id: randomUUID(), title: title?.slice(0, 140) || 'New conversation',
      titleSource: title ? 'manual' : 'auto', workspaceId: workspace.id, parentId, createdAt: new Date().toISOString(),
      permission };
    this.commit({ ...this.state, sessions: [...this.state.sessions, session] });
    this.notify(session.id);
    this.observe?.({ type: 'session-created', sessionId: session.id });
    return { ...session };
  }

  private replace(id: string, patch: Partial<SessionRecord>) {
    const item = this.get(id);
    if (!item) throw new HttpError('not_found', 'Conversation not found');
    const updated = { ...item, ...patch };
    this.commit({ ...this.state, sessions: this.state.sessions.map((entry) => entry.id === id ? updated : entry) });
    this.notify(id);
    return { ...updated };
  }

  setPermission(id: string, permission: ConversationPermission) {
    this.assertAvailable(id);
    return this.replace(id, { permission });
  }

  rename(id: string, title: string, source: SessionRecord['titleSource'] = 'manual') {
    const record = this.get(id);
    if (!record) throw new HttpError('not_found', 'Conversation not found');
    if (source === 'auto' && (record.titleSource === 'manual' || record.title !== 'New conversation')) return record;
    return this.replace(id, { title, titleSource: source });
  }

  nativeFile(record: Pick<SessionRecord, 'id' | 'workspaceId'>) { return nativeFile(this.paths, this.workspaces, record); }

  runSummary(id: string) {
    const run = this.latestRuns.get(id);
    return run && structuredClone(run);
  }

  logError(id: string) { return this.logErrors.get(id); }

  diagnostics() { return [...this.logErrors].map(([id, message]) => ({ id, message })); }

  private fault(id: string, error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    if (this.logErrors.get(id) === detail) return;
    this.logErrors.set(id, detail);
    console.error('Conversation log ' + id, error);
    this.notify(id);
  }

  private openLog(record: SessionRecord, mode: 'read' | 'write' | 'recover') {
    const { id } = record;
    const writable = mode !== 'read';
    const onChange = (entry: SessionEntry) => {
      if (entry.type === 'run') this.latestRuns.set(id, entry.run);
      const inbox = entry.type.startsWith('inbox-');
      if (inbox || entry.type === 'message' && entry.inboxId) this.notify(id, false, true);
      if (!inbox && entry.type !== 'model-request' && entry.type !== 'tool-schema') this.notify(id);
    };
    let log: SessionLog | undefined;
    try {
      const file = nativeFile(this.paths, this.workspaces, record, mode === 'write');
      if (mode === 'recover') lstatSync(file);
      log = new SessionLog(file, id, record.createdAt, writable ? onChange : undefined, !writable, (error) => {
        if (this.logs.get(id) === log) this.logs.delete(id);
        this.latestRuns.delete(id);
        this.fault(id, error);
      });
      if (writable) {
        log.recover();
        const run = log.latestRun;
        if (run) this.latestRuns.set(id, run);
        else this.latestRuns.delete(id);
        if (this.logErrors.delete(id)) this.notify(id);
      }
      return log;
    } catch (error) {
      log?.close();
      if (mode !== 'write' && missing(error)) return;
      this.fault(id, error instanceof Error ? error.cause ?? error : error);
      throw new HttpError('unavailable', 'This conversation log could not be opened. See session diagnostics.', { cause: error });
    }
  }

  log(id: string) {
    const existing = this.logs.get(id);
    if (existing) {
      this.logs.delete(id);
      this.logs.set(id, existing);
      return existing;
    }
    this.assertAvailable(id);
    const record = this.get(id);
    if (!record) throw new HttpError('not_found', 'Conversation not found');
    if (this.logErrors.has(id) && [...this.participants].some(({ busy }) => busy?.(id)))
      throw new HttpError('unavailable', 'The conversation must finish before reopening its log');
    const log = this.openLog(record, 'write');
    if (!log) throw new Error('Could not open conversation log');
    this.logs.set(id, log);
    for (const [key, candidate] of this.logs) {
      if (this.logs.size <= 32) break;
      if (key === id || [...this.participants].some(({ busy }) => busy?.(key))) continue;
      candidate.close();
      this.logs.delete(key);
    }
    return log;
  }

  inspectLog<T>(id: string, read: (log: SessionLog) => T, strict = false): T | undefined {
    const existing = this.logs.get(id);
    if (existing) return read(existing);
    const record = this.get(id);
    if (!record) return;
    try {
      const log = this.openLog(record, 'read');
      if (!log) return;
      try { return read(log); }
      finally { log.close(); }
    } catch (error) {
      if (!strict && error instanceof HttpError && error.code === 'unavailable') return;
      throw error;
    }
  }

  records(id: string, namespace: string): SessionRecords {
    this.assertAvailable(id);
    return {
      list: () => this.inspectLog(id, (log) => log.branch().flatMap((entry) => entry.type === 'custom' && entry.namespace === namespace
        ? [{ id: entry.id, timestamp: entry.timestamp, data: structuredClone(entry.data) }] : []), true) ?? [],
      append: async (data) => {
        this.assertAvailable(id);
        const value = JSON.parse(JSON.stringify(data));
        return this.log(id).append({ type: 'custom', namespace, data: value }).id;
      }
    };
  }

  workspacePath(id: string) {
    const item = this.get(id);
    if (!item) throw new HttpError('not_found', 'Conversation not found');
    const workspace = this.workspaces.get(item.workspaceId);
    return this.workspaces.resolveRoot(workspace.path, workspace.id);
  }

  depth(id: string) {
    let record = this.get(id);
    if (!record) throw new HttpError('not_found', 'Conversation not found');
    const ancestors = new Set([id]);
    while (record.parentId) {
      if (ancestors.has(record.parentId)) throw new Error('Invalid conversation ancestry');
      ancestors.add(record.parentId);
      record = this.get(record.parentId);
      if (!record) throw new HttpError('not_found', 'Parent conversation not found');
    }
    return ancestors.size - 1;
  }

  descendants(ids: string[]) {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !this.get(id))) throw new HttpError('invalid_input', 'Unknown conversation');
    const children = new Map<string | null, string[]>();
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
    try { return lstatSync(nativeFile(this.paths, this.workspaces, record, false)).mtime.toISOString(); }
    catch { return record.createdAt; }
  }

  export(ids: string[]) {
    return this.descendants(ids).map((id) => {
      this.assertAvailable(id);
      if ([...this.participants].some(({ busy }) => busy?.(id)))
        throw new HttpError('invalid_input', 'Stop active conversations before exporting them');
      const record = this.get(id);
      if (!record) throw new Error('Conversation disappeared during export');
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
    if (all.some((id) => this.deleting.has(id))) throw new HttpError('conflict', 'Conversation is being deleted');
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
        if (!record) throw new Error('Conversation disappeared during deletion');
        this.nativeFile(record);
        this.logs.get(id)?.close();
        this.logs.delete(id);
        this.logErrors.delete(id);
        this.latestRuns.delete(id);
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
