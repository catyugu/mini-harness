import { isThinkingLevel, type ToolSchema } from '@mini-harness/llm/vocabulary';
import { pluginIdPattern, isScopeAddress } from '@mini-harness/plugin-api/selection';
import { isRunning, type RunInfo } from './shared/run-state.ts';
import { terminal } from '@mini-harness/tasks/api';
import { summarizeTask, type TaskSummary } from './records.ts';
import { runFromEntry } from './log-api.ts';
import { isDeepStrictEqual } from 'node:util';
import {
  RequestMessages,
  validateNativeMessage,
  validateRequestSnapshot,
  type LlmRequest,
  type NativeMessage,
  type NativeToolMessage,
} from '@mini-harness/llm/api';
import type {
  InboxItem,
  MessagePatch,
  SessionContext,
  SessionEntry,
  SessionEvent,
  SessionLogPort,
  SessionProjection,
} from './log-api.ts';
import { messageModes, type QueueEntry } from './shared/queue.ts';
import {
  applyReplacements,
  displayContent,
  newContext,
  projectContextEntry,
  projectLog,
  projectMessage,
} from './projection.ts';
import { applyContentDelta, contentDelta } from './content-delta.ts';
import { RecordLog, digest, entryId, type RecordAddress } from './record-log.ts';

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

export interface LogIndex {
  tasks: Map<
    string,
    {
      task: TaskSummary;
      address: RecordAddress;
      entered: number;
      answer?: RecordAddress;
    }
  >;
  inboxIds: Set<string>;
  wake: boolean;
  run?: RunInfo;
}

/** Session semantics layered over the generic durable record log. */
export class SessionLog extends RecordLog<SessionEvent> implements SessionLogPort {
  readonly index: LogIndex = { tasks: new Map(), inboxIds: new Set(), wake: false };
  private assistant?: { seq: number; address: RecordAddress };
  private readonly indexTasks: boolean;
  private readonly schemas = new Map<string, ToolSchema[]>();
  private readonly settings = new Map<string, unknown>();
  private paused = false;
  private readonly pendingInbox = new Map<string, InboxItem>();
  private readonly inboxFailures: QueueEntry[] = [];
  private readonly runEvents: { seq: number; parentId: string | null; run: RunInfo }[] = [];
  private cachedContext?: SessionContext;
  private cachedProjection?: SessionProjection;
  private recovery = { leaf: null as string | null, checker: new RequestMessages() };

  /** All consumers share record operations; only the Registry owns the open file. */
  readonly port: SessionLogPort = {
    sessionId: this.sessionId,
    entries: (after) => this.entries(after),
    originalMessage: (id, raw) => this.originalMessage(id, raw),
    setting: (owner) => this.setting(owner),
    inbox: () => this.inbox(),
    hasInbox: (id) => this.hasInbox(id),
    inboxPaused: () => this.inboxPaused(),
    queue: () => this.queue(),
    branch: (leafId) => this.branch(leafId),
    append: (event, leafId) => this.append(event, leafId),
    revise: (event, parentId, leafId) => this.revise(event, parentId, leafId),
    context: (leafId) => this.context(leafId),
    projection: (leafId) => this.projection(leafId),
    recordRequest: (snapshot, purpose) => this.recordRequest(snapshot, purpose),
    acceptToolResult: (id, content) => this.acceptToolResult(id, content),
    requestDefinition: (id) => this.requestDefinition(id),
    requestSnapshot: (id) => this.requestSnapshot(id),
  };

  constructor(
    file: string,
    sessionId: string,
    createdAt = new Date().toISOString(),
    changed?: (entry: SessionEntry) => void,
    readOnly = false,
    writeFailed?: (error: unknown) => void,
  ) {
    super(file, sessionId, changed, readOnly, writeFailed);
    this.indexTasks = !readOnly;
    this.open(createdAt);
  }

  protected decodeRecord(record: Record<string, unknown>): SessionEntry {
    const entry = record as SessionEntry;
    if (
      entry.type === 'message' &&
      entry.message.role === 'toolResult' &&
      entry.message.details?.approvalDenied === true &&
      !entry.message.outcome
    ) {
      const { approvalDenied: _, ...details } = entry.message.details;
      entry.message = { ...entry.message, outcome: 'denied', details };
    }
    return entry;
  }

