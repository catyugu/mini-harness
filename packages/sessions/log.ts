import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { validateNativeMessage, validateRequestSnapshot } from '@mini-harness/contracts/llm';
import type { SessionEntry, SessionEvent, SessionLogPort, SessionProjection } from '@mini-harness/contracts/session-log';
import { projectLog } from './projection.js';

export interface SessionHeader { type: 'session'; version: 1; id: string; createdAt: string; importedFrom?: string }
const entryId = /^[a-f0-9]{8,64}$/i;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** A single host owns the writer. Every acknowledged record is newline framed and fsynced. */
export class SessionLog implements SessionLogPort {
  private handle: number;
  private readonly records: SessionEntry[] = [];
  private readonly byId = new Map<string, SessionEntry>();
  private readonly inboxIds = new Set<string>();
  private readonly pendingInbox = new Set<string>();
  private currentLeafId: string | null = null;
  private cachedProjection?: SessionProjection;
  private header: SessionHeader;
  private closed = false;
  private length = 0;

  constructor(readonly file: string, readonly sessionId: string, createdAt = new Date().toISOString(),
    private readonly changed?: () => void) {
    // Windows append handles lack FILE_WRITE_DATA and cannot truncate a torn tail.
    // A single validated writer uses explicit positions at its verified end instead.
    this.handle = openSync(file, constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      this.checkFile();
      const bytes = readFileSync(this.handle);
      this.length = bytes.length;
      this.checkFile(this.length);
      if (!bytes.length) {
        this.header = { type: 'session', version: 1, id: sessionId, createdAt };
        this.write(this.header);
        syncDirectory(dirname(file));
      } else this.load(bytes);
    } catch (error) { closeSync(this.handle); this.closed = true; throw error; }
  }

  private checkFile(expectedLength?: number) {
    const descriptor = fstatSync(this.handle), path = lstatSync(this.file);
    if (!descriptor.isFile() || descriptor.nlink !== 1 || path.isSymbolicLink() ||
        descriptor.dev !== path.dev || descriptor.ino !== path.ino)
      throw new Error('Session file outside managed storage or replaced while open');
    if (expectedLength !== undefined && descriptor.size !== expectedLength)
      throw new Error('Session file size changed outside its writer');
  }

  private load(bytes: Buffer) {
    const end = bytes.lastIndexOf(10) + 1;
    if (!end) throw new Error('Invalid session log header');
    const lines = bytes.subarray(0, end).toString('utf8').split('\n');
    lines.pop();
    const header = JSON.parse(lines.shift());
    if (header?.type !== 'session' || header.version !== 1 || header.id !== this.sessionId ||
        typeof header.createdAt !== 'string') throw new Error('Invalid session log header');
    this.header = header;
    for (const line of lines) {
      let record: SessionEntry & { checksum: string };
      try { record = JSON.parse(line); }
      catch { throw new Error('Corrupt session log record'); }
      const { checksum, ...entry } = record;
      if (checksum !== digest(entry)) throw new Error('Corrupt session log checksum');
      this.validateEntry(entry as SessionEntry);
      this.remember(entry as SessionEntry);
    }
    // An incomplete, unacknowledged final write can be discarded; complete corrupt records cannot.
    if (end < bytes.length) {
      this.checkFile(bytes.length);
      ftruncateSync(this.handle, end);
      fsyncSync(this.handle);
      this.length = end;
    }
  }

