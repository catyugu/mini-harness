export interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  data?: string;
  mimeType?: string;
}

export type MessageContent = string | ContentBlock[];

export interface ViewMessage {
  /** Stable Pi JSONL entry identity for persisted messages (absent for stream previews). */
  id?: string;
  parentId?: string | null;
  role: 'user' | 'assistant' | 'toolResult';
  content: MessageContent;
  timestamp: number;
  error?: string;
  toolName?: string;
  toolCallId?: string;
  sessionId?: string;
  arguments?: unknown;
  isError?: boolean;
  elapsedMs?: number;
  exitCode?: number;
}
