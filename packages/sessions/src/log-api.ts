import type { RecordDisplay, RecordOwner } from './records.ts';
import type { SessionDisplayRecord } from './shared/display-record.ts';
import type { QueueEntry } from './shared/queue.ts';
import type { ContentDelta } from './content-delta.ts';
import type { ThinkingLevel, ModelChoice, ToolSchema } from '@mini-harness/llm/vocabulary';
import type { ImageInput, PreparedMessage } from '@mini-harness/input/message';
import type { ModelRequestSnapshot, NativeMessage, NativeToolMessage } from '@mini-harness/llm/api';
import type { ViewMessage } from './shared/message.ts';
import type { RunInfo } from './shared/run-state.ts';

export interface InboxItem {
  id: string;
  mode: 'steer' | 'followUp';
  text: string;
  images: ImageInput[];
  input?: PreparedMessage;
  model?: ModelChoice;
  thinkingLevel?: ThinkingLevel | null;
}

/** Changes relative to the parent branch's model context, not a copied transcript. */
export interface MessagePatch {
  start: number;
  deleteCount: number;
  insert: NativeMessage[];
}

export type RecordedModelRequest = Omit<ModelRequestSnapshot, 'messages' | 'tools'> & {
  toolSchema?: string;
  messagesPatch?: MessagePatch;
};

/** The durable session protocol is independent of any model SDK. */
export type SessionEvent =
  | {
      type: 'message';
      message: NativeMessage;
      presentation?: PreparedMessage;
      elapsedMs?: number;
      submissionId?: string;
      inboxId?: string;
      selection?: { model: ModelChoice; thinkingLevel?: ThinkingLevel };
    }
  /** Tool definitions are written once per distinct content and referenced by model requests. */
  | { type: 'tool-schema'; hash: string; tools: ToolSchema[] }
  /** The request references its parent branch's context and an optional minimal splice. */
  | { type: 'model-request'; request: RecordedModelRequest }
  | { type: 'tool-execution'; result: NativeToolMessage }
  /** A committed model-visible projection of the recorded raw execution. */
  | { type: 'tool-accepted'; executionId: string; contentDelta?: ContentDelta }
  | { type: 'model'; model: ModelChoice }
  | { type: 'thinking'; level: ThinkingLevel | null }
  | {
      type: 'diagnostic';
      code: 'invalid-tool-calls' | 'executor-response' | 'historical-record';
      data: unknown;
    }
  | { type: 'plugin-record'; owner: RecordOwner; data: unknown; display?: RecordDisplay }
  | { type: 'compaction'; summary: string; keepFromId: string | null; tokensBefore?: number }
  | { type: 'context-edit'; targetId: string; replacement: NativeMessage['content'] | null }
  | { type: 'inbox-enqueued'; item: InboxItem }
  | { type: 'inbox-consumed' | 'inbox-cancelled'; ids: string[]; reason?: string }
  | { type: 'inbox-failed'; inboxId: string; reason: string }
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
  records: SessionDisplayRecord[];
  /** Selected branch after the latest compaction, including its summary. */
  contextMessages: NativeMessage[];
  /** Stable source identity parallel to contextMessages; summaries use their compaction event ID. */
  contextEntryIds: string[];
  model?: ModelChoice;
  thinkingLevel?: ThinkingLevel;
  run?: RunInfo;
}

export interface SessionLogPort {
  readonly file: string;
  readonly sessionId: string;
  entries(): SessionEntry[];
  inbox(): InboxItem[];
  queue(): QueueEntry[];
  branch(leafId?: string | null): SessionEntry[];
  /** Returns only after the complete record has been flushed to durable storage. */
  append(event: SessionEvent, expectedLeafId?: string | null): SessionEntry;
  /** Commits a replacement message and makes its branch active in one record. */
  revise(
    event: Extract<SessionEvent, { type: 'message' }>,
    parentId: string | null,
    expectedLeafId: string | null,
  ): SessionEntry;
  projection(leafId?: string | null): SessionProjection;
  /** Reconstruct exact model-visible inputs for audits, including distinct tool schemas. */
  requestSnapshot(id: string): ModelRequestSnapshot & { messages: NativeMessage[] };
  close(): void;
}
