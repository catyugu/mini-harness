import type { MessageContent } from '@mini-harness/sessions/message';

export class RunInterrupted extends Error {
  constructor() { super('The service stopped before the run finished'); }
}

export type AgentEvent =
  | { type: 'assistant-start' }
  | { type: 'assistant-end'; id?: string }
  | { type: 'user'; id?: string; submissionId?: string; timestamp?: number; content: MessageContent; attachments?: import('@mini-harness/input/message').InputAttachment[] }
  | { type: 'delta' | 'complete'; text: string }
  | { type: 'tool'; id: string; name: string; state: 'approval' | 'running' | 'finished' | 'denied' | 'error'; arguments?: unknown; content?: MessageContent; sessionId?: string; elapsedMs?: number; approvalMs?: number; exitCode?: number }
  | { type: 'error'; error: string };
