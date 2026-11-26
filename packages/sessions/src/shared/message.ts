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

export interface ViewMessage {
  /** Stable Session Log entry identity (absent for stream previews). */
  id?: string;
  runId?: string;
  submissionId?: string;
  inboxId?: string;
  parentId?: string | null;
  role: 'user' | 'assistant' | 'toolResult';
  content: MessageContent;
  attachments?: InputAttachment[];
  timestamp: number;
  error?: string;
  toolName?: string;
  toolCallId?: string;
  sessionId?: string;
  arguments?: unknown;
  isError?: boolean;
  elapsedMs?: number;
  approvalMs?: number;
  toolState?: ToolResultState;
  exitCode?: number;
}