  private validateEntry(entry: SessionEntry) {
    if (entry.version !== 1 || entry.seq !== this.records.length + 1 || !entryId.test(entry.id) ||
        this.byId.has(entry.id) || (entry.parentId !== null && !this.byId.has(entry.parentId)) ||
        typeof entry.timestamp !== 'string' || !Number.isFinite(Date.parse(entry.timestamp)))
      throw new Error('Invalid session log sequence or ancestry');
    validateEvent(entry);
    if (entry.type === 'inbox-enqueued' && this.inboxIds.has(entry.item.id)) throw new Error('Inbox delivery ID already exists');
    if (entry.type === 'message' && entry.inboxId &&
        (entry.message.role !== 'user' || !this.pendingInbox.has(entry.inboxId))) throw new Error('Inbox input is not pending');
    if (entry.type === 'run' && entry.run.sessionId !== this.sessionId) throw new Error('Session run belongs to another conversation');
    if (entry.type === 'compaction' && entry.keepFromId !== null &&
        !this.branch(entry.parentId).some((item) => item.id === entry.keepFromId && item.type === 'message'))
      throw new Error('Compaction boundary is not a message on the selected branch');
    if (entry.type === 'context-edit') {
      const target = this.branch(entry.parentId).find((item) => item.id === entry.targetId && item.type === 'message');
      if (target?.type !== 'message') throw new Error('Context edit target is not a message on the selected branch');
      if (entry.replacement !== null) validateNativeMessage({ ...target.message, content: entry.replacement } as typeof target.message);
    }
  }

  private remember(entry: SessionEntry) {
    this.cachedProjection = undefined;
    this.records.push(entry);
    this.byId.set(entry.id, entry);
    if (!operational(entry)) this.currentLeafId = entry.id;
    if (entry.type === 'inbox-enqueued') { this.inboxIds.add(entry.item.id); this.pendingInbox.add(entry.item.id); }
    if (entry.type === 'inbox-consumed' || entry.type === 'inbox-cancelled') for (const id of entry.ids) this.pendingInbox.delete(id);
    if (entry.type === 'message' && entry.inboxId) this.pendingInbox.delete(entry.inboxId);
  }

  private write(value: unknown) {
    this.checkFile(this.length);
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    for (let offset = 0; offset < bytes.length;) {
      const written = writeSync(this.handle, bytes, offset, bytes.length - offset, this.length + offset);
      if (written <= 0) throw new Error('Session log write made no progress');
      offset += written;
    }
    fsyncSync(this.handle);
    this.length += bytes.length;
  }

  private get leafId() { return this.currentLeafId; }

  entries() { return structuredClone(this.records); }

  private branchEntries(leafId: string | null = this.leafId) {
    if (leafId !== null && !this.byId.has(leafId)) throw new Error('Unknown session branch');
    const entries: SessionEntry[] = [];
    for (let entry = leafId && this.byId.get(leafId); entry; entry = entry.parentId && this.byId.get(entry.parentId))
      entries.push(entry);
    return entries.reverse();
  }

  branch(leafId: string | null = this.leafId) { return structuredClone(this.branchEntries(leafId)); }

  private persist(event: SessionEvent, parentId: string | null, expectedLeafId?: string | null) {
    if (this.closed) throw new Error('Session log is closed');
    if (expectedLeafId !== undefined && expectedLeafId !== this.leafId)
      throw new Error('Conversation changed; refresh before editing');
    this.checkFile();
    const value = JSON.parse(JSON.stringify(event)) as SessionEvent;
    const entry = { ...value, version: 1, seq: this.records.length + 1, id: randomBytes(16).toString('hex'),
      parentId, timestamp: new Date().toISOString() } as SessionEntry;
    this.validateEntry(entry);
    try { this.write({ ...entry, checksum: digest(entry) }); }
    catch (error) {
      // The disk may contain a partial record. Prevent a later append from masking the damage.
      this.close();
      throw error;
    }
    this.remember(entry);
    this.changed?.();
    return structuredClone(entry);
  }

  append(event: SessionEvent, expectedLeafId?: string | null) { return this.persist(event, this.leafId, expectedLeafId); }

  select(leafId: string | null, expectedLeafId?: string | null) {
    if (leafId !== null && !this.byId.has(leafId)) throw new Error('Unknown session branch');
    if (leafId !== null && operational(this.byId.get(leafId))) throw new Error('Operational records are not conversation branches');
    return this.persist({ type: 'branch' }, leafId, expectedLeafId);
  }

