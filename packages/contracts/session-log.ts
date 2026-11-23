import type { ThinkingLevel } from './agent.js';
import type { ModelChoice } from './conversation.js';
import type { ImageInput, PreparedMessage } from './input.js';
import type { NativeMessage } from './llm.js';
import type { ViewMessage } from './message.js';
import type { RunInfo } from './transport.js';

export interface InboxItem {
  id: string;
  mode: 'steer' | 'followUp';
  text: string;
  images: ImageInput[];
  input?: PreparedMessage;
}

/** The durable session protocol is independent of any model SDK. */
export type SessionEvent =
  | { type: 'message'; message: NativeMessage; presentation?: PreparedMessage; elapsedMs?: number; inboxId?: string }
  | { type: 'model'; model: ModelChoice }
  | { type: 'thinking'; level: ThinkingLevel }
  | { type: 'custom'; namespace: string; data: unknown }
  | { type: 'compaction'; summary: string; keepFromId: string | null; tokensBefore?: number }
  | { type: 'context-edit'; targetId: string; replacement: NativeMessage['content'] | null }
  | { type: 'inbox-enqueued'; item: InboxItem }
  | { type: 'inbox-consumed' | 'inbox-cancelled'; ids: string[]; reason?: string }
  | { type: 'run'; run: RunInfo }
  | { type: 'branch' };

export type SessionEntry = SessionEvent & {
  version: 1;
  seq: number;
  id: string;
  parentId: string | null;
  timestamp: string;
};

export interface SessionProjection {
  leafId: string | null;
  messages: ViewMessage[];
  /** Selected branch after the latest compaction, including its summary. */
  contextMessages: NativeMessage[];
  /** Stable source identity parallel to contextMessages; summaries use their compaction event ID. */
  contextEntryIds: string[];
  model?: ModelChoice;
  thinkingLevel: ThinkingLevel;
  inbox: InboxItem[];
  run?: RunInfo;
}

export interface SessionLogPort {
  readonly file: string;
  readonly sessionId: string;
  entries(): SessionEntry[];
  branch(leafId?: string | null): SessionEntry[];
  /** Returns only after the complete record has been flushed to durable storage. */
  append(event: SessionEvent, expectedLeafId?: string | null): SessionEntry;
  /** Starts a new active branch, preserving prior branches in the log. */
  select(leafId: string | null, expectedLeafId?: string | null): SessionEntry;
  projection(leafId?: string | null): SessionProjection;
  close(): void;
}
