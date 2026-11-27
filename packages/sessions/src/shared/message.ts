import type { SessionDisplayRecord } from './display-record.ts';
import type { MessageOrigin } from './queue.ts';
import type { RunTermination } from './run-state.ts';
import type { ToolResultState } from '@mini-harness/llm/api';
import type { InputAttachment } from '@mini-harness/input/message';

export interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  redacted?: boolean;
  name?: string;
  id?: string;
  data?: string;
  mimeType?: string;
}

export type MessageContent = string | ContentBlock[];

export interface ViewAttachment extends InputAttachment {
  data?: string;
}

interface MessageFields {
  type: 'message';
  id: string;
  runId?: string;
  submissionId?: string;
  inboxId?: string;
  origin?: MessageOrigin;
  parentId?: string | null;
  content: MessageContent;
  attachments?: ViewAttachment[];
  timestamp: number;
  error?: string;
  toolName?: string;
  toolCallId?: string;
  arguments?: unknown;
  details?: Record<string, unknown>;
  elapsedMs?: number;
}

export type ViewMessage = MessageFields &
  (
    | { role: 'user'; toolState?: never }
    | { role: 'assistant'; toolState?: never }
    | { role: 'toolResult'; toolState: ToolResultState; toolName: string; toolCallId: string }
  );

export type HistoryEntry = ViewMessage | SessionDisplayRecord | RunTermination;

export function isViewMessage(entry: HistoryEntry): entry is ViewMessage {
  return entry.type === 'message';
}
