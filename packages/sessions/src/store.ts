import type {} from 'cordis';
import type { ConversationPermission, SessionRecord } from './shared/identity.js';
import type { SessionLogPort } from './log-api.js';
import type { Attachment, ImageInput, PreparedMessage } from '@mini-harness/input/message';
import type { RunInfo } from './shared/run-state.js';

export interface SessionCatalog {
  readonly events: EventTarget;
  get(id: string): SessionRecord | undefined;
  list(workspaceId?: string): SessionRecord[];
  workspacePath(id: string): string;
  depth(id: string): number;
  descendants(ids: string[]): string[];
  modifiedAt(record: SessionRecord): string;
}

export interface SessionHistory {
  inspectLog<T>(id: string, read: (log: Pick<SessionLogPort, 'entries' | 'branch' | 'projection' | 'queue'>) => T, strict?: boolean): T | undefined;
  runSummary(id: string): RunInfo | undefined;
  logError(id: string): string | undefined;
  diagnostics(): { id: string; message: string }[];
}

export interface SessionLifecycle {
  create(input?: { parentId?: string | null; title?: string; workspaceId?: string; permission?: ConversationPermission }): SessionRecord;
  setPermission(id: string, permission: ConversationPermission): SessionRecord;
  rename(id: string, title: string, source?: SessionRecord['titleSource']): SessionRecord;
  assertAvailable(id?: string, workspaceId?: string): void;
  beforeDelete(handler: { quiesce(ids: string[]): Promise<void>; busy?(id: string): boolean }): () => void;
  export(ids: string[]): (SessionRecord & { log: string; attachments: Record<string, string> })[];
  delete(ids: string[]): Promise<string[]>;
}

/** The native persistence provider owns writers and their deletion transaction. */
export interface SessionStore extends SessionCatalog, SessionHistory, SessionLifecycle {
  log(id: string): SessionLogPort;
  prepareInput(id: string, text: unknown, attachments?: Attachment[]): { text: string; images: ImageInput[]; input: PreparedMessage };
  readAttachment(id: string, attachmentId: string): Buffer | undefined;
  attachmentDirectory(id: string): string | undefined;
}

declare module 'cordis' {
  interface Context { harnessRegistry: SessionStore }
}
