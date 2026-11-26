import type { MessageContent, ViewMessage } from '@mini-harness/sessions/message';
import type { RecordAppend } from '@mini-harness/sessions/display-record';
import type { RecordUpdate, SessionDisplayRecord } from '@mini-harness/sessions/display-record';
import type { InputSource } from '@mini-harness/input/message';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import type { SessionProjection } from '@mini-harness/sessions/log-api';
import type { RunInfo } from '@mini-harness/sessions/run-state';

export type StreamEvent =
  | AgentEvent
  | { type: 'run'; run: RunInfo }
  | ({ type: 'branch' } & RecordAppend)
  | ({
      type: 'snapshot';
      partial?: string;
      tools?: ToolProgress[];
      records: SessionDisplayRecord[];
      run: RunInfo;
    } & Pick<SessionProjection, 'timeline' | 'model' | 'thinkingLevel' | 'leafId'>);

export interface ToolProgress {
  type: 'tool';
  id: string;
  name: string;
  state: 'approval' | 'running';
  arguments?: unknown;
  content?: MessageContent;
}

export type RunEvent = StreamEvent & { runId: string; runSessionId: string; sequence: number };

export type AgentEvent =
  | RecordUpdate
  | { type: 'assistant-start' }
  | { type: 'assistant-end'; message: Extract<ViewMessage, { role: 'assistant' }> }
  | { type: 'tool-end'; message: Extract<ViewMessage, { role: 'toolResult' }> }
  | {
      type: 'user';
      source: InputSource;
      model: ModelChoice;
      thinkingLevel?: import('@mini-harness/llm/vocabulary').ThinkingLevel;
      revised: boolean;
      message: Extract<ViewMessage, { role: 'user' }>;
    }
  | { type: 'delta' | 'complete'; text: string }
  | ToolProgress
  | { type: 'error'; error: string };
