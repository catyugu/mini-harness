import type {} from 'cordis';
import type { ConversationPermission, SessionRecord } from './shared/identity.js';
import type { SessionLogPort } from './log-api.js';
import type { RunInfo } from './shared/run-state.js';

/** Session identity and hierarchy. */
export interface SessionDirectory {
  readonly events: EventTarget;
  get(id: string): SessionRecord | undefined;
  list(workspaceId?: string): SessionRecord[];
  create(input?: { parentId?: string | null; title?: string; workspaceId?: string; permission?: ConversationPermission }): SessionRecord;
  setPermission(id: string, permission: ConversationPermission): SessionRecord;
  rename(id: string, title: string, source?: SessionRecord['titleSource']): SessionRecord;
  workspacePath(id: string): string;
  depth(id: string): number;
  descendants(ids: string[]): string[];
  modifiedAt(record: SessionRecord): string;
}

/** History access, including the internal native log writer. */
export interface SessionHistory {
  log(id: string): SessionLogPort;
  inspectLog<T>(id: string, read: (log: Pick<SessionLogPort, 'entries' | 'branch' | 'projection' | 'queue'>) => T, strict?: boolean): T | undefined;
  runSummary(id: string): RunInfo | undefined;
  logError(id: string): string | undefined;
  diagnostics(): { id: string; message: string }[];
  export(ids: string[]): (SessionRecord & { log: string })[];
}

/** Admission and coordinated deletion. */
export interface SessionLifecycle {
  assertAvailable(id?: string, workspaceId?: string): void;
  beforeDelete(handler: { quiesce(ids: string[]): Promise<void>; busy?(id: string): boolean }): () => void;
  delete(ids: string[]): Promise<string[]>;
}

/** The native registry shares one storage lifetime across these contracts. */
export type SessionStore = SessionDirectory & SessionHistory & SessionLifecycle;

declare module 'cordis' {
  interface Context { harnessRegistry: SessionStore }
}
