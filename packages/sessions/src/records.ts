import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import type { ViewMessage } from './shared/message.ts';
import type { SessionRecord } from './shared/identity.ts';

export interface RecordDisplay {
  title: string;
  content?: unknown;
}
export interface RecordOwner {
  pluginId: string;
  instanceId: string;
}

export interface SessionRecords {
  list(): { id: string; timestamp: string; data: unknown }[];
  append(data: unknown, display?: RecordDisplay): Promise<string>;
}

export interface RecordProjection<State> {
  initial(): State;
  reduce(state: State, record: ReturnType<SessionRecords['list']>[number]): State;
}

export interface SessionDirectory {
  get(id: string): SessionRecord | undefined;
  list(workspaceId?: string): SessionRecord[];
  create(input?: { parentId?: string; title?: string; workspaceId?: string }): SessionRecord;
  rename(id: string, title: string): SessionRecord;
  depth(id: string): number;
  workspacePath(id: string): string;
  history(id: string): { messages: ViewMessage[]; leafId: string | null; model?: ModelChoice };
  records(id: string, owner: RecordOwner): SessionRecords;
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessSessions: SessionDirectory;
  }
}
