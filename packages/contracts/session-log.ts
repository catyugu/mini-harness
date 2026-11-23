import type { ThinkingLevel } from './agent.js';
import type { ModelChoice } from './conversation.js';
import type { ImageInput, PreparedMessage } from './input.js';
import type { ModelRequestSnapshot, NativeMessage, NativeToolMessage } from './llm.js';
import type { ToolSchema } from './tools.js';
import type { ViewMessage } from './message.js';
import type { RunInfo } from './transport.js';

export interface InboxItem {
  id: string;
  mode: 'steer' | 'followUp';
  text: string;
  images: ImageInput[];
  input?: PreparedMessage;
}

/** Changes relative to the parent branch's model context, not a copied transcript. */
export interface MessagePatch {
  start: number;
  deleteCount: number;
  insert: NativeMessage[];
}

/** JSON-string splice, avoiding a second copy of a large tool result. */
export interface ContentDelta {
  prefix: number;
  suffix: number;
  insert: string;
}

export type RecordedModelRequest = Omit<ModelRequestSnapshot, 'messages' | 'tools'> & {
  toolSchema?: string;
  messagesPatch?: MessagePatch;
};

/** The durable session protocol is independent of any model SDK. */
export type SessionEvent =
  | { type: 'message'; message: NativeMessage; presentation?: PreparedMessage; elapsedMs?: number; inboxId?: string }
  /** Tool definitions are written once per distinct content and referenced by model requests. */
  | { type: 'tool-schema'; hash: string; tools: ToolSchema[] }
  /** The request references its parent branch's context and an optional minimal splice. */
  | { type: 'model-request'; request: RecordedModelRequest }
  | { type: 'tool-execution'; result: NativeToolMessage }
  /** A committed model-visible projection of the recorded raw execution. */
  | { type: 'tool-accepted'; executionId: string; contentDelta?: ContentDelta }
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
  /** Reconstruct exact model-visible inputs for audits, including distinct tool schemas. */
  requestSnapshot(id: string): ModelRequestSnapshot & { messages: NativeMessage[] };
  close(): void;
}
