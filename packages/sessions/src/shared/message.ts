import type { ContextCheckpoint, SessionDisplayRecord } from './display-record.ts';
import type { MessageOrigin } from './queue.ts';
import type { RunTermination } from './run-state.ts';
import type { ToolResultState } from '@mini-harness/tools/api';
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
  taskId?: string;
  parentId?: string | null;
  content: MessageContent;
  attachments?: ViewAttachment[];
  timestamp: number;
  error?: string;
  toolName?: string;
  toolCallId?: string;
  sessionId?: string;
  arguments?: unknown;
  isError?: boolean;
  elapsedMs?: number;
  approvalMs?: number;
  exitCode?: number;
}

export type ViewMessage = MessageFields &
  (
    | { role: 'user'; toolState?: never }
    | { role: 'assistant'; toolState?: never }
    | { role: 'toolResult'; toolState: ToolResultState; toolName: string; toolCallId: string }
  );

export type HistoryEntry = ViewMessage | SessionDisplayRecord | ContextCheckpoint | RunTermination;

export function isViewMessage(entry: HistoryEntry): entry is ViewMessage {
  return entry.type === 'message';
}
