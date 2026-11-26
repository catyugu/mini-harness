import type { PluginRecord } from './records.ts';
import type { TaskHistoryRecord } from '@mini-harness/tasks/api';
import type { LogEntry } from './record-log.ts';
import type { QueueEntry } from './shared/queue.ts';
import type { ContentDelta } from './content-delta.ts';
import type { ThinkingLevel, ModelChoice, ToolSchema } from '@mini-harness/llm/vocabulary';
import type { ImageInput, PreparedMessage } from '@mini-harness/input/message';
import type {
  LlmRequest,
  ModelRequestSnapshot,
  NativeMessage,
  NativeToolMessage,
} from '@mini-harness/llm/api';
import type { HistoryEntry } from './shared/message.ts';
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
export type SessionEvent<Data = unknown> =
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
  | PluginRecord<Data>
  | { type: 'compaction'; summary: string; keepFromId: string | null; tokensBefore?: number }
  | { type: 'context-edit'; targetId: string; replacement: NativeMessage['content'] | null }
  | { type: 'inbox-enqueued'; item: InboxItem }
  | { type: 'inbox-consumed' | 'inbox-cancelled'; ids: string[]; reason?: string }
  | { type: 'inbox-failed'; inboxId: string; reason: string }
  | { type: 'run'; run: RunInfo }
  | ({ type: 'task' } & TaskHistoryRecord)
  | { type: 'branch' };

export type SessionEntry<Data = unknown> = LogEntry<SessionEvent<Data>>;

export interface SessionProjection {
  leafId: string | null;
  timeline: HistoryEntry[];
  /** Selected branch after the latest compaction, including its summary. */
  contextMessages: NativeMessage[];
  /** Stable source identity parallel to contextMessages; summaries use their compaction event ID. */
  contextEntryIds: string[];
  model?: ModelChoice;
  thinkingLevel?: ThinkingLevel;
  run?: RunInfo;
}

export interface SessionLogPort {
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
  /** Persist the exact model-visible request, sharing schemas and branch context. */
  recordRequest(snapshot: Omit<LlmRequest, 'signal'>): SessionEntry;
  /** Commit the model-visible content of a previously recorded raw execution. */
  acceptToolResult(executionId: string, content: NativeToolMessage['content']): SessionEntry;
  /** Reconstruct exact model-visible inputs for audits, including distinct tool schemas. */
  requestSnapshot(id: string): ModelRequestSnapshot & { messages: NativeMessage[] };
}
