import { displayRecord } from './projection.ts';
import type { RecordAppend } from './shared/display-record.ts';
import { userContent } from './user-content.ts';
import type { RunInfo } from './shared/run-state.ts';
import { runFromEntry } from './log-api.ts';
import type { SessionEntry, SessionLogPort } from './log-api.ts';
import { DomainError } from '@mini-harness/platform/errors';
import { randomUUID } from 'node:crypto';
import { lstatSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeJson } from '@mini-harness/platform/json';
import type { Paths } from '@mini-harness/platform/runtime-paths';
import type { WorkspacePort } from '@mini-harness/workspaces/api';
import type { RecordOwner, SessionRecords, SessionStore } from './records.ts';
import type { TaskOptions } from '@mini-harness/tasks/api';
import { readTaskHistory } from './task-history.ts';
import {
  createScopeKey,
  scopeParentOf,
  setScopeParent,
  type ScopeKey,
} from '@mini-harness/plugin-api/scopes';
import type { ScopeAddress } from '@mini-harness/plugin-api/configuration';
import type { CapabilityObservation } from '@mini-harness/plugin-api/observations';
import type { ConversationPermission, SessionRecord } from './shared/identity.ts';
import { SessionLog } from './log.ts';
import { syncDirectory } from './record-log.ts';
import { loadCatalog, type CatalogState } from './catalog.ts';
import {
  attachmentDirectory,
  deleteAttachments,
  missing,
  nativeFile,
  readAttachmentFile,
  storeAttachments,
} from './storage.ts';
import { imageMimeType, prepareInput } from '@mini-harness/input/prepare';
import type { Attachment } from '@mini-harness/input/message';

type Participant = Parameters<SessionStore['beforeDelete']>[0];

const profileScopes = new WeakMap<Paths, Map<string, ScopeKey>>();

export class SessionRegistry implements SessionStore {
  private state: CatalogState;
  private readonly deleting = new Set<string>();
  private readonly deletions = new Set<Promise<string[]>>();
  private readonly participants = new Set<Participant>();
  private readonly logs = new Map<string, SessionLog>();
  private readonly runtimeScopes: Map<string, ScopeKey>;
  private readonly latestRuns = new Map<string, RunInfo>();
  private readonly taskOwners = new Map<string, string>();
  private readonly logErrors = new Map<string, string>();
  private closing = false;
  private pendingDeletion = Promise.resolve();
  readonly events = new EventTarget();

  constructor(
    private readonly paths: Paths,
    private readonly workspaceService: () => WorkspacePort | undefined = () => undefined,
    private readonly observe?: (event: CapabilityObservation, key?: ScopeKey) => void,
    private readonly forgetScopes?: (keys: ScopeAddress[]) => Promise<void>,
  ) {
    this.runtimeScopes = profileScopes.get(paths) ?? new Map();
    profileScopes.set(paths, this.runtimeScopes);
    this.state = loadCatalog(paths, workspaceService());
    this.bindWorkspaces(workspaceService());
    for (const record of this.state.sessions) {
      try {
        this.openLog(record, 'recover')?.close();
      } catch (error) {
        if (!(error instanceof DomainError && error.code === 'unavailable')) throw error;
      }
    }
  }

  private commit(state: CatalogState) {
    writeJson(this.paths.registry, state);
    syncDirectory(this.paths.home);
    this.state = state;
  }

  private notify(id: string, deleted = false, queue = false, record?: RecordAppend) {
    this.events.dispatchEvent(new CustomEvent('change', { detail: { id, deleted, queue, record } }));
  }

  list(workspaceId?: string | null) {
    return this.state.sessions
      .filter((entry) => workspaceId === undefined || entry.workspaceId === workspaceId)
      .map((entry) => ({ ...entry }));
  }

  get(id: string) {
    const entry = this.state.sessions.find((entry) => entry.id === id);
    return entry && { ...entry };
  }

  runScope(id: string): ScopeKey | undefined {
    const record = this.get(id);
    if (!record) return;
    let key = this.runtimeScopes.get(id);
    if (!key) {
      const standing = createScopeKey(
        record.parentId
          ? this.runScope(record.parentId)
          : record.workspaceId
            ? this.workspaceService()?.scope(record.workspaceId)
            : undefined,
      );
      this.runtimeScopes.set(id, (key = createScopeKey(standing)));
    }
    return key;
  }

