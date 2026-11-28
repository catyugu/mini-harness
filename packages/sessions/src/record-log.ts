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
  readSync,
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

export interface RecordAddress {
  id: string;
  offset: number;
  length: number;
}

function checkFile(handle: number, file: string, expectedLength?: number) {
  const descriptor = fstatSync(handle),
    path = lstatSync(file);
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

function parseRecord(line: string) {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line);
  } catch {
    throw new Error('Corrupt session log record');
  }
  const { checksum, ...entry } = record;
  if (checksum !== digest(entry)) throw new Error('Corrupt session log checksum');
  return entry;
}

export function readRecordAt<Event extends { type: string }>(
  file: string,
  address: RecordAddress,
): LogEntry<Event> {
  const handle = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    checkFile(handle, file);
    const bytes = Buffer.alloc(address.length);
    for (let offset = 0; offset < bytes.length; ) {
      const read = readSync(handle, bytes, offset, bytes.length - offset, address.offset + offset);
      if (read === 0) throw new Error('Indexed session record is incomplete');
      offset += read;
    }
    const entry = parseRecord(bytes.toString('utf8'));
    if (entry.id !== address.id) throw new Error('Indexed session record has changed');
    return entry as LogEntry<Event>;
  } finally {
    closeSync(handle);
  }
}

/** Owns durable record identity, ordering, branch indexing and file integrity. */
export abstract class RecordLog<Event extends { type: string }> {
  private handle!: number;
  protected readonly records: LogEntry<Event>[] = [];
  protected readonly byId = new Map<string, LogEntry<Event>>();
  private currentLeafId: string | null = null;
  private header!: LogHeader;
  private closed = false;
  private length = 0;

  protected abstract validateRecord(entry: LogEntry<Event>, recovering: boolean): void;
  protected abstract recordAdded(entry: LogEntry<Event>, address: RecordAddress): void;
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
      checkFile(this.handle, this.file);
      const bytes = readFileSync(this.handle);
      this.length = bytes.length;
      checkFile(this.handle, this.file, this.length);
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

  private load(bytes: Buffer) {
    const end = bytes.lastIndexOf(10) + 1;
    if (!end) throw new Error('Invalid session log header');
    const first = bytes.indexOf(10);
    const header = JSON.parse(bytes.toString('utf8', 0, first));
    if (
      header?.type !== 'session' ||
      header.version !== 1 ||
      header.id !== this.sessionId ||
      typeof header.createdAt !== 'string'
    )
      throw new Error('Invalid session log header');
    this.header = header;
    for (let offset = first + 1; offset < end; ) {
      const newline = bytes.indexOf(10, offset);
      const entry = parseRecord(bytes.toString('utf8', offset, newline)) as LogEntry<Event>;
      this.validateEntry(entry, true);
      this.remember(entry, offset, newline - offset);
      offset = newline + 1;
    }
    // An incomplete, unacknowledged final write can be discarded; complete corrupt records cannot.
    if (!this.readOnly && end < bytes.length) {
      checkFile(this.handle, this.file, bytes.length);
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

  private remember(entry: LogEntry<Event>, offset: number, length: number) {
    this.records.push(entry);
    this.byId.set(entry.id, entry);
    if (this.advancesBranch(entry)) this.currentLeafId = entry.id;
    this.recordAdded(entry, { id: entry.id, offset, length });
  }

  private write(value: unknown) {
    checkFile(this.handle, this.file, this.length);
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    for (let offset = 0; offset < bytes.length; ) {
      const written = writeSync(this.handle, bytes, offset, bytes.length - offset, this.length + offset);
      if (written <= 0) throw new Error('Session log write made no progress');
      offset += written;
    }
    fsyncSync(this.handle);
    this.length += bytes.length;
    return bytes.length - 1;
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
    const offset = this.length;
    let length: number;
    try {
      length = this.write({ ...entry, checksum: digest(entry) });
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
    this.remember(entry, offset, length);
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
    checkFile(this.handle, this.file, this.length);
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
