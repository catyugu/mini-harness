import type { MessageContent, ViewAttachment, ViewMessage } from '@mini-harness/sessions/message';
import type { RecordAppend } from '@mini-harness/sessions/display-record';
import type { InputSource } from '@mini-harness/input/message';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import type { SessionProjection } from '@mini-harness/sessions/log-api';
import type { ToolResultState } from '@mini-harness/tools/api';
import type { RunInfo } from '@mini-harness/sessions/run-state';

export type StreamEvent =
  | AgentEvent
  | { type: 'run'; run: RunInfo }
  | ({ type: 'branch' } & RecordAppend)
  | ({
      type: 'snapshot';
      partial?: string;
      tools?: ToolProgress[];
      run: RunInfo;
    } & Pick<SessionProjection, 'timeline' | 'model' | 'thinkingLevel' | 'leafId'>);

export type ToolProgress = Extract<Extract<AgentEvent, { type: 'tool' }>, { entry?: never }>;

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
      attachments?: ViewAttachment[];
    }
  | { type: 'delta' | 'complete'; text: string }
  | ({
      type: 'tool';
      id: string;
      name: string;
      arguments?: unknown;
      content?: MessageContent;
      sessionId?: string;
      elapsedMs?: number;
      approvalMs?: number;
      exitCode?: number;
    } & (
      | { state: 'approval' | 'running'; entry?: never }
      | {
          state: ToolResultState;
          isError: boolean;
          entry: { id: string; parentId: string | null; timestamp: number };
        }
    ))
  | { type: 'error'; error: string };
