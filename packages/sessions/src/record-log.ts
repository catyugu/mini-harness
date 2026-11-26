import { DomainError } from '@mini-harness/platform/errors';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

export type LogEntry<Event extends { type: string }> = Event & {
  version: 1;
  seq: number;
  id: string;
  parentId: string | null;
  timestamp: string;
};

export interface LogHeader {
  type: 'session';
  version: 1;
  id: string;
  createdAt: string;
  importedFrom?: string;
}
export const entryId = /^[a-f0-9]{8,64}$/i;
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Owns durable record identity, ordering, branch indexing and file integrity. */
export abstract class RecordLog<Event extends { type: string }> {
  private handle!: number;
  protected readonly records: LogEntry<Event>[] = [];
  protected readonly byId = new Map<string, LogEntry<Event>>();
  private currentLeafId: string | null = null;
  private header!: LogHeader;
  private closed = false;
  private length = 0;

  protected abstract decodeRecord(record: Record<string, unknown>): LogEntry<Event>;
  protected abstract validateRecord(entry: LogEntry<Event>, recovering: boolean): void;
  protected abstract recordAdded(entry: LogEntry<Event>): void;
  protected abstract advancesBranch(entry: LogEntry<Event>): boolean;

  constructor(
    readonly file: string,
    readonly sessionId: string,
    private readonly changed?: (entry: LogEntry<Event>) => void,
    private readonly readOnly = false,
    private readonly writeFailed?: (error: unknown) => void,
  ) {}

  protected open(createdAt: string) {
    // Windows append handles lack FILE_WRITE_DATA and cannot truncate a torn tail.
    // A single validated writer uses explicit positions at its verified end instead.
    this.header = { type: 'session', version: 1, id: this.sessionId, createdAt };
    const flags = this.readOnly ? constants.O_RDONLY : constants.O_RDWR | constants.O_CREAT;
    this.handle = openSync(this.file, flags | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      this.checkFile();
      const bytes = readFileSync(this.handle);
      this.length = bytes.length;
      this.checkFile(this.length);
      if (!bytes.length && !this.readOnly) {
        this.write(this.header);
        syncDirectory(dirname(this.file));
      } else this.load(bytes);
    } catch (error) {
      closeSync(this.handle);
      this.closed = true;
      throw error;
    }
  }

  private checkFile(expectedLength?: number) {
    const descriptor = fstatSync(this.handle),
      path = lstatSync(this.file);
    if (
      !descriptor.isFile() ||
      descriptor.nlink !== 1 ||
      path.isSymbolicLink() ||
      descriptor.dev !== path.dev ||
      descriptor.ino !== path.ino
    )
      throw new Error('Session file outside managed storage or replaced while open');
    if (expectedLength !== undefined && descriptor.size !== expectedLength)
      throw new Error('Session file size changed outside its writer');
  }