  protected advancesBranch(entry: SessionEntry) {
    return advancesBranch(entry);
  }

  protected validateRecord(entry: SessionEntry, recovering: boolean) {
    const recovery = recovering ? this.recovery : undefined;
    validateEvent(entry);
    if (entry.type === 'tool-schema' && digest(entry.tools) !== entry.hash)
      throw new Error('Tool schema digest does not match its content');
    if (entry.type === 'model-request') {
      if (!recovery || entry.request.messagesPatch !== undefined)
        validateRequestSnapshot(this.materializeRequest(entry));
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
    if (entry.type === 'inbox-enqueued' && this.index.inboxIds.has(entry.item.id))
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
    if (entry.type === 'task' && entry.task.owner !== 'session:' + this.sessionId)
      throw new Error('Task belongs to another conversation');
    if (entry.type === 'context-replace') {
      const state = this.context(entry.parentId);
      applyReplacements(state, entry.replacements, entry.id);
      const checker = new RequestMessages();
      checker.append(state.contextMessages);
      checker.complete();
    }
    if (entry.type === 'model-attempt' && this.byId.get(entry.requestId)?.type !== 'model-request')
      throw new Error('Model attempt references a missing request');
  }

  protected recordAdded(entry: SessionEntry, address: RecordAddress) {
    if (this.indexTasks) {
      if (entry.type === 'message' && entry.message.role === 'assistant')
        this.assistant = { seq: entry.seq, address };
      if (entry.type === 'task') {
        const { task, seq, run } = entry;
        const entered = this.index.tasks.get(task.id)?.entered ?? seq;
        const answer =
          run && task.state === 'completed' && this.assistant && this.assistant.seq > entered
            ? this.assistant.address
            : undefined;
        const { progress: _progress, ...summary } = summarizeTask(task);
        this.index.tasks.set(task.id, { task: summary, address, entered, answer });
      }
    }
    const run = runFromEntry(this.sessionId, entry);
    if (advancesBranch(entry)) {
      if (this.cachedContext?.leafId === entry.parentId)
        projectContextEntry(this.cachedContext, entry, projectMessage(entry, this.execution));
      else this.cachedContext = undefined;
    }
    if (advancesBranch(entry) || run) this.cachedProjection = undefined;
    if (entry.type === 'session-setting') {
      if (entry.value == null) this.settings.delete(entry.owner);
      else this.settings.set(entry.owner, entry.value);
    }
    if (run) {
      this.index.run = run;
      this.runEvents.push({ seq: entry.seq, parentId: entry.parentId, run });
    }
    if (entry.type === 'tool-schema') this.schemas.set(entry.hash, entry.tools);
    if (entry.type === 'inbox-paused') this.paused = true;
    if (entry.type === 'inbox-enqueued') {
      if (entry.item.resume) this.paused = false;
      this.index.inboxIds.add(entry.item.id);
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
    this.index.wake = !this.paused && this.pendingInbox.size > 0;
  }

  setting(owner: string) {
    return structuredClone(this.settings.get(owner));
  }

  hasInbox(id: string) {
    return this.index.inboxIds.has(id);
  }

  inboxPaused() {
    return this.paused;
  }

  inbox() {
    return structuredClone([...this.pendingInbox.values()]);
  }

  queue() {
    return [...Array.from(this.pendingInbox.values(), queueEntry), ...structuredClone(this.inboxFailures)];
  }

  private execution = (id: string) => {
    const raw = this.byId.get(id);
    return raw?.type === 'tool-execution' ? raw.result : undefined;
  };

  originalMessage(id: string, raw = false) {
    const entry = this.byId.get(id);
    if (!entry) return;
    return structuredClone(
      raw && entry.type === 'tool-accepted'
        ? this.execution(entry.executionId)
        : projectMessage(entry, this.execution),
    );
  }

  private contextAt(leafId = this.leafId) {
    if (this.cachedContext?.leafId === leafId) return this.cachedContext;
    const state = newContext();
    for (const entry of this.branchEntries(leafId))
      projectContextEntry(state, entry, projectMessage(entry, this.execution));
    if (leafId === this.leafId) this.cachedContext = state;
    return state;
  }

  context(leafId?: string | null) {
    return structuredClone(this.contextAt(leafId));
  }

  projection(leafId?: string | null) {
    // A display projection owns its timeline. Effective context is maintained on demand.
    const project = () =>
      projectLog(this.branchEntries(leafId), this.execution, this.runEvents, this.contextAt(leafId));
    if (leafId !== undefined) return structuredClone(project());
    this.cachedProjection ??= project();
    return structuredClone(this.cachedProjection);
  }

  recordRequest(snapshot: Omit<LlmRequest, 'signal'>, purpose?: 'summary') {
    const projected = this.contextAt();
    const { messages, tools, model, systemPrompt, thinkingLevel, maxTokens, inputMeasurement } = snapshot;
    const patch = messagePatch(projected.contextMessages, messages);
    const toolSchema = tools === undefined ? undefined : digest(tools);
    if (toolSchema && tools && !this.schemas.has(toolSchema))
      this.append({ type: 'tool-schema', hash: toolSchema, tools });
    return this.append(
      {
        type: 'model-request',
        request: {
          model,
          systemPrompt,
          thinkingLevel,
          maxTokens,
          inputMeasurement,
          toolSchema,
          purpose,
          ...(patch && { messagesPatch: patch }),
        },
      },
      projected.leafId,
    );
  }

  acceptToolResult(executionId: string, content: NativeToolMessage['content']) {
    const raw = this.byId.get(executionId);
    if (raw?.type !== 'tool-execution') throw new Error('Tool acceptance references a missing execution');
    return this.append({
      type: 'tool-accepted',
      executionId,
      contentDelta: contentDelta(JSON.stringify(raw.result.content), JSON.stringify(content)),
    });
  }

  private requestMetadata(entry: Extract<SessionEntry, { type: 'model-request' }>) {
    const { toolSchema, messagesPatch: _, purpose: _purpose, ...request } = entry.request;
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
    if (cursor !== recovery.leaf || tail.some(({ type }) => type === 'context-replace')) {
      recovery.checker = new RequestMessages();
      recovery.checker.append(this.contextAt(leaf).contextMessages);
    } else {
      for (const entry of tail.reverse()) {
        const message = projectMessage(entry, this.execution);
        if (message) recovery.checker.append([message]);
      }
    }
    recovery.checker.complete();
    recovery.leaf = leaf;
  }

  private materializeRequest(entry: Extract<SessionEntry, { type: 'model-request' }>) {
    const { messagesPatch } = entry.request;
    const context = this.contextAt(entry.parentId).contextMessages;
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
    return { ...metadata, messages };
  }

  private recordedRequest(id: string) {
    const entry = this.byId.get(id);
    if (entry?.type !== 'model-request') throw new Error('Model request not found');
    return entry;
  }

  requestDefinition(id: string) {
    return structuredClone(this.requestMetadata(this.recordedRequest(id)));
  }

  requestSnapshot(id: string) {
    return structuredClone(this.materializeRequest(this.recordedRequest(id)));
  }

  /** Opening an existing log resolves interrupted work before it becomes writable. */
  indexedEntry(id: string) {
    return this.byId.get(id);
  }

  recover() {
    for (const { task, address } of this.index.tasks.values()) {
      if (terminal(task.state)) continue;
      const entry = this.byId.get(address.id);
      if (entry?.type !== 'task') throw new Error('Missing indexed task transition');
      this.append({
        type: 'task',
        task: {
          ...entry.task,
          state: 'interrupted',
          finishedAt: new Date().toISOString(),
          error: 'Task interrupted before a terminal state was recorded',
        },
        output: entry.output,
        run: entry.run,
      });
    }
    const run = this.index.run;
    if (run && isRunning(run)) {
      this.append({
        type: 'run',
        run: {
          ...run,
          state: 'interrupted',
          finishedAt: new Date().toISOString(),
          error: 'The run stopped before a terminal state was recorded',
        },
      });
    }
  }
}

function queueEntry(item: InboxItem): QueueEntry {
  return {
    id: item.id,
    mode: item.mode,
    origin: item.origin,
    state: 'pending',
    summary: (item.input?.userText || item.input?.attachments[0]?.name || item.text).slice(0, 180),
  };
}

function validateEvent(event: SessionEvent) {
  if (event.displays !== undefined && !Array.isArray(event.displays))
    throw new Error('Invalid record presentations');
  for (const display of event.displays ?? []) {
    if (!display || typeof display !== 'object') throw new Error('Invalid record presentation');
    const { owner } = display;
    if (
      !owner ||
      typeof owner.pluginId !== 'string' ||
      !pluginIdPattern.test(owner.pluginId) ||
      typeof owner.instanceId !== 'string' ||
      !ownsRecord(owner.pluginId, owner.instanceId) ||
      (display.id !== undefined && (typeof display.id !== 'string' || !display.id.trim())) ||
      typeof display.kind !== 'string' ||
      !display.kind.trim() ||
      typeof display.title !== 'string' ||
      !display.title.trim() ||
      display.title.length > 140 ||
      (display.source !== undefined &&
        (!Array.isArray(display.source) || !display.source.length || Object.hasOwn(display, 'content')))
    )
      throw new Error('Invalid record presentation');
    displayContent(event, display);
  }
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
      const { owner } = event;
      if (
        !owner ||
        typeof owner.pluginId !== 'string' ||
        typeof owner.instanceId !== 'string' ||
        !pluginIdPattern.test(owner.pluginId) ||
        !ownsRecord(owner.pluginId, owner.instanceId)
      )
        throw new Error('Invalid plugin record');
      return;
    }
    case 'diagnostic':
      if (event.code !== 'invalid-tool-calls' && event.code !== 'executor-response')
        throw new Error('Invalid session diagnostic');
      return;
    case 'context-replace':
      if (!Array.isArray(event.replacements) || !event.replacements.length)
        throw new Error('Invalid context replacement');
      return;
    case 'model-attempt':
      if (!entryId.test(event.requestId) || !Number.isFinite(event.elapsedMs) || event.elapsedMs < 0)
        throw new Error('Invalid model attempt');
      return;
    case 'session-setting':
      if (!pluginIdPattern.test(event.owner)) throw new Error('Invalid session setting owner');
      return;
    case 'inbox-enqueued':
      if (
        typeof event.item?.id !== 'string' ||
        !event.item.id ||
        !messageModes.includes(event.item.mode) ||
        typeof event.item.text !== 'string' ||
        !Array.isArray(event.item.images)
      )
        throw new Error('Invalid session inbox item');
      return;
    case 'inbox-paused':
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
    case 'task':
      if (
        !event.task ||
        typeof event.task.id !== 'string' ||
        typeof event.task.owner !== 'string' ||
        !['queued', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'interrupted'].includes(
          event.task.state,
        ) ||
        !Number.isFinite(Date.parse(event.task.createdAt)) ||
        !Number.isSafeInteger(event.task.outputCursor) ||
        event.task.outputCursor < 0 ||
        (event.run !== undefined &&
          (!event.run ||
            !Number.isSafeInteger(event.run.sequence) ||
            event.run.sequence < 0 ||
            (event.run.inputEntryId != null && !entryId.test(event.run.inputEntryId)) ||
            (event.run.changedFiles !== undefined &&
              (!Array.isArray(event.run.changedFiles) ||
                event.run.changedFiles.some((path) => typeof path !== 'string')))))
      )
        throw new Error('Invalid task record');
      return;
    case 'run':
      if (
        !event.run ||
        typeof event.run.id !== 'string' ||
        typeof event.run.sessionId !== 'string' ||
        !['queued', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'interrupted'].includes(
          event.run.state,
        ) ||
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

function ownsRecord(pluginId: string, instanceId: string) {
  if (instanceId === pluginId) return true;
  const slash = instanceId.indexOf('/');
  return slash > 0 && isScopeAddress(instanceId.slice(0, slash)) && instanceId.slice(slash + 1) === pluginId;
}

export function advancesBranch(entry: SessionEvent) {
  return !(
    entry.type === 'run' ||
    entry.type === 'task' ||
    entry.type === 'model-request' ||
    entry.type === 'model-attempt' ||
    entry.type === 'session-setting' ||
    entry.type === 'tool-schema' ||
    entry.type === 'tool-execution' ||
    entry.type.startsWith('inbox-')
  );
}
