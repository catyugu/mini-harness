import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Paths } from '../contracts/config.js';
import type { SessionRecord } from '../contracts/conversation.js';
import type { ThinkingLevel } from '../contracts/agent.js';
import type { NativeMessage } from '../contracts/llm.js';
import type { SessionEntry, SessionEvent } from '../contracts/session-log.js';
import type { WorkspacePort } from '../contracts/services.js';
import type { RunInfo } from '../contracts/transport.js';
import { readJson, writeJson } from '../platform/config.js';
import { encodeLog, SessionLog, syncDirectory } from './log.js';
import { checkedStoredFile, missing, nativeFile } from './storage.js';

export type StoredSession = Pick<SessionRecord, 'id' | 'workspaceId'>;
interface CleanupFile { workspaceId: string; file: string }
export interface CatalogState {
  version: 3;
  sessions: SessionRecord[];
  pendingDelete?: StoredSession[];
  pendingCleanup?: CleanupFile[];
}

/** The importer is the only reader of old formats. The running application only opens native logs. */
export function loadCatalog(paths: Paths, workspaces: WorkspacePort): CatalogState {
  const saved = readJson<any>(paths.registry, { version: 3, sessions: [] });
  if (!saved || !Array.isArray(saved.sessions)) throw new Error('Invalid conversation index');
  if (saved.version === 3) {
    validateCatalog(saved.sessions, workspaces);
    finishImportCleanup(paths, workspaces, saved);
    return saved;
  }
  if (saved.version !== undefined && saved.version !== 2) throw new Error('Unsupported conversation index version');
  const sessions: SessionRecord[] = saved.sessions.map((record: any) => ({
    id: record.id, workspaceId: record.workspaceId, parentId: record.parentId ?? null,
    title: record.title, titleSource: record.titleSource ?? (record.title === 'New conversation' ? 'auto' : 'manual'),
    createdAt: record.createdAt
  }));
  validateCatalog(sessions, workspaces);
  const checkpoints = join(paths.home, 'runs.json');
  const runs = readJson<Record<string, RunInfo>>(checkpoints, {});
  const cleanup: CleanupFile[] = [];
  for (let index = 0; index < sessions.length; index++) {
    const record = sessions[index], previous = saved.sessions[index];
    const reference = previous.piSessionRef ?? previous.file ?? null;
    const target = nativeFile(paths, workspaces, record);
    const source = reference ? checkedStoredFile(paths, workspaces, record.workspaceId, reference) : undefined;
    if (source && existsSync(source)) {
      importTranscript(source, target, record);
      if (resolve(source) !== resolve(target)) cleanup.push({ workspaceId: record.workspaceId, file: source });
    }
    const run = runs[record.id] ?? previous.run;
    if (run) {
      const log = new SessionLog(target, record.id, record.createdAt);
      try {
        // A crash before catalog cutover can replay this step, but never duplicates a checkpoint.
        if (!log.entries().some((entry) => entry.type === 'run' && entry.run.id === run.id))
          log.append({ type: 'run', run: { ...run, sessionId: record.id } });
        log.recover();
      } finally { log.close(); }
    }
  }
  for (const pending of saved.pendingDelete ?? []) {
    const reference = pending.piSessionRef ?? pending.file;
    if (reference) cleanup.push({ workspaceId: pending.workspaceId, file: reference });
  }
  const state: CatalogState = { version: 3, sessions, ...(cleanup.length ? { pendingCleanup: cleanup } : {}) };
  // The new index is the cutover point. No source is removed until all native logs are durable.
  writeJson(paths.registry, state);
  syncDirectory(paths.home);
  finishImportCleanup(paths, workspaces, state);
  if (existsSync(checkpoints)) { unlinkSync(checkpoints); syncDirectory(paths.home); }
  return state;
}