  projection(leafId?: string | null) {
    if (leafId !== undefined) return structuredClone(projectLog(this.records, this.branchEntries(leafId)));
    this.cachedProjection ??= projectLog(this.records, this.branchEntries());
    return structuredClone(this.cachedProjection);
  }

  serialize() {
    if (this.closed) throw new Error('Session log is closed');
    this.checkFile(this.length);
    return encodeLog(this.header, this.records);
  }

  /** Startup marks interrupted work explicitly; tools and queued inputs are never replayed automatically. */
  recover() {
    const state = this.projection();
    if (state.run?.state === 'running' || state.run?.state === 'queued')
      this.append({ type: 'run', run: { ...state.run, state: 'interrupted', finishedAt: new Date().toISOString(),
        error: 'The previous process stopped before this run finished' } });
  }

  close() {
    if (!this.closed) { this.closed = true; closeSync(this.handle); }
  }
}

function validateEvent(event: SessionEvent) {
  switch (event.type) {
    case 'message':
      validateNativeMessage(event.message);
      return;
    case 'model-request':
      validateRequestSnapshot(event.request);
      return;
    case 'tool-execution':
      validateNativeMessage(event.result);
      if (event.result.role !== 'toolResult' || event.result.isError) throw new Error('Invalid completed tool execution');
      return;
    case 'model':
      if (typeof event.model?.provider !== 'string' || typeof event.model.id !== 'string') throw new Error('Invalid session model');
      return;
    case 'thinking':
      if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(event.level)) throw new Error('Invalid thinking level');
      return;
    case 'custom':
      if (typeof event.namespace !== 'string' || !event.namespace.length) throw new Error('Invalid session namespace');
      return;
    case 'compaction':
      if (typeof event.summary !== 'string' || (event.keepFromId !== null && !entryId.test(event.keepFromId))) throw new Error('Invalid session compaction');
      return;
    case 'context-edit':
      if (!entryId.test(event.targetId) || (event.replacement !== null && typeof event.replacement !== 'string' && !Array.isArray(event.replacement)))
        throw new Error('Invalid context edit');
      return;
    case 'inbox-enqueued':
      if (typeof event.item?.id !== 'string' || !event.item.id || !['steer', 'followUp'].includes(event.item.mode) ||
          typeof event.item.text !== 'string' || !Array.isArray(event.item.images)) throw new Error('Invalid session inbox item');
      return;
    case 'inbox-consumed': case 'inbox-cancelled':
      if (!Array.isArray(event.ids) || event.ids.some((id) => typeof id !== 'string')) throw new Error('Invalid session inbox acknowledgement');
      return;
    case 'run':
      if (!event.run || typeof event.run.id !== 'string' || typeof event.run.sessionId !== 'string' ||
          !['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(event.run.state) ||
          !Number.isFinite(Date.parse(event.run.startedAt)) || !Number.isInteger(event.run.sequence) || event.run.sequence < 0)
        throw new Error('Invalid session run');
      return;
    case 'branch': return;
    default: throw new Error('Unknown session event');
  }
}

export function syncDirectory(path: string) {
  if (process.platform === 'win32') return;
  const handle = openSync(path, constants.O_RDONLY);
  try { fsyncSync(handle); } finally { closeSync(handle); }
}

/** Renders a complete log document for exports; live appends go through SessionLog. */
export function encodeLog(header: SessionHeader, entries: SessionEntry[]) {
  return [JSON.stringify(header), ...entries.map((entry) => JSON.stringify({ ...entry, checksum: digest(entry) }))].join('\n') + '\n';
}

function operational(entry: SessionEvent) { return entry.type === 'run' || entry.type === 'model-request' || entry.type === 'tool-execution' || entry.type.startsWith('inbox-'); }
