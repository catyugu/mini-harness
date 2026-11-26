import type { Context } from 'mini-harness/cordis';

export type TaskState = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export const terminal = (state: TaskState) => state !== 'queued' && state !== 'running' && state !== 'waiting';

/** Serializable observation data, not the arbitrary JavaScript value returned by the executor. */
export type TaskData = null | boolean | number | string | TaskData[] | { [key: string]: TaskData };

/** Acquire a caller-defined execution slot. Release is called exactly once per acquisition. */
export type TaskAdmission = (signal: AbortSignal) => Promise<() => void>;

export interface TaskOptions<T = unknown> {
  /** Resource lifetime key, or 'task:' followed by the ID of an active owning task. */
  owner: string;
  creator?: string;
  name?: string;
  type?: string;
  resourceId?: string;
  metadata?: Readonly<Record<string, TaskData>>;
  /** The fiber whose code/resources execute the work, defaulting to the submitting caller. */
  provider?: Context;
  signal?: AbortSignal;
  acquire?: TaskAdmission;
  /** Inline callers can discard runtime history after terminal observation and result delivery. */
  retain?: boolean;
  /** Select a serializable result for subsequent observation. The handle always returns the original value. */
  projectResult?(result: T): TaskData;
  /** Persist a domain lifecycle transition before it is published. */
  record?(task: TaskSnapshot): void;
}

export interface TaskSnapshot {
  id: string;
  owner: string;
  creator?: string;
  name?: string;
  type?: string;
  resourceId?: string;
  metadata?: Readonly<Record<string, TaskData>>;
  state: TaskState;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  cancellationRequested: boolean;
  progress?: TaskData;
  outputCursor: number;
  result?: TaskData;
  error?: string;
  retained: boolean;
}

export type TaskEvent = {
  type: 'created' | 'updated' | 'output' | 'deleted';
  task: TaskSnapshot;
};

export interface TaskHandle<T = unknown> {
  readonly id: string;
  readonly signal: AbortSignal;
  readonly result: Promise<T>;
  cancel(reason?: unknown): boolean;
}

export interface TaskContext {
  readonly id: string;
  readonly signal: AbortSignal;
  update(progress: TaskData): void;
  write(output: string, channel?: string): void;
  /** Overlapping waits share one released slot and resume together after reacquisition, even on wait errors. */
  suspend<T>(wait: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

export interface TaskChunk {
  start: number;
  end: number;
  channel: string;
  text: string;
}

export interface TaskOutput {
  cursor: number;
  truncated: boolean;
  chunks: TaskChunk[];
}

export interface TaskPort {
  start<T>(options: TaskOptions<T>, execute: (context: TaskContext) => Promise<T>): TaskHandle<T>;
  get(id: string): TaskSnapshot | undefined;
  list(owner?: string): TaskSnapshot[];
  cancel(id: string, reason?: unknown): boolean;
  wait(id: string, predicate?: (task: TaskSnapshot) => boolean, signal?: AbortSignal): Promise<TaskSnapshot>;
  subscribe(listener: (event: TaskEvent) => void): () => void;
  readOutput(id: string, after?: number): TaskOutput | undefined;
  /** Permanently close the owner, drain its tasks and delete their history. Idempotent. */
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
