export type TaskState =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export const terminal = (state: TaskState) =>
  state !== 'queued' && state !== 'running' && state !== 'waiting';

/** Acquire a caller-defined execution slot. Release is called exactly once per acquisition. */
export type TaskAdmission = (signal: AbortSignal) => Promise<() => void>;

export interface TaskOptions {
  /** A resource lifetime key or another task's ID, independent of the creator. */
  owner: string;
  creator?: string;
  name?: string;
  type?: string;
  resourceId?: string;
  metadata?: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
  acquire?: TaskAdmission;
  /** Persist a lifecycle transition in the task's domain before it is published. */
  record?(task: TaskSnapshot): void;
}

export interface TaskSnapshot {
  id: string;
  owner: string;
  creator?: string;
  name?: string;
  type?: string;
  resourceId?: string;
  metadata?: Readonly<Record<string, unknown>>;
  state: TaskState;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  cancellationRequested: boolean;
  progress?: unknown;
  outputCursor: number;
  result?: unknown;
  error?: string;
}

export interface TaskHandle<T = unknown> {
  readonly id: string;
  readonly signal: AbortSignal;
  readonly result: Promise<T>;
  cancel(reason?: unknown): boolean;
}

export interface TaskContext {
  readonly id: string;
  readonly signal: AbortSignal;
  update(progress: unknown): void;
  write(output: string): void;
  /** Release any acquired slot while waiting, then reacquire before continuing. */
  suspend<T>(wait: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

export interface TaskOutput {
  cursor: number;
  truncated: boolean;
  chunks: { sequence: number; text: string }[];
}

export interface TaskPort {
  start<T>(options: TaskOptions, execute: (context: TaskContext) => Promise<T>): TaskHandle<T>;
  get(id: string): TaskSnapshot | undefined;
  list(owner?: string): TaskSnapshot[];
  cancel(id: string, reason?: unknown): boolean;
  wait(id: string, predicate?: (task: TaskSnapshot) => boolean, signal?: AbortSignal): Promise<TaskSnapshot>;
  subscribe(listener: (task: TaskSnapshot) => void): () => void;
  readOutput(id: string, after?: number): TaskOutput | undefined;
  /** Cancel, drain and forget all tasks belonging to the specified lifetime. */
  removeOwner(owner: string): Promise<void>;
}

export class TaskInterrupted extends Error {
  constructor() {
    super('The service stopped before the task finished');
  }
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessTasks: TaskPort;
  }
}