  private load(bytes: Buffer) {
    const end = bytes.lastIndexOf(10) + 1;
    if (!end) throw new Error('Invalid session log header');
    const lines = bytes.subarray(0, end).toString('utf8').split('\n');
    lines.pop();
    const first = lines.shift();
    if (!first) throw new Error('Missing session log header');
    const header = JSON.parse(first);
    if (
      header?.type !== 'session' ||
      header.version !== 1 ||
      header.id !== this.sessionId ||
      typeof header.createdAt !== 'string'
    )
      throw new Error('Invalid session log header');
    this.header = header;
    for (const line of lines) {
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line);
      } catch {
        throw new Error('Corrupt session log record');
      }
      const { checksum, ...entry } = record;
      if (checksum !== digest(entry)) throw new Error('Corrupt session log checksum');
      const normalized = this.decodeRecord(entry);
      this.validateEntry(normalized, true);
      this.remember(normalized);
    }
    // An incomplete, unacknowledged final write can be discarded; complete corrupt records cannot.
    if (!this.readOnly && end < bytes.length) {
      this.checkFile(bytes.length);
      ftruncateSync(this.handle, end);
      fsyncSync(this.handle);
      this.length = end;
    }
  }

  private validateEntry(entry: LogEntry<Event>, recovering = false) {
    if (
      entry.version !== 1 ||
      entry.seq !== this.records.length + 1 ||
      !entryId.test(entry.id) ||
      this.byId.has(entry.id) ||
      (entry.parentId !== null && !this.byId.has(entry.parentId)) ||
      typeof entry.timestamp !== 'string' ||
      !Number.isFinite(Date.parse(entry.timestamp))
    )
      throw new Error('Invalid session log sequence or ancestry');
    this.validateRecord(entry, recovering);
  }

  private remember(entry: LogEntry<Event>) {
    this.records.push(entry);
    this.byId.set(entry.id, entry);
    if (this.advancesBranch(entry)) this.currentLeafId = entry.id;
    this.recordAdded(entry);
  }

  private write(value: unknown) {
    this.checkFile(this.length);
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    for (let offset = 0; offset < bytes.length; ) {
      const written = writeSync(this.handle, bytes, offset, bytes.length - offset, this.length + offset);
      if (written <= 0) throw new Error('Session log write made no progress');
      offset += written;
    }
    fsyncSync(this.handle);
    this.length += bytes.length;
  }

  protected get leafId() {
    return this.currentLeafId;
  }

  entries(after = 0) {
    return structuredClone(this.records.slice(after));
  }

  protected branchEntries(leafId: string | null = this.leafId) {
    if (leafId !== null && !this.byId.has(leafId)) throw new Error('Unknown session branch');
    const entries: LogEntry<Event>[] = [];
    for (
      let entry = leafId && this.byId.get(leafId);
      entry;
      entry = entry.parentId && this.byId.get(entry.parentId)
    )
      entries.push(entry);
    return entries.reverse();
  }

  branch(leafId: string | null = this.leafId) {
    return structuredClone(this.branchEntries(leafId));
  }

  protected persist(event: Event, parentId: string | null, expectedLeafId?: string | null) {
    if (this.closed) throw new Error('Session log is closed');
    if (this.readOnly) throw new Error('Session log is read-only');
    if (expectedLeafId !== undefined && expectedLeafId !== this.leafId)
      throw new DomainError('conflict', 'Conversation changed; refresh before editing');
    const value = JSON.parse(JSON.stringify(event)) as Event;
    const entry = {
      ...value,
      version: 1,
      seq: this.records.length + 1,
      id: randomBytes(16).toString('hex'),
      parentId,
      timestamp: new Date().toISOString(),
    } as LogEntry<Event>;
    this.validateEntry(entry);
    try {
      this.write({ ...entry, checksum: digest(entry) });
    } catch (error) {
      // The disk may contain a partial record. Prevent a later append from masking the damage.
      try {
        this.close();
      } finally {
        this.writeFailed?.(error);
      }
      if (!this.writeFailed) throw error;
      throw new DomainError('unavailable', 'Could not write conversation log. See session diagnostics.', {
        cause: error,
      });
    }
    this.remember(entry);
    this.changed?.(entry);
    return structuredClone(entry);
  }

  append(event: Event, expectedLeafId?: string | null) {
    return this.persist(event, this.leafId, expectedLeafId);
  }

  revise(event: Event, parentId: string | null, expectedLeafId: string | null) {
    return this.persist(event, parentId, expectedLeafId);
  }

  serialize() {
    if (this.closed) throw new Error('Session log is closed');
    this.checkFile(this.length);
    return encodeLog(this.header, this.records);
  }

  close() {
    if (!this.closed) {
      this.closed = true;
      closeSync(this.handle);
    }
  }
}

export function syncDirectory(path: string) {
  if (process.platform === 'win32') return;
  const handle = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

/** Renders a complete log document for exports; live appends go through RecordLog. */
export function encodeLog(header: LogHeader, entries: LogEntry<{ type: string }>[]) {
  return (
    [
      JSON.stringify(header),
      ...entries.map((entry) => JSON.stringify({ ...entry, checksum: digest(entry) })),
    ].join('\n') + '\n'
  );
}
