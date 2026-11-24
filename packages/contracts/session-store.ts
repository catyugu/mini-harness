import type {} from 'cordis';
import type { ConversationPermission, SessionRecord } from './conversation.js';
import type { SessionLogPort } from './session-log.js';
import type { SessionRecords } from './session-records.js';
import type { RunInfo } from './transport.js';
import type { WorkspacePort } from './workspace.js';

/** Persistence and lifecycle operations for the native session capabilities. */
export interface SessionStore {
  readonly events: EventTarget;
  readonly workspaces: WorkspacePort;
  get(id: string): SessionRecord | undefined;
  list(workspaceId?: string): SessionRecord[];
  create(input?: { parentId?: string | null; title?: string; workspaceId?: string; permission?: ConversationPermission }): SessionRecord;
  setPermission(id: string, permission: ConversationPermission): SessionRecord;
  rename(id: string, title: string, source?: SessionRecord['titleSource']): SessionRecord;
  records(id: string, pluginId: string): SessionRecords;
  log(id: string): SessionLogPort;
  inspectLog<T>(id: string, read: (log: SessionLogPort) => T, strict?: boolean): T | undefined;
  runSummary(id: string): RunInfo | undefined;
  logError(id: string): string | undefined;
  diagnostics(): { id: string; message: string }[];
  assertAvailable(id?: string, workspaceId?: string): void;
  beforeDelete(handler: { quiesce(ids: string[]): Promise<void>; release?(ids: string[]): void; busy?(id: string): boolean }): () => void;
  close(): void;
  workspacePath(id: string): string;
  depth(id: string): number;
  descendants(ids: string[]): string[];
  nativeFile(record: SessionRecord): string;
  modifiedAt(record: SessionRecord): string;
  export(ids: string[]): (SessionRecord & { log: string })[];
  delete(ids: string[]): Promise<string[]>;
  deleteWorkspace(id: string): Promise<{ removed: string; deleted: string[] }>;
}

declare module 'cordis' {
  interface Context { harnessRegistry: SessionStore }
}
