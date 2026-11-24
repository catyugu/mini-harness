import type {} from 'cordis';
import type { ConversationPermission, SessionRecord } from './shared/identity.js';
import type { SessionLogPort } from './log-api.js';
import type { RunInfo } from './shared/run-state.js';

/** Persistence and lifecycle operations for the native session capabilities. */
export interface SessionStore {
  readonly events: EventTarget;
  get(id: string): SessionRecord | undefined;
  list(workspaceId?: string): SessionRecord[];
  create(input?: { parentId?: string | null; title?: string; workspaceId?: string; permission?: ConversationPermission }): SessionRecord;
  setPermission(id: string, permission: ConversationPermission): SessionRecord;
  rename(id: string, title: string, source?: SessionRecord['titleSource']): SessionRecord;
  log(id: string): SessionLogPort;
  inspectLog<T>(id: string, read: (log: Pick<SessionLogPort, 'entries' | 'branch' | 'projection' | 'queue'>) => T, strict?: boolean): T | undefined;
  runSummary(id: string): RunInfo | undefined;
  logError(id: string): string | undefined;
  diagnostics(): { id: string; message: string }[];
  assertAvailable(id?: string, workspaceId?: string): void;
  beforeDelete(handler: { quiesce(ids: string[]): Promise<void>; busy?(id: string): boolean }): () => void;
  close(): void;
  recoverDeletion(): Promise<void>;
  workspacePath(id: string): string;
  depth(id: string): number;
  descendants(ids: string[]): string[];
  modifiedAt(record: SessionRecord): string;
  export(ids: string[]): (SessionRecord & { log: string })[];
  delete(ids: string[]): Promise<string[]>;
  deleteWorkspace(id: string): Promise<{ removed: string; deleted: string[] }>;
}

declare module 'cordis' {
  interface Context { harnessRegistry: SessionStore }
}
