import { isThinkingLevel, type ToolSchema } from '@mini-harness/llm/vocabulary';
import { pluginIdPattern, isScopeAddress } from '@mini-harness/plugin-api/selection';
import { DomainError } from '@mini-harness/platform/errors';
import { isRunning, type RunInfo } from './shared/run-state.ts';
import { isDeepStrictEqual } from 'node:util';
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
import {
  RequestMessages,
  validateNativeMessage,
  validateRequestSnapshot,
  type ModelRequestSnapshot,
  type LlmRequest,
  type NativeMessage,
  type NativeToolMessage,
} from '@mini-harness/llm/api';
import type { InboxItem, MessagePatch, SessionEntry, SessionEvent, SessionLogPort, SessionProjection } from './log-api.ts';
import type { QueueEntry } from './shared/queue.ts';
import { projectLog, projectMessage } from './projection.ts';
import { applyContentDelta, contentDelta } from './content-delta.ts';

type StoredEntry =
  | SessionEntry
  | (Pick<SessionEntry, 'version' | 'seq' | 'id' | 'parentId' | 'timestamp'> & {
      type: 'custom';
      namespace: unknown;
      data: unknown;
    });

export interface SessionHeader {
  type: 'session';
  version: 1;
  id: string;
  createdAt: string;
  importedFrom?: string;
}
const entryId = /^[a-f0-9]{8,64}$/i;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Store only the divergent interval of a transformed model context. */
function messagePatch(base: NativeMessage[], actual: NativeMessage[]): MessagePatch | undefined {
  let start = 0;
  while (start < base.length && start < actual.length && isDeepStrictEqual(base[start], actual[start]))
    start++;
  if (start === base.length && start === actual.length) return;
  let endBase = base.length,
    endActual = actual.length;
  while (
    endBase > start &&
    endActual > start &&
    isDeepStrictEqual(base[endBase - 1], actual[endActual - 1])
  ) {
    endBase--;
    endActual--;
  }
  return { start, deleteCount: endBase - start, insert: actual.slice(start, endActual) };
}

/** A single host owns the writer. Every acknowledged record is newline framed and fsynced. */
export class SessionLog implements SessionLogPort {
  private handle: number;
  private readonly records: SessionEntry[] = [];
  private readonly byId = new Map<string, SessionEntry>();
  private readonly schemas = new Map<string, ToolSchema[]>();
  private readonly inboxIds = new Set<string>();
  private readonly pendingInbox = new Map<string, InboxItem>();
  private readonly inboxFailures: QueueEntry[] = [];
  private run?: RunInfo;
  private currentLeafId: string | null = null;
  private cachedProjection?: SessionProjection;
  private header: SessionHeader;
  private closed = false;
  private length = 0;

