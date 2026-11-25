import type { MessageContent, ViewMessage } from '@mini-harness/sessions/message';
import type { InputSource } from '@mini-harness/input/message';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import type { SessionProjection } from '@mini-harness/sessions/log-api';
import type { RunInfo } from '@mini-harness/sessions/run-state';

export type StreamEvent =
  | AgentEvent
  | { type: 'run'; run: RunInfo }
  | ({ type: 'branch' } & Pick<SessionProjection, 'records' | 'leafId'>)
  | ({
      type: 'snapshot';
      partial?: string;
      tools?: Extract<StreamEvent, { type: 'tool' }>[];
      run: RunInfo;
    } & Pick<SessionProjection, 'messages' | 'records' | 'model' | 'thinkingLevel' | 'leafId'>);

export type RunEvent = StreamEvent & { runId: string; runSessionId: string; sequence: number };

export class RunInterrupted extends Error {
  constructor() {
    super('The service stopped before the run finished');
  }
}

export type AgentEvent =
  | { type: 'assistant-start' }
  | { type: 'assistant-end'; message: ViewMessage }
  | {
      type: 'user';
      source: InputSource;
      model: ModelChoice;
      id: string;
      parentId: string | null;
      revised: boolean;
      submissionId?: string;
      inboxId?: string;
      timestamp: number;
      thinkingLevel?: import('@mini-harness/llm/vocabulary').ThinkingLevel;
      content: MessageContent;
      attachments?: import('@mini-harness/input/message').InputAttachment[];
    }
  | { type: 'delta' | 'complete'; text: string }
  | {
      type: 'tool';
      id: string;
      name: string;
      state: 'approval' | 'running' | 'finished' | 'denied' | 'error';
      arguments?: unknown;
      content?: MessageContent;
      sessionId?: string;
      elapsedMs?: number;
      approvalMs?: number;
      exitCode?: number;
      entry?: { id: string; parentId: string | null; timestamp: number };
    }
  | { type: 'error'; error: string };
