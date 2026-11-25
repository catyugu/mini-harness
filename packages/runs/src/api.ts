import type {} from 'mini-harness/cordis';
import type { ThinkingLevel, ModelChoice } from '@mini-harness/llm/vocabulary';
import type { Attachment, InputSource } from '@mini-harness/input/message';
import type { RunEvent, StreamEvent } from './stream.js';
import type { QueueEntry } from '@mini-harness/sessions/queue';
import type { ExecutionHandle, ExecutionInput } from './execution.js';
import type { RunInfo } from '@mini-harness/sessions/run-state';

export interface RunPort {
  readonly size: number;
  readonly events: EventTarget;
  active(id: string): boolean;
  completion(id: string): Promise<unknown> | undefined;
  activity(id: string): { partial?: string; tools: Extract<StreamEvent, { type: 'tool' }>[] };
  signal(id: string, signal?: AbortSignal): AbortSignal | undefined;
  send(
    id: string,
    prompt: string,
    emit?: (event: StreamEvent) => void,
    options?: {
      signal?: AbortSignal;
      source?: InputSource;
      model?: ModelChoice;
      attachments?: Attachment[];
      thinkingLevel?: ThinkingLevel | null;
    },
  ): Promise<string>;
  submit(id: string, input: ExecutionInput, signal: AbortSignal): ExecutionHandle;
  startRun(
    id: string,
    prompt: string,
    options?: {
      model?: ModelChoice;
      attachments?: Attachment[];
      thinkingLevel?: ThinkingLevel | null;
    },
  ): RunInfo;
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
  cancel(id: string): boolean;
  compact(id: string): Promise<void>;
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessRuns: RunPort;
  }
}

declare module '@mini-harness/plugin-api/observations' {
  interface CapabilityObservations {
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
