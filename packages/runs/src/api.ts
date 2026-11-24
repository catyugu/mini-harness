import type {} from 'cordis';
import type { ThinkingLevel, ModelChoice } from '@mini-harness/llm/vocabulary';
import type { Attachment, InputSource } from '@mini-harness/input/message';
import type { RunEvent, StreamEvent } from './stream.js';
import type { RunInfo } from '@mini-harness/sessions/run-state';

export interface RunSelection {
  fallback: ModelChoice;
  acceptedModel?: (model: ModelChoice) => void | Promise<void>;
}

export interface RunPort {
  readonly size: number;
  readonly events: EventTarget;
  active(id: string): boolean;
  completion(id: string): Promise<unknown> | undefined;
  activity(id: string): { partial?: string; tools: Extract<StreamEvent, { type: 'tool' }>[] };
  signal(id: string, signal?: AbortSignal): AbortSignal | undefined;
  send(id: string, prompt: string, emit?: (event: StreamEvent) => void, options?: {
    signal?: AbortSignal; source?: InputSource; model?: ModelChoice; attachments?: Attachment[];
    thinkingLevel?: ThinkingLevel | null;
  }): Promise<string>;
  startRun(id: string, prompt: string, options?: {
    model?: ModelChoice; attachments?: Attachment[]; thinkingLevel?: ThinkingLevel | null;
  }): RunInfo;
  reviseAndStart(id: string, input: { sourceEntryId: string; expectedLeafId: string | null; message: string; removedImages?: number[];
    attachments?: Attachment[]; model?: ModelChoice; thinkingLevel?: ThinkingLevel | null }): Promise<RunInfo>;
  info(id: string): RunInfo | undefined;
  watch(id: string, runId: string, after: number, emit: (event: RunEvent) => void, end?: () => void): () => void;
  cancel(id: string): boolean;
  compact(id: string): Promise<void>;
}

declare module 'cordis' {
  interface Context { harnessRuns: RunPort }
  interface Events {
    'harness/run-selection'(source: InputSource): RunSelection | undefined;
  }
}

declare module '@mini-harness/kernel/observations' {
  interface CapabilityObservations {
    'run-started': { type: 'run-started'; sessionId: string; run: RunInfo };
    'run-ended': { type: 'run-ended'; sessionId: string; run: RunInfo };
  }
}
