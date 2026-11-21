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
  role: 'user' | 'assistant' | 'toolResult';
  content: MessageContent;
  timestamp: number;
  error?: string;
  toolName?: string;
  toolCallId?: string;
  sessionId?: string;
  isError?: boolean;
}

export type StreamEvent =
  | { type: 'assistant-start' }
  | { type: 'delta' | 'complete'; text: string }
  | { type: 'tool'; id: string; name: string; state: 'running' | 'finished' | 'error'; content?: MessageContent; sessionId?: string }
  | { type: 'error'; error: string };