function finishImportCleanup(paths: Paths, workspaces: WorkspacePort, state: CatalogState) {
  if (state.pendingCleanup?.length) {
    for (const entry of state.pendingCleanup) {
      const file = checkedStoredFile(paths, workspaces, entry.workspaceId, entry.file);
      if (state.sessions.some((record) => nativeFile(paths, workspaces, record) === file))
        throw new Error('Refusing to remove an active session log during migration');
      try { unlinkSync(file); syncDirectory(dirname(file)); }
      catch (error) { if (!missing(error)) throw error; }
    }
    delete state.pendingCleanup;
    writeJson(paths.registry, state);
    syncDirectory(paths.home);
  }
  // A process may have stopped just after committing the v3 index.
  const checkpoints = join(paths.home, 'runs.json');
  if (existsSync(checkpoints)) { unlinkSync(checkpoints); syncDirectory(paths.home); }
}

export function validateCatalog(sessions: SessionRecord[], workspaces: WorkspacePort) {
  const records = new Map<string, SessionRecord>();
  for (const record of sessions) {
    if (!record || !/^[a-f0-9-]{36}$/i.test(record.id) || records.has(record.id) ||
        typeof record.workspaceId !== 'string' || typeof record.title !== 'string' ||
        !['auto', 'manual'].includes(record.titleSource) || !Number.isFinite(Date.parse(record.createdAt)))
      throw new Error('Invalid conversation index');
    workspaces.get(record.workspaceId);
    records.set(record.id, record);
  }
  for (const record of sessions) {
    const ancestors = new Set([record.id]);
    for (let item = record; item.parentId;) {
      const parent = records.get(item.parentId);
      if (!parent || parent.workspaceId !== record.workspaceId || ancestors.has(parent.id))
        throw new Error('Invalid conversation ancestry');
      ancestors.add(parent.id);
      item = parent;
    }
  }
}

function importTranscript(source: string, target: string, record: SessionRecord) {
  const text = readFileSync(source, 'utf8');
  const sourceHash = createHash('sha256').update(text).digest('hex');
  const first = JSON.parse(text.split('\n', 1)[0]);
  if (source === target && first?.type === 'session' && first.version === 1 && first.createdAt && first.importedFrom) {
    const log = new SessionLog(target, record.id); log.close(); return;
  }
  if (existsSync(target) && source !== target) {
    const header = JSON.parse(readFileSync(target, 'utf8').split('\n', 1)[0]);
    if (header.importedFrom !== sourceHash) throw new Error('Native session destination already contains unrelated data');
    const log = new SessionLog(target, record.id); log.close(); return;
  }
  const entries = convertTranscript(text, record);
  const encoded = encodeLog({ type: 'session', version: 1, id: record.id, createdAt: record.createdAt, importedFrom: sourceHash }, entries);
  const temp = target + '.' + randomUUID() + '.tmp';
  const handle = openSync(temp, 'wx', 0o600);
  try {
    try { writeFileSync(handle, encoded); fsyncSync(handle); } finally { closeSync(handle); }
    // Validate the complete new log before replacing an existing same-path source.
    const verified = new SessionLog(temp, record.id); verified.close();
    renameSync(temp, target);
    syncDirectory(dirname(target));
  } finally { rmSync(temp, { force: true }); }
}

