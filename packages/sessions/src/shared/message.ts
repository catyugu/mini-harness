import type { SessionDisplayRecord } from './display-record.ts';
import type { MessageOrigin } from './queue.ts';
import type {
  NativeAssistantMessage,
  NativeContent,
  NativeToolMessage,
  TextPart,
  ToolResultState,
} from '@mini-harness/llm/api';
import type { InputAttachment } from '@mini-harness/input/message';

export type MessageContent = NativeContent[];

export interface ViewAttachment extends InputAttachment {
  data?: string;
}

interface MessageFields {
  type: 'message';
  id: string;
  runId?: string;
  parentId: string | null;
  timestamp: number;
}

export interface UserViewMessage extends MessageFields {
  role: 'user';
  content: TextPart[];
  attachments: ViewAttachment[];
  submissionId?: string;
  inboxId?: string;
  origin?: MessageOrigin;
}

export interface AssistantViewMessage extends MessageFields {
  role: 'assistant';
  content: NativeAssistantMessage['content'];
  error?: string;
}

export interface ToolViewMessage extends MessageFields {
  role: 'toolResult';
  content: NativeToolMessage['content'];
  toolName: string;
  toolCallId: string;
  toolState: ToolResultState;
  arguments?: unknown;
  details?: Record<string, unknown>;
  elapsedMs?: number;
}

export type ViewMessage = UserViewMessage | AssistantViewMessage | ToolViewMessage;

export type HistoryEntry = ViewMessage | SessionDisplayRecord;

export function isViewMessage(entry: { type: string }): entry is ViewMessage {
  return entry.type === 'message';
}