  constructor(
    readonly file: string,
    readonly sessionId: string,
    createdAt = new Date().toISOString(),
    private readonly changed?: (entry: SessionEntry) => void,
    private readonly readOnly = false,
    private readonly writeFailed?: (error: unknown) => void,
  ) {
    // Windows append handles lack FILE_WRITE_DATA and cannot truncate a torn tail.
    // A single validated writer uses explicit positions at its verified end instead.
    this.header = { type: 'session', version: 1, id: sessionId, createdAt };
    const flags = readOnly ? constants.O_RDONLY : constants.O_RDWR | constants.O_CREAT;
    this.handle = openSync(file, flags | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      this.checkFile();
      const bytes = readFileSync(this.handle);
      this.length = bytes.length;
      this.checkFile(this.length);
      if (!bytes.length && !readOnly) {
        this.write(this.header);
        syncDirectory(dirname(file));
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
    const recovery = { leaf: null as string | null, checker: new RequestMessages() };
    for (const line of lines) {
      let record: StoredEntry & { checksum: string };
      try {
        record = JSON.parse(line);
      } catch {
        throw new Error('Corrupt session log record');
      }
      const { checksum, ...entry } = record;
      if (checksum !== digest(entry)) throw new Error('Corrupt session log checksum');
      const normalized = storedEntry(entry);
      this.validateEntry(normalized, recovery);
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

  private validateEntry(entry: SessionEntry, recovery?: { leaf: string | null; checker: RequestMessages }) {
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
    validateEvent(entry);
    if (
      entry.type === 'tool-schema' &&
      digest(entry.tools) !== entry.hash
    )
      throw new Error('Tool schema digest does not match its content');
    if (entry.type === 'model-request') {
      if (!recovery || entry.request.messagesPatch !== undefined) this.materializeRequest(entry);
      else {
        validateRequestSnapshot(this.requestMetadata(entry));
        this.validateRecoveryContext(entry.parentId, recovery);
      }
    }
    if (entry.type === 'tool-accepted') {
      const raw = this.byId.get(entry.executionId);
      if (raw?.type !== 'tool-execution') throw new Error('Tool acceptance references a missing execution');
      const content = JSON.parse(applyContentDelta(JSON.stringify(raw.result.content), entry.contentDelta));
      validateNativeMessage({ ...raw.result, content });
      if (
        entry.parentId !== raw.parentId &&
        !this.branchEntries(entry.parentId).some((item) => item.id === raw.parentId)
      )
        throw new Error('Tool acceptance does not belong to the execution branch');
    }
    if (entry.type === 'inbox-enqueued' && this.inboxIds.has(entry.item.id))
      throw new Error('Inbox delivery ID already exists');
    if (entry.type === 'inbox-failed' && !this.pendingInbox.has(entry.inboxId))
      throw new Error('Inbox input is not pending');
    if (
      entry.type === 'message' &&
      entry.inboxId &&
      (entry.message.role !== 'user' || !this.pendingInbox.has(entry.inboxId))
    )
      throw new Error('Inbox input is not pending');
    if (entry.type === 'run' && entry.run.sessionId !== this.sessionId)
      throw new Error('Session run belongs to another conversation');
    if (
      entry.type === 'compaction' &&
      entry.keepFromId !== null &&
      !this.branch(entry.parentId).some((item) => item.id === entry.keepFromId && item.type === 'message')
    )
      throw new Error('Compaction boundary is not a message on the selected branch');
    if (entry.type === 'context-edit') {
      const target = this.branch(entry.parentId).find(
        (item) => item.id === entry.targetId && item.type === 'message',
      );
      if (target?.type !== 'message')
        throw new Error('Context edit target is not a message on the selected branch');
      if (entry.replacement !== null)
        validateNativeMessage({ ...target.message, content: entry.replacement } as typeof target.message);
    }
  }

  private remember(entry: SessionEntry) {
    this.cachedProjection = undefined;
    if (entry.type === 'run') this.run = entry.run;
    if (entry.type === 'tool-schema') this.schemas.set(entry.hash, entry.tools);
    this.records.push(entry);
    this.byId.set(entry.id, entry);
    if (!operational(entry)) this.currentLeafId = entry.id;
    if (entry.type === 'inbox-enqueued') {
      this.inboxIds.add(entry.item.id);
      this.pendingInbox.set(entry.item.id, entry.item);
    }
    if (entry.type === 'inbox-consumed' || entry.type === 'inbox-cancelled')
      for (const id of entry.ids) this.pendingInbox.delete(id);
    if (entry.type === 'inbox-failed') {
      const item = this.pendingInbox.get(entry.inboxId);
      if (item) {
        if (this.inboxFailures.length === 5) this.inboxFailures.shift();
        this.inboxFailures.push({ ...queueEntry(item), state: 'failed', reason: entry.reason });
        this.pendingInbox.delete(entry.inboxId);
      }
    }
    if (entry.type === 'message' && entry.inboxId) this.pendingInbox.delete(entry.inboxId);
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

  private get leafId() {
    return this.currentLeafId;
  }

  entries() {
    return structuredClone(this.records);
  }

  inbox() {
    return structuredClone([...this.pendingInbox.values()]);
  }

  queue() {
    return [...Array.from(this.pendingInbox.values(), queueEntry), ...structuredClone(this.inboxFailures)];
  }

  private branchEntries(leafId: string | null = this.leafId) {
    if (leafId !== null && !this.byId.has(leafId)) throw new Error('Unknown session branch');
    const entries: SessionEntry[] = [];
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

  private persist(event: SessionEvent, parentId: string | null, expectedLeafId?: string | null) {
    if (this.closed) throw new Error('Session log is closed');
    if (this.readOnly) throw new Error('Session log is read-only');
    if (expectedLeafId !== undefined && expectedLeafId !== this.leafId)
      throw new DomainError('conflict', 'Conversation changed; refresh before editing');
    const value = JSON.parse(JSON.stringify(event)) as SessionEvent;
    const entry = {
      ...value,
      version: 1,
      seq: this.records.length + 1,
      id: randomBytes(16).toString('hex'),
      parentId,
      timestamp: new Date().toISOString(),
    } as SessionEntry;
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

  append(event: SessionEvent, expectedLeafId?: string | null) {
    return this.persist(event, this.leafId, expectedLeafId);
  }

  revise(
    event: Extract<SessionEvent, { type: 'message' }>,
    parentId: string | null,
    expectedLeafId: string | null,
  ) {
    return this.persist(event, parentId, expectedLeafId);
  }

  projection(leafId?: string | null) {
    if (leafId !== undefined) return structuredClone(projectLog(this.records, this.branchEntries(leafId)));
    this.cachedProjection ??= projectLog(this.records, this.branchEntries());
    return structuredClone(this.cachedProjection);
  }

  recordRequest(snapshot: Omit<LlmRequest, 'signal'>) {
    const projected = this.projection();
    const { messages, tools, model, systemPrompt, thinkingLevel, maxTokens } = snapshot;
    const patch = messagePatch(projected.contextMessages, messages);
    const toolSchema = tools === undefined ? undefined : digest(tools);
    if (toolSchema && tools && !this.schemas.has(toolSchema))
      this.append({ type: 'tool-schema', hash: toolSchema, tools });
    return this.append({
      type: 'model-request',
      request: { model, systemPrompt, thinkingLevel, maxTokens, toolSchema, ...(patch && { messagesPatch: patch }) },
    }, projected.leafId);
  }

  acceptToolResult(executionId: string, content: NativeToolMessage['content']) {
    const raw = this.byId.get(executionId);
    if (raw?.type !== 'tool-execution') throw new Error('Tool acceptance references a missing execution');
    return this.append({
      type: 'tool-accepted', executionId,
      contentDelta: contentDelta(JSON.stringify(raw.result.content), JSON.stringify(content)),
    });
  }

  private requestMetadata(entry: Extract<SessionEntry, { type: 'model-request' }>) {
    const { toolSchema, messagesPatch: _, ...request } = entry.request;
    const tools = toolSchema ? this.schemas.get(toolSchema) : undefined;
    if (toolSchema && !tools) throw new Error('Missing recorded tool schema');
    return tools ? { ...request, tools } : request;
  }

  private validateRecoveryContext(
    leaf: string | null,
    recovery: { leaf: string | null; checker: RequestMessages },
  ) {
    const tail: SessionEntry[] = [];
    let cursor = leaf;
    while (cursor !== null && cursor !== recovery.leaf) {
      const entry = this.byId.get(cursor);
      if (!entry) throw new Error('Unknown session branch');
      tail.push(entry);
      cursor = entry.parentId;
    }
    if (
      cursor !== recovery.leaf ||
      tail.some(({ type }) => type === 'compaction' || type === 'context-edit')
    ) {
      recovery.checker = new RequestMessages();
      recovery.checker.append(projectLog(this.records, this.branchEntries(leaf)).contextMessages);
    } else {
      const execution = (id: string) => {
        const raw = this.byId.get(id);
        return raw?.type === 'tool-execution' ? raw.result : undefined;
      };
      for (const entry of tail.reverse()) {
        const message = projectMessage(entry, execution);
        if (message) recovery.checker.append([message]);
      }
    }
    recovery.checker.complete();
    recovery.leaf = leaf;
  }

  private materializeRequest(entry: Extract<SessionEntry, { type: 'model-request' }>) {
    const { messagesPatch } = entry.request;
    const context = projectLog(this.records, this.branchEntries(entry.parentId)).contextMessages;
    let messages = context;
    if (messagesPatch) {
      const { start, deleteCount, insert } = messagesPatch;
      if (
        !Number.isSafeInteger(start) ||
        start < 0 ||
        start > context.length ||
        !Number.isSafeInteger(deleteCount) ||
        deleteCount < 0 ||
        start + deleteCount > context.length ||
        !Array.isArray(insert)
      )
        throw new Error('Invalid model request message splice');
      messages = [...context.slice(0, start), ...insert, ...context.slice(start + deleteCount)];
    }
    const metadata = this.requestMetadata(entry);
    const snapshot = { ...metadata, messages };
    validateRequestSnapshot(snapshot);
    return snapshot;
  }

  requestSnapshot(
    id: string,
  ): ModelRequestSnapshot & { messages: import('@mini-harness/llm/api').NativeMessage[] } {
    const entry = this.byId.get(id);
    if (entry?.type !== 'model-request') throw new Error('Model request not found');
    return structuredClone(this.materializeRequest(entry));
  }

  serialize() {
    if (this.closed) throw new Error('Session log is closed');
    this.checkFile(this.length);
    return encodeLog(this.header, this.records);
  }

  get latestRun() {
    return this.run && structuredClone(this.run);
  }

  /** Opening an existing log resolves interrupted work before it becomes writable. */
  recover() {
    if (this.run && isRunning(this.run)) {
      for (const item of this.pendingInbox.values()) {
        if (item.mode === 'steer')
          this.append({
            type: 'inbox-failed',
            inboxId: item.id,
            reason: 'The target run was interrupted before delivery',
          });
      }
      this.append({
        type: 'run',
        run: {
          ...this.run,
          state: 'interrupted',
          finishedAt: new Date().toISOString(),
          error: 'The run stopped before a terminal state was recorded',
        },
      });
    }
  }

  close() {
    if (!this.closed) {
      this.closed = true;
      closeSync(this.handle);
    }
  }
}

function queueEntry(item: InboxItem): QueueEntry {
  return {
    id: item.id,
    mode: item.mode,
    state: 'pending',
    summary: (item.input?.userText || item.input?.attachments[0]?.name || item.text).slice(0, 180),
  };
}

function validateEvent(event: SessionEvent) {
  switch (event.type) {
    case 'message':
      validateNativeMessage(event.message);
      if (event.selection) {
        if (event.message.role !== 'user') throw new Error('Invalid user model selection');
        validateEvent({ type: 'model', model: event.selection.model });
        if (event.selection.thinkingLevel !== undefined)
          validateEvent({ type: 'thinking', level: event.selection.thinkingLevel });
      }
      return;
    case 'model-request':
      if (
        !event.request ||
        !event.request.model ||
        typeof event.request.model.provider !== 'string' ||
        !event.request.model.provider ||
        typeof event.request.model.id !== 'string' ||
        !event.request.model.id ||
        typeof event.request.systemPrompt !== 'string' ||
        (event.request.toolSchema !== undefined && !/^[a-f0-9]{64}$/.test(event.request.toolSchema))
      )
        throw new Error('Invalid recorded model request');
      return;
    case 'tool-schema':
      validateRequestSnapshot({
        model: { provider: 'audit', id: 'audit' },
        systemPrompt: '',
        tools: event.tools,
      });
      if (!/^[a-f0-9]{64}$/.test(event.hash)) throw new Error('Invalid tool schema hash');
      return;
    case 'tool-execution':
      validateNativeMessage(event.result);
      if (event.result.role !== 'toolResult' || event.result.isError)
        throw new Error('Invalid completed tool execution');
      return;
    case 'tool-accepted':
      if (!entryId.test(event.executionId)) throw new Error('Invalid tool execution reference');
      return;
    case 'model':
      if (typeof event.model?.provider !== 'string' || typeof event.model.id !== 'string')
        throw new Error('Invalid session model');
      return;
    case 'thinking':
      if (event.level !== null && !isThinkingLevel(event.level)) throw new Error('Invalid thinking level');
      return;
    case 'plugin-record': {
      const { owner, display } = event;
      if (
        !owner ||
        typeof owner.pluginId !== 'string' ||
        typeof owner.instanceId !== 'string' ||
        !pluginIdPattern.test(owner.pluginId) ||
        !ownsRecord(owner.pluginId, owner.instanceId) ||
        (display !== undefined &&
          (!display ||
            typeof display.title !== 'string' ||
            !display.title.trim() ||
            display.title.length > 140))
      )
        throw new Error('Invalid plugin record');
      return;
    }
    case 'diagnostic':
      if (
        event.code !== 'invalid-tool-calls' &&
        event.code !== 'executor-response' &&
        event.code !== 'historical-record'
      )
        throw new Error('Invalid session diagnostic');
      return;
    case 'compaction':
      if (typeof event.summary !== 'string' || (event.keepFromId !== null && !entryId.test(event.keepFromId)))
        throw new Error('Invalid session compaction');
      return;
    case 'context-edit':
      if (
        !entryId.test(event.targetId) ||
        (event.replacement !== null &&
          typeof event.replacement !== 'string' &&
          !Array.isArray(event.replacement))
      )
        throw new Error('Invalid context edit');
      return;
    case 'inbox-enqueued':
      if (
        typeof event.item?.id !== 'string' ||
        !event.item.id ||
        !['steer', 'followUp'].includes(event.item.mode) ||
        typeof event.item.text !== 'string' ||
        !Array.isArray(event.item.images)
      )
        throw new Error('Invalid session inbox item');
      return;
    case 'inbox-consumed':
    case 'inbox-cancelled':
      if (!Array.isArray(event.ids) || event.ids.some((id) => typeof id !== 'string'))
        throw new Error('Invalid session inbox acknowledgement');
      return;
    case 'inbox-failed':
      if (
        typeof event.inboxId !== 'string' ||
        !event.inboxId ||
        typeof event.reason !== 'string' ||
        !event.reason
      )
        throw new Error('Invalid inbox failure');
      return;
    case 'run':
      if (
        !event.run ||
        typeof event.run.id !== 'string' ||
        typeof event.run.sessionId !== 'string' ||
        !['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(event.run.state) ||
        !Number.isFinite(Date.parse(event.run.startedAt)) ||
        !Number.isInteger(event.run.sequence) ||
        event.run.sequence < 0 ||
        (event.run.inputEntryId != null && !entryId.test(event.run.inputEntryId))
      )
        throw new Error('Invalid session run');
      return;
    case 'branch':
      return;
    default:
      throw new Error('Unknown session event');
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

/** Renders a complete log document for exports; live appends go through SessionLog. */
export function encodeLog(header: SessionHeader, entries: SessionEntry[]) {
  return (
    [
      JSON.stringify(header),
      ...entries.map((entry) => JSON.stringify({ ...entry, checksum: digest(entry) })),
    ].join('\n') + '\n'
  );
}

function ownsRecord(pluginId: string, instanceId: string) {
  if (instanceId === pluginId) return true;
  const slash = instanceId.indexOf('/');
  return slash > 0 && isScopeAddress(instanceId.slice(0, slash)) && instanceId.slice(slash + 1) === pluginId;
}

/** Normalize historical record envelopes only after validating the original checksum. */
function storedEntry(entry: StoredEntry): SessionEntry {
  if (entry.type !== 'custom') return entry;
  const { type: _type, namespace, data, ...identity } = entry;
  if (typeof namespace !== 'string' || !namespace) throw new Error('Invalid historical record namespace');
  if (namespace === 'agent.invalid-tool-calls')
    return { ...identity, type: 'diagnostic', code: 'invalid-tool-calls', data };
  const shown = namespace.startsWith('display:');
  const instanceId = shown ? namespace.slice('display:'.length) : namespace;
  const pluginId = instanceId.slice(instanceId.lastIndexOf('/') + 1);
  if (pluginIdPattern.test(pluginId) && ownsRecord(pluginId, instanceId)) {
    const owner = { pluginId, instanceId };
    if (!shown) return { ...identity, type: 'plugin-record', owner, data };
    const envelope = data as { data?: unknown; display?: { title?: unknown; content?: unknown } } | undefined;
    const { display } = envelope ?? {};
    if (typeof display?.title === 'string' && display.title.trim() && display.title.length <= 140)
      return {
        ...identity,
        type: 'plugin-record',
        owner,
        data: envelope?.data,
        display: { title: display.title, content: display.content },
      };
  }
  return {
    ...identity,
    type: 'diagnostic',
    code: 'historical-record',
    data: { label: namespace, payload: data },
  };
}

function operational(entry: SessionEvent) {
  return (
    entry.type === 'run' ||
    entry.type === 'model-request' ||
    entry.type === 'tool-schema' ||
    entry.type === 'tool-execution' ||
    entry.type.startsWith('inbox-')
  );
}
