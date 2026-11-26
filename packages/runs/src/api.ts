import type { ThinkingLevel, ModelChoice } from '@mini-harness/llm/vocabulary';
import type { Attachment, InputSource } from '@mini-harness/input/message';
import type { RunEvent, StreamEvent, ToolProgress } from './stream.ts';
import type { QueueEntry } from '@mini-harness/sessions/queue';
import type { TaskHandle, TaskOptions } from '@mini-harness/tasks/api';
import type { RunInfo } from '@mini-harness/sessions/run-state';

export interface RunInput {
  message: string;
  model?: ModelChoice;
  thinkingLevel?: ThinkingLevel | null;
  attachments?: Attachment[];
}

export interface RunSubmission extends Pick<TaskOptions, 'signal' | 'pool' | 'metadata' | 'provider'> {
  source?: InputSource;
  emit?(event: StreamEvent): void;
}

export interface RunPort {
  readonly events: EventTarget;
  current(id: string): TaskHandle | undefined;
  activity(id: string): { partial?: string; tools: ToolProgress[] };
  submit(id: string, input: RunInput, options?: RunSubmission): TaskHandle<string>;
  reviseAndStart(
    id: string,
    input: {
      sourceEntryId: string;
      expectedLeafId: string | null;
      message: string;
      removedImages?: number[];
      attachments?: Attachment[];
      model?: ModelChoice;
      thinkingLevel?: ThinkingLevel | null;
    },
  ): Promise<RunInfo>;
  retryInput(
    id: string,
    runId: string,
  ):
    | {
        message: string;
        attachments: Attachment[];
        missing: string[];
        model?: ModelChoice;
        thinkingLevel?: ThinkingLevel;
      }
    | undefined;
  info(id: string): RunInfo | undefined;
  watch(
    id: string,
    runId: string,
    after: number,
    emit: (event: RunEvent) => void,
    end?: () => void,
  ): () => void;
  queueInput(
    id: string,
    input: {
      message: string;
      mode: 'steer' | 'followUp';
      model?: ModelChoice;
      attachments?: Attachment[];
      thinkingLevel?: ThinkingLevel | null;
    },
  ): QueueEntry[];
  cancelQueue(id: string, itemId?: string, signal?: AbortSignal): Promise<QueueEntry[]>;
  compact(id: string): Promise<void>;
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessRuns: RunPort;
  }
}

declare module '@mini-harness/plugin-api/observations' {
  interface CapabilityObservations {
    'run-started': { type: 'run-started'; sessionId: string; run: RunInfo };
    'run-ended': { type: 'run-ended'; sessionId: string; run: RunInfo };
    'input-accepted': {
      type: 'input-accepted';
      sessionId: string;
      parentId?: string | null;
      source: InputSource;
      runSource: InputSource;
      model: ModelChoice;
    };
  }
}