function convertTranscript(text: string, record: SessionRecord): SessionEntry[] {
  const lines = text.split('\n');
  const original: any[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].trim()) continue;
    try { original.push(JSON.parse(lines[index])); }
    catch {
      if (index === lines.length - 1 && !text.endsWith('\n')) break;
      throw new Error('Cannot migrate a corrupt session transcript');
    }
  }
  const header = original.shift();
  if (header?.type !== 'session' || ![1, 2, 3].includes(header.version ?? 1)) throw new Error('Unsupported session transcript');
  const idMap = new Map<string, string>();
  const known = new Set<string>();
  let previous: string | null = null;
  for (let index = 0; index < original.length; index++) {
    const entry = original[index];
    const oldId = entry.id ?? 'entry:' + index;
    if (known.has(oldId)) throw new Error('Duplicate session entry in migration');
    known.add(oldId);
    const id = /^[a-f0-9]{8,64}$/i.test(oldId) ? oldId :
      createHash('sha256').update(record.id + ':' + oldId).digest('hex').slice(0, 32);
    idMap.set(oldId, id);
    entry.id = oldId;
    if (entry.parentId === undefined) entry.parentId = previous;
    if (entry.parentId !== null && !idMap.has(entry.parentId)) throw new Error('Invalid session ancestry in migration');
    previous = oldId;
  }
  const inputs = new Map<string, any>(), timings = new Map<string, number>();
  const originalById = new Map(original.map((entry) => [entry.id, entry]));
  for (const entry of original) {
    if (entry.type === 'custom' && entry.customType === 'mini-harness:input') {
      inputs.set(entry.id, entry.data);
      if (originalById.get(entry.parentId)?.message?.role === 'user') inputs.set(entry.parentId, entry.data);
    }
    if (entry.type === 'custom' && entry.customType === 'mini-harness:tool-timing' &&
        typeof entry.data?.toolCallId === 'string' && typeof entry.data.elapsedMs === 'number')
      timings.set(entry.data.toolCallId, entry.data.elapsedMs);
  }
  return original.map((entry, index) => {
    const timestamp = typeof entry.timestamp === 'string' && Number.isFinite(Date.parse(entry.timestamp)) ? entry.timestamp : record.createdAt;
    const base = { version: 1 as const, seq: index + 1, id: idMap.get(entry.id),
      parentId: entry.parentId === null ? null : idMap.get(entry.parentId), timestamp };
    let event: SessionEvent;
    switch (entry.type) {
      case 'message': {
        if (!['user', 'assistant', 'toolResult'].includes(entry.message?.role))
          throw new Error('Unsupported message role in session migration: ' + entry.message?.role);
        const message = nativeMessage(entry.message, timestamp);
        event = { type: 'message', message };
        if (message.role === 'user') {
          const input = inputs.get(entry.parentId) ?? inputs.get(entry.id);
          if (input && Number.isInteger(input.userTextLength) && Array.isArray(input.attachments)) {
            const fullText = typeof message.content === 'string' ? message.content :
              message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
            event.presentation = { userText: fullText.slice(0, input.userTextLength), attachments: input.attachments };
          }
        }
        if (message.role === 'toolResult') event.elapsedMs = timings.get(message.toolCallId);
        break;
      }
      case 'model_change': event = { type: 'model', model: { provider: entry.provider, id: entry.modelId } }; break;
      case 'thinking_level_change': event = { type: 'thinking', level: entry.thinkingLevel as ThinkingLevel }; break;
      case 'compaction': {
        // Format 1 used an index into the original file entries, including its header.
        const kept = entry.firstKeptEntryId ?? (Number.isInteger(entry.firstKeptEntryIndex)
          ? original[entry.firstKeptEntryIndex - 1]?.id : undefined);
        if (kept !== undefined && !idMap.has(kept)) throw new Error('Invalid compaction boundary in session migration');
        event = { type: 'compaction', summary: entry.summary,
          keepFromId: kept === entry.id ? null : idMap.get(kept) ?? null, tokensBefore: entry.tokensBefore };
        break;
      }
      case 'context_edit': event = { type: 'context-edit', targetId: idMap.get(entry.targetId), replacement: entry.replacement?.content ?? null }; break;
      case 'custom': event = { type: 'custom', namespace: String(entry.customType).replace(/^mini-harness:/, ''), data: entry.data ?? null }; break;
      case 'custom_message': event = { type: 'message', message: { role: 'user', content: entry.content, timestamp: Date.parse(timestamp) } }; break;
      case 'branch_summary': event = { type: 'message', message: { role: 'user',
        content: 'Context from an earlier branch:\n' + entry.summary, timestamp: Date.parse(timestamp) } }; break;
      case 'usage': case 'label': case 'session_info':
        event = { type: 'custom', namespace: 'session.' + entry.type, data: entry }; break;
      default: throw new Error('Unsupported session entry in migration: ' + entry.type);
    }
    return { ...event, ...base } as SessionEntry;
  });
}

function nativeMessage(value: any, timestamp: string): NativeMessage {
  const message = { ...value, timestamp: typeof value.timestamp === 'number' ? value.timestamp : Date.parse(timestamp) };
  if (value.role === 'assistant') {
    const known = new Set(['role', 'content', 'timestamp', 'provider', 'model', 'usage', 'stopReason', 'errorMessage', 'providerData']);
    const providerData = { ...value.providerData };
    for (const key of Object.keys(message)) if (!known.has(key)) { providerData[key] = message[key]; delete message[key]; }
    if (Object.keys(providerData).length) message.providerData = providerData;
  }
  return message;
}
