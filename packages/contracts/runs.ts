import type {} from 'cordis';
import type { ThinkingLevel } from './agent.js';
import type { ModelChoice } from './conversation.js';
import type { Attachment, InputSource } from './input.js';
import type { RunEvent, RunInfo, StreamEvent } from './transport.js';

export interface RunPort {
  readonly size: number;
  readonly events: EventTarget;
  active(id: string): boolean;
  activeInScope(scopes: ReadonlySet<string>): boolean;
  completion(id: string): Promise<unknown> | undefined;
  view(id: string): { run?: RunInfo; partial?: string; tools: Extract<StreamEvent, { type: 'tool' }>[] };
  signal(id: string, signal?: AbortSignal): AbortSignal | undefined;
  send(id: string, prompt: string, emit?: (event: StreamEvent) => void, options?: {
    signal?: AbortSignal; source?: InputSource; model?: ModelChoice; attachments?: Attachment[];
    schedule?: (task: () => Promise<string>, signal: AbortSignal) => Promise<string>;
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
