import type { PluginRecord } from './records.ts';
import type { RecordPresentation } from './shared/display-record.ts';
import type { LogEntry } from './record-log.ts';
import type { MessageMode, MessageOrigin, QueueEntry } from './shared/queue.ts';
import type { ContentDelta } from './content-delta.ts';
import type { ThinkingLevel, ModelChoice, ModelSelection, ToolSchema } from '@mini-harness/llm/vocabulary';
import type { ImageInput, PreparedMessage } from '@mini-harness/input/message';
import type {
  LlmRequest,
  InputMeasurement,
  ModelRequestSnapshot,
  ModelRequestMetadata,
  NativeMessage,
  NativeToolMessage,
  NativeUsage,
} from '@mini-harness/llm/api';
import type { HistoryEntry } from './shared/message.ts';

export interface InboxItem {
  id: string;
  mode: MessageMode;
  origin?: MessageOrigin;
  resume?: true;
  text: string;
  images: ImageInput[];
  input?: PreparedMessage;
  model?: ModelSelection;
  thinkingLevel?: ThinkingLevel | null;
}

/** Changes relative to the parent branch's model context, not a copied transcript. */
export interface MessagePatch {
  start: number;
  deleteCount: number;
  insert: NativeMessage[];
}

export type RecordedModelRequest = Omit<ModelRequestMetadata, 'tools'> & {
  toolSchema?: string;
  purpose?: 'summary';
  messagesPatch?: MessagePatch;
};

/** Replace intervals of the parent branch's effective context atomically. */
export interface ContextReplacement extends MessagePatch {
  /** Keep the original content reference for one-for-one edits. */
  preserveSource?: true;
}

export interface ModelAttempt {
  requestId: string;
  runId?: string;
  summary?: true;
  step?: number;
  elapsedMs: number;
  firstTokenMs?: number;
  usage?: NativeUsage;
}

/** The durable session protocol is independent of any model SDK. */
type SessionOperation<Data = unknown> =
  | {
      type: 'message';
      message: NativeMessage;
      presentation?: PreparedMessage;
      elapsedMs?: number;
      submissionId?: string;
      inboxId?: string;
      origin?: MessageOrigin;
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
      code: 'invalid-tool-calls' | 'executor-response';
      data: unknown;
    }
  | PluginRecord<Data>
  | {
      type: 'context-replace';
      replacements: ContextReplacement[];
      measurement?: InputMeasurement & { model: ModelChoice };
    }
  | ({ type: 'model-attempt' } & ModelAttempt)
  | { type: 'session-setting'; owner: string; value: unknown }
  | { type: 'inbox-enqueued'; item: InboxItem }
  | { type: 'inbox-paused' }
  | { type: 'inbox-consumed' | 'inbox-cancelled'; ids: string[]; reason?: string }
  | { type: 'inbox-failed'; inboxId: string; reason: string }
  | { type: 'branch' };

export type SessionEvent<Data = unknown> = SessionOperation<Data> & {
  displays?: readonly RecordPresentation[];
};

export type SessionEntry<Data = unknown> = LogEntry<SessionEvent<Data>>;

export type PluginEntry<Data> = Extract<SessionEntry<Data>, { type: 'plugin-record' }>;

export interface SessionContext {
  leafId: string | null;
  /** Effective messages on the selected branch after applying replacements. */
  contextMessages: NativeMessage[];
  /** Original entry IDs parallel to contextMessages. Synthetic entries use their replacement record ID. */
  contextEntryIds: string[];
  model?: ModelChoice;
  thinkingLevel?: ThinkingLevel;
}

export interface SessionProjection extends SessionContext {
  timeline: HistoryEntry[];
  timelineSequences: number[];
}

export interface SessionLogPort {
  readonly sessionId: string;
  entries(after?: number): SessionEntry[];
  /** Fetch the pre-pruning message or, for tool results, the raw execution before transforms. */
  originalMessage(id: string, raw?: boolean): NativeMessage | undefined;
  setting(owner: string): unknown;
  inbox(): InboxItem[];
  hasInbox(id: string): boolean;
  inboxPaused(): boolean;
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
  context(leafId?: string | null): SessionContext;
  projection(leafId?: string | null): SessionProjection;
  /** Persist the exact model-visible request, sharing schemas and branch context. */
  recordRequest(snapshot: Omit<LlmRequest, 'signal'>, purpose?: 'summary'): SessionEntry;
  /** Commit the model-visible content of a previously recorded raw execution. */
  acceptToolResult(executionId: string, content: NativeToolMessage['content']): SessionEntry;
  /** Read the stable components of a recorded request without materializing its messages. */
  requestDefinition(id: string): ModelRequestMetadata;
  /** Reconstruct exact model-visible inputs for audits, including distinct tool schemas. */
  requestSnapshot(id: string): ModelRequestSnapshot;
}

/** Non-mutating operations available while inspecting a closed conversation log. */
export type SessionLogReader = Pick<
  SessionLogPort,
  | 'entries'
  | 'setting'
  | 'context'
  | 'requestDefinition'
  | 'requestSnapshot'
  | 'branch'
  | 'projection'
  | 'queue'
  | 'inbox'
  | 'inboxPaused'
>;
