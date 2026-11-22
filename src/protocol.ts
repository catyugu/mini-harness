export interface SessionFact { id: string; kind: string; timestamp: string; data: unknown }

export interface TodoItem { id: string; text: string; state: 'pending' | 'in-progress' | 'completed' }

export interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  data?: string;
  mimeType?: string;
  thinking?: string;
  arguments?: unknown;
}

export type MessageContent = string | ContentBlock[];

export interface ViewMessage {
  id?: string;
  runId?: string;
  elapsedMs?: number;
  details?: unknown;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };
  role: 'user' | 'assistant' | 'toolResult';
  content: MessageContent;
  timestamp: number;
  error?: string;
  toolName?: string;
  toolCallId?: string;
  sessionId?: string;
  arguments?: unknown;
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
  changedFiles?: string[];
}

export const isRunning = (run?: RunInfo) => run?.state === 'queued' || run?.state === 'running';

export type StreamEvent =
  | { type: 'assistant-start' | 'assistant-end' }
  | { type: 'user'; text: string; content?: MessageContent }
  | { type: 'delta' | 'complete'; text: string }
  | { type: 'tool'; id: string; name: string; state: 'running' | 'finished' | 'error'; arguments?: unknown; content?: MessageContent; sessionId?: string; elapsedMs?: number; details?: unknown }
  | { type: 'todos'; items: TodoItem[] }
  | { type: 'approval'; approval: { id: string; sessionId: string; command: string; state: 'pending' | 'allowed' | 'denied' | 'expired' | 'cancelled'; createdAt: string } }
  | { type: 'error'; error: string }
  | { type: 'run'; run: RunInfo }
  | { type: 'snapshot'; messages: ViewMessage[]; partial?: string; tools?: Extract<StreamEvent, { type: 'tool' }>[]; run: RunInfo };

export type RunEvent = StreamEvent & { sequence: number };