  /** Rebind the domain's existing roots when the optional workspace provider changes. */
  bindWorkspaces(workspaces?: WorkspacePort) {
    for (const { id, parentId, workspaceId } of this.state.sessions) {
      if (parentId) continue;
      const run = this.runtimeScopes.get(id);
      const key = run && scopeParentOf(run);
      if (key) setScopeParent(key, workspaceId ? workspaces?.scope(workspaceId) : undefined);
    }
  }

  scope(id: string) {
    const key = this.runScope(id);
    return key && scopeParentOf(key);
  }

  assertAvailable(id?: string, workspaceId = id && this.get(id)?.workspaceId) {
    if (this.closing) throw new DomainError('unavailable', 'Agent service is unavailable during shutdown');
    if (id && this.deleting.has(id)) throw new DomainError('conflict', 'Conversation is being deleted');
    if (workspaceId) this.workspaceService()?.assertAvailable(workspaceId);
  }

  beforeDelete(handler: Participant) {
    this.participants.add(handler);
    return () => {
      this.participants.delete(handler);
    };
  }

  /** Stop accepting work; existing writers remain available while runs drain. */
  async close() {
    this.closing = true;
    await Promise.allSettled(this.deletions);
  }

  dispose() {
    this.bindWorkspaces();
    this.closing = true;
    for (const log of this.logs.values()) log.close();
    this.logs.clear();
  }

  create({
    parentId = null,
    title,
    workspaceId,
    permission = 'standard',
  }: Parameters<SessionStore['create']>[0] = {}) {
    const parent = parentId ? this.get(parentId) : undefined;
    if (parentId && !parent) throw new DomainError('not_found', 'Parent conversation not found');
    if (parent && workspaceId !== undefined && workspaceId !== parent.workspaceId)
      throw new DomainError('invalid_input', 'Conversation workspace does not match its parent');
    const targetWorkspace = parent
      ? parent.workspaceId
      : workspaceId === undefined
        ? (this.workspaceService()?.defaultId ?? null)
        : workspaceId;
    this.assertAvailable(parentId ?? undefined, targetWorkspace);
    if (targetWorkspace !== null) {
      const workspaces = this.workspaceService();
      if (!workspaces) throw new DomainError('unavailable', 'Workspace service unavailable');
      const workspace = workspaces.get(targetWorkspace);
      workspaces.resolveRoot(workspace.path, workspace.id);
    }
    const session: SessionRecord = {
      id: randomUUID(),
      title: title?.slice(0, 140) || 'New conversation',
      titleSource: title ? 'manual' : 'auto',
      workspaceId: targetWorkspace,
      parentId,
      createdAt: new Date().toISOString(),
      permission,
    };
    this.commit({ ...this.state, sessions: [...this.state.sessions, session] });
    this.events.dispatchEvent(new CustomEvent('membership', { detail: session.id }));
    this.notify(session.id);
    this.observe?.({ type: 'session-created', sessionId: session.id }, this.runScope(session.id));
    return { ...session };
  }

  private replace(id: string, patch: Partial<SessionRecord>) {
    const item = this.get(id);
    if (!item) throw new DomainError('not_found', 'Conversation not found');
    const updated = { ...item, ...patch };
    this.commit({
      ...this.state,
      sessions: this.state.sessions.map((entry) => (entry.id === id ? updated : entry)),
    });
    this.notify(id);
    return { ...updated };
  }

  setPermission(id: string, permission: ConversationPermission) {
    this.assertAvailable(id);
    return this.replace(id, { permission });
  }

  rename(id: string, title: string, source: SessionRecord['titleSource'] = 'manual') {
    this.assertAvailable(id);
    const record = this.get(id);
    if (!record) throw new DomainError('not_found', 'Conversation not found');
    if (source === 'auto' && (record.titleSource === 'manual' || record.title !== 'New conversation'))
      return record;
    return this.replace(id, { title, titleSource: source });
  }

  private nativeFile(record: Pick<SessionRecord, 'id' | 'workspaceId'>) {
    return nativeFile(this.paths, record);
  }

