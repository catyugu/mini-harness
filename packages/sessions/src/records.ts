import type { TaskOptions, TaskOutput, TaskSnapshot } from '@mini-harness/tasks/api';
import type { ScopeKey } from '@mini-harness/plugin-api/scopes';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import type { HistoryEntry } from './shared/message.ts';
import type { ConversationPermission, SessionRecord } from './shared/identity.ts';
import type { SessionLogPort, SessionLogReader } from './log-api.ts';
export type { SessionLogPort, SessionEntry, SessionEvent, SessionProjection } from './log-api.ts';
import type { Attachment, ImageInput, PreparedMessage } from '@mini-harness/input/message';
import type { RunInfo } from './shared/run-state.ts';

import type { RecordDisplay, RecordOwner } from './shared/display-record.ts';
export type { RecordDisplay, RecordOwner } from './shared/display-record.ts';

/** Plugin-contributed payloads use the same durable branch record contract as native events. */
export interface PluginRecord<Data = unknown> {
  type: 'plugin-record';
  owner: RecordOwner;
  data: Data;
}

export interface SessionRecords<Data = unknown> {
  list(): { id: string; timestamp: string; data: Data }[];
  append(data: Data, display?: RecordDisplay): Promise<string>;
}

export interface SessionCatalog {
  readonly events: EventTarget;
  get(id: string): SessionRecord | undefined;
  scope(id: string): ScopeKey | undefined;
  runScope(id: string): ScopeKey | undefined;
  list(workspaceId?: string | null): SessionRecord[];
  workspacePath(id: string): string | undefined;
  depth(id: string): number;
  descendants(ids: string[]): string[];
  modifiedAt(record: SessionRecord): string;
}

export interface SessionHistory {
  revisionTarget(
    id: string,
    sourceEntryId: string,
    expectedLeafId: string | null,
  ): {
    parentId: string | null;
    images: { data: string; mimeType: string; name: string }[];
    textFiles: string[];
  };
  inspectLog<T>(id: string, read: (log: SessionLogReader) => T, strict?: boolean): T | undefined;
  runSummary(id: string): RunInfo | undefined;
  taskSummary(id: string): Omit<TaskSnapshot, 'result'> | undefined;
  taskHistory(id: string): TaskSnapshot | undefined;
  taskOutput(id: string, after?: number): TaskOutput | undefined;
  taskSummaries(sessionId: string, type?: string, limit?: number): Omit<TaskSnapshot, 'result'>[];
  hasInbox(sessionId: string, messageId: string): boolean;
  logError(id: string): string | undefined;
  diagnostics(): { id: string; message: string }[];
}

export interface SessionLifecycle {
  create(input?: {
    parentId?: string | null;
    title?: string;
    workspaceId?: string | null;
    permission?: ConversationPermission;
  }): SessionRecord;
  setPermission(id: string, permission: ConversationPermission): SessionRecord;
  rename(id: string, title: string, source?: SessionRecord['titleSource']): SessionRecord;
  assertAvailable(id?: string, workspaceId?: string | null): void;
  beforeDelete(handler: { quiesce(ids: string[]): Promise<void>; busy?(id: string): boolean }): () => void;
  export(ids: string[]): (SessionRecord & { log: string; attachments: Record<string, string> })[];
  delete(ids: string[]): Promise<string[]>;
}

/** The native persistence provider owns writers and their deletion transaction. */
export interface SessionStore extends SessionCatalog, SessionHistory, SessionLifecycle {
  history(id: string): { timeline: HistoryEntry[]; leafId: string | null; model?: ModelChoice };
  records<Data = unknown>(id: string, owner: RecordOwner): SessionRecords<Data>;
  log(id: string): SessionLogPort;
  /** Bind independent work to this session's lifetime and durable log. */
  task(id: string): Pick<TaskOptions, 'owner' | 'commit'>;
  prepareInput(
    id: string,
    text: unknown,
    attachments?: Attachment[],
  ): { text: string; images: ImageInput[]; input: PreparedMessage };
  readAttachment(id: string, attachmentId: string): Buffer | undefined;
  attachmentDirectory(id: string): string | undefined;
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessSessions: SessionStore;
  }
}
