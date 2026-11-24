import type {} from 'cordis';
import { extension, type ContributionSource } from '@mini-harness/kernel/contributions';
import type { ThinkingLevel, ModelChoice } from '@mini-harness/llm/vocabulary';
import type { Attachment, InputSource } from '@mini-harness/input/message';
import type { RunEvent, StreamEvent } from './stream.js';
import type { RunInfo } from '@mini-harness/sessions/run-state';

export interface ExecutionOptions {
  signal?: AbortSignal;
  source?: 'agent' | 'plugin';
  model?: ModelChoice;
  attachments?: Attachment[];
  thinkingLevel?: ThinkingLevel | null;
  /** Acquire a scheduling lease; only Runs invokes the actual execution. */
  acquire?(signal: AbortSignal): Promise<() => void>;
}

export interface ExecutionAccess {
  send(id: string, prompt: string, options?: ExecutionOptions): Promise<string>;
  info(id: string): RunInfo | undefined;
  model(id: string): ModelChoice;
  cancel(id: string): boolean;
  signal(id: string, signal?: AbortSignal): AbortSignal;
}

export const bindExecution = Symbol.for('mini-harness.executionAccess');
interface ExecutionProvider {
  [bindExecution](source: ContributionSource): ExecutionAccess;
}

export const runExtensions = {
  access: extension((source) => source.service('harnessRuns')[bindExecution](source))
};

declare module '@mini-harness/kernel/services' {
  interface ServiceMap { harnessRuns: ExecutionProvider }
}

export interface RunPort extends ExecutionProvider {
  readonly size: number;
  readonly events: EventTarget;
  active(id: string): boolean;
  activeInScope(scopes: ReadonlySet<string>): boolean;
  completion(id: string): Promise<unknown> | undefined;
  activity(id: string): { partial?: string; tools: Extract<StreamEvent, { type: 'tool' }>[] };
  signal(id: string, signal?: AbortSignal): AbortSignal | undefined;
  send(id: string, prompt: string, emit?: (event: StreamEvent) => void, options?: {
    signal?: AbortSignal; source?: InputSource; model?: ModelChoice; attachments?: Attachment[];
    acquire?: (signal: AbortSignal) => Promise<() => void>;
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
  stop(): Promise<void>;
}

declare module 'cordis' {
  interface Context { harnessRuns: RunPort }
}

declare module '@mini-harness/kernel/observations' {
  interface CapabilityObservations {
    'run-started': { type: 'run-started'; sessionId: string; run: RunInfo };
    'run-ended': { type: 'run-ended'; sessionId: string; run: RunInfo };
  }
}
