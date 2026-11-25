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
  records(id: string, owner: RecordOwner): SessionRecords;
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessSessions: SessionDirectory;
  }
}