  prepareInput(id: string, text: unknown, attachments?: Attachment[]) {
    this.assertAvailable(id);
    const { files, ...prepared } = prepareInput(text, attachments);
    if (files.length) {
      const record = this.get(id);
      if (!record) throw new DomainError('not_found', 'Conversation not found');
      const directory = attachmentDirectory(this.nativeFile(record), true)!;
      storeAttachments(directory, files);
      syncDirectory(directory);
      syncDirectory(dirname(directory));
      syncDirectory(dirname(dirname(directory)));
    }
    return prepared;
  }

  attachmentDirectory(id: string) {
    this.assertAvailable(id);
    const record = this.get(id);
    if (!record) throw new DomainError('not_found', 'Conversation not found');
    return attachmentDirectory(this.nativeFile(record));
  }

  readAttachment(id: string, attachmentId: string) {
    const directory = this.attachmentDirectory(id);
    return directory ? readAttachmentFile(directory, attachmentId) : undefined;
  }

  runSummary(id: string) {
    const run = this.latestRuns.get(id);
    return run && structuredClone(run);
  }

  logError(id: string) {
    return this.logErrors.get(id);
  }

  diagnostics() {
    return [...this.logErrors].map(([id, message]) => ({ id, message }));
  }

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
      if (entry.type === 'task') this.taskOwners.set(entry.task.id, id);
      const run = runFromEntry(id, entry);
      if (run) this.latestRuns.set(id, run);
      const inbox = entry.type.startsWith('inbox-');
      if (inbox || (entry.type === 'message' && entry.inboxId)) this.notify(id, false, true);
      if (!inbox && entry.type !== 'model-request' && entry.type !== 'tool-schema')
        this.notify(
          id,
          false,
          false,
          entry.type === 'plugin-record'
            ? { leafId: entry.id, display: structuredClone(displayRecord(entry)) }
            : undefined,
        );
    };
    let log: SessionLog | undefined;
    try {
      const file = nativeFile(this.paths, record, mode === 'write');
      if (mode === 'recover') lstatSync(file);
      log = new SessionLog(
        file,
        id,
        record.createdAt,
        writable ? onChange : undefined,
        !writable,
        (error) => {
          if (this.logs.get(id) === log) this.logs.delete(id);
          this.latestRuns.delete(id);
          this.fault(id, error);
        },
      );
      if (writable) {
        log.recover();
        for (const entry of log.entries()) if (entry.type === 'task') this.taskOwners.set(entry.task.id, id);
        const run = log.latestRun;
        if (run) this.latestRuns.set(id, run);
        else this.latestRuns.delete(id);
        if (this.logErrors.delete(id)) this.notify(id);
      }
      return log;
    } catch (error) {
      log?.close();
      if (mode !== 'write' && missing(error)) return;
      this.fault(id, error instanceof Error ? (error.cause ?? error) : error);
      throw new DomainError(
        'unavailable',
        'This conversation log could not be opened. See session diagnostics.',
        { cause: error },
      );
    }
  }

  task(id: string): Pick<TaskOptions, 'owner' | 'commit'> {
    this.assertAvailable(id);
    // Open/recover the writer before the scheduler marks the task active.
    this.log(id);
    return {
      owner: 'session:' + id,
      commit: (record) => {
        if (!record.task.startedAt && record.task.state === 'queued') this.assertAvailable(id);
        this.log(id).append({ type: 'task', ...record });
      },
    };
  }

  taskHistory(id: string) {
    const owner = this.taskOwners.get(id);
    if (owner) return this.inspectLog(owner, (log) => readTaskHistory(log.entries(), id));
  }

  log(id: string): SessionLogPort {
    return this.writer(id).port;
  }

  private writer(id: string) {
    const existing = this.logs.get(id);
    if (existing) {
      this.logs.delete(id);
      this.logs.set(id, existing);
      return existing;
    }
    this.assertAvailable(id);
    const record = this.get(id);
    if (!record) throw new DomainError('not_found', 'Conversation not found');
    if (this.logErrors.has(id) && [...this.participants].some(({ busy }) => busy?.(id)))
      throw new DomainError('unavailable', 'The conversation must finish before reopening its log');
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

  revisionTarget(id: string, sourceEntryId: string, expectedLeafId: string | null) {
    this.assertAvailable(id);
    if (
      typeof sourceEntryId !== 'string' ||
      !/^[a-f0-9]{8,64}$/i.test(sourceEntryId) ||
      (expectedLeafId !== null &&
        (typeof expectedLeafId !== 'string' || !/^[a-f0-9]{8,64}$/i.test(expectedLeafId)))
    )
      throw new DomainError('invalid_input', 'Invalid revision target');
    const target = this.inspectLog(
      id,
      (log) => {
        if (log.projection().leafId !== expectedLeafId)
          throw new DomainError('conflict', 'Conversation changed; refresh before editing');
        const source = log.branch().find((entry) => entry.id === sourceEntryId);
        if (source?.type !== 'message' || source.message.role !== 'user') return;
        const { attachments } = userContent(source.message.content, source.presentation);
        return {
          parentId: source.parentId,
          images: attachments.flatMap(({ name, mimeType, data }) => (data ? [{ name, mimeType, data }] : [])),
          textFiles: attachments
            .filter((file) => !file.id && !imageMimeType.test(file.mimeType))
            .map(({ name }) => name),
        };
      },
      true,
    );
    if (!target) throw new DomainError('invalid_input', 'User message not found on active branch');
    return target;
  }

  inspectLog<T>(
    id: string,
    read: (
      log: Pick<SessionLogPort, 'entries' | 'branch' | 'projection' | 'queue' | 'inbox' | 'inboxPaused'>,
    ) => T,
    strict = false,
  ): T | undefined {
    const existing = this.logs.get(id);
    if (existing) return read(existing.port);
    const record = this.get(id);
    if (!record) return;
    try {
      const log = this.openLog(record, 'read');
      if (!log) return;
      try {
        return read(log.port);
      } finally {
        log.close();
      }
    } catch (error) {
      if (!strict && error instanceof DomainError && error.code === 'unavailable') return;
      throw error;
    }
  }

  history(id: string): ReturnType<SessionStore['history']> {
    this.assertAvailable(id);
    if (!this.get(id)) throw new DomainError('not_found', 'Conversation not found');
    return (
      this.inspectLog(
        id,
        (log) => {
          const { timeline, leafId, model } = log.projection();
          return { timeline, leafId, model };
        },
        true,
      ) ?? { timeline: [], leafId: null }
    );
  }

  records<Data = unknown>(id: string, owner: RecordOwner): SessionRecords<Data> {
    this.assertAvailable(id);
    if (!this.get(id)) throw new DomainError('not_found', 'Conversation not found');
    return {
      list: () =>
        this.inspectLog(
          id,
          (log) =>
            log.branch().flatMap((entry) => {
              return entry.type === 'plugin-record' &&
                entry.owner.instanceId === owner.instanceId &&
                entry.owner.pluginId === owner.pluginId
                ? [{ id: entry.id, timestamp: entry.timestamp, data: structuredClone(entry.data) as Data }]
                : [];
            }),
          true,
        ) ?? [],
      append: async (data, display) => {
        this.assertAvailable(id);
        return this.log(id).append({ type: 'plugin-record', owner, data, display }).id;
      },
    };
  }

  workspacePath(id: string) {
    const item = this.get(id);
    if (!item) throw new DomainError('not_found', 'Conversation not found');
    if (item.workspaceId === null) return;
    const workspaces = this.workspaceService();
    if (!workspaces) return;
    const workspace = workspaces.get(item.workspaceId);
    return workspaces.resolveRoot(workspace.path, workspace.id);
  }

  depth(id: string) {
    let record = this.get(id);
    if (!record) throw new DomainError('not_found', 'Conversation not found');
    const ancestors = new Set([id]);
    while (record.parentId) {
      if (ancestors.has(record.parentId)) throw new Error('Invalid conversation ancestry');
      ancestors.add(record.parentId);
      record = this.get(record.parentId);
      if (!record) throw new DomainError('not_found', 'Parent conversation not found');
    }
    return ancestors.size - 1;
  }

  descendants(ids: string[]) {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !this.get(id)))
      throw new DomainError('invalid_input', 'Unknown conversation');
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
    try {
      return lstatSync(nativeFile(this.paths, record, false)).mtime.toISOString();
    } catch {
      return record.createdAt;
    }
  }

  export(ids: string[]) {
    return this.descendants(ids).map((id) => {
      this.assertAvailable(id);
      if ([...this.participants].some(({ busy }) => busy?.(id)))
        throw new DomainError('invalid_input', 'Stop active conversations before exporting them');
      const record = this.get(id);
      if (!record) throw new Error('Conversation disappeared during export');
      this.nativeFile(record);
      const log = this.writer(id);
      const attachments: Record<string, string> = {};
      for (const entry of log.entries()) {
        const input =
          entry.type === 'message'
            ? entry.presentation
            : entry.type === 'inbox-enqueued'
              ? entry.item.input
              : undefined;
        for (const file of input?.attachments ?? []) {
          if (!file.id || Object.hasOwn(attachments, file.id)) continue;
          const bytes = this.readAttachment(id, file.id);
          if (!bytes) throw new Error('Missing uploaded attachment: ' + file.name);
          attachments[file.id] = bytes.toString('base64');
        }
      }
      return { ...record, log: log.serialize(), attachments };
    });
  }

  delete(ids: string[]) {
    this.assertAvailable();
    return this.deleteOwnedTree(ids);
  }

  /** Workspace removal has already reserved its catalog entry. */
  removeWorkspaceSessions(workspaceId: string) {
    return this.deleteOwnedTree(this.list(workspaceId).map(({ id }) => id));
  }

  private deleteOwnedTree(ids: string[]) {
    const operation = this.deleteTree(ids).finally(() => this.deletions.delete(operation));
    this.deletions.add(operation);
    return operation;
  }

  private async deleteTree(ids: string[]) {
    const all = this.descendants(ids);
    if (all.some((id) => this.deleting.has(id)))
      throw new DomainError('conflict', 'Conversation is being deleted');
    for (const id of all) this.deleting.add(id);
    try {
      const participants = [...this.participants];
      await Promise.all(participants.map(({ quiesce }) => quiesce(all)));
      const operation = this.pendingDeletion.then(() => this.deleteRecords(all));
      this.pendingDeletion = operation.catch(() => {});
      await operation;
      return all;
    } finally {
      for (const id of all) this.deleting.delete(id);
    }
  }

  private async deleteRecords(all: string[]) {
    await this.recoverDeletion();
    const chosen = new Set(all);
    const pendingDelete = all.map((id) => {
      const record = this.get(id);
      if (!record) throw new Error('Conversation disappeared during deletion');
      attachmentDirectory(this.nativeFile(record));
      this.logs.get(id)?.close();
      this.logs.delete(id);
      this.logErrors.delete(id);
      this.latestRuns.delete(id);
      return { id, workspaceId: record.workspaceId };
    });
    if (all.length) {
      const locations = all.map((id) => ({ id, key: this.runScope(id) }));
      this.commit({
        ...this.state,
        sessions: this.state.sessions.filter((entry) => !chosen.has(entry.id)),
        pendingDelete,
      });
      for (const [taskId, owner] of this.taskOwners) if (chosen.has(owner)) this.taskOwners.delete(taskId);
      await this.recoverDeletion();
      for (const { id, key } of locations) {
        this.events.dispatchEvent(new CustomEvent('membership', { detail: id }));
        this.notify(id, true);
        this.observe?.({ type: 'session-deleted', sessionId: id }, key);
        this.runtimeScopes.delete(id);
      }
    }
  }

  async recoverDeletion() {
    const pending = this.state.pendingDelete;
    if (!pending?.length) return;
    await this.forgetScopes?.(pending.map<ScopeAddress>(({ id }) => `session:${id}`));
    for (const entry of pending) {
      if (this.state.sessions.some((record) => record.id === entry.id))
        throw new Error('Deletion journal includes an active conversation');
      const file = this.nativeFile(entry);
      deleteAttachments(file);
      try {
        unlinkSync(file);
      } catch (error) {
        if (!missing(error)) throw error;
      }
      syncDirectory(dirname(file));
    }
    this.commit({ sessions: this.state.sessions });
  }
}
