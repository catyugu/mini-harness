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

export interface RunInfo {
  id: string;
  sessionId: string;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  startedAt: string;
  finishedAt?: string;
  error?: string;
  sequence: number;
}

export const isRunning = (run?: RunInfo) => run?.state === 'queued' || run?.state === 'running';

export type StreamEvent =
  | { type: 'assistant-start' | 'assistant-end' }
  | { type: 'user'; text: string }
  | { type: 'delta' | 'complete'; text: string }
  | { type: 'tool'; id: string; name: string; state: 'running' | 'finished' | 'error'; content?: MessageContent; sessionId?: string }
  | { type: 'error'; error: string }
  | { type: 'run'; run: RunInfo }
  | { type: 'snapshot'; messages: ViewMessage[]; partial?: string; tools?: Extract<StreamEvent, { type: 'tool' }>[]; run: RunInfo };

export type RunEvent = StreamEvent & { sequence: number };
