import type { Context } from 'mini-harness/cordis';
import type { TaskPool } from './pool.ts';
import type { TaskJob } from './batch.ts';
export type { TaskJob } from './batch.ts';
export type { TaskPool } from './pool.ts';

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

/** Serializable observation data, not the arbitrary JavaScript value returned by the executor. */
export type TaskData = null | boolean | number | string | TaskData[] | { [key: string]: TaskData };

export interface TaskOptions {
  /** Opaque resource lifetime key. */
  owner: string;
  /** An inline child is drained before its parent settles. */
  parentId?: string;
  name?: string;
  type?: string;
  metadata?: Readonly<Record<string, TaskData>>;
  /** The fiber whose code/resources execute the work, defaulting to the submitting caller. */
  provider?: Context;
  signal?: AbortSignal;
  /** Capacity is held during execution and released at a whole-task wait point. */
  pool?: TaskPool;
  /** Inline callers can discard runtime history after terminal observation and result delivery. */
  retain?: boolean;
}

export interface TaskSnapshot {
  id: string;
  owner: string;
  parentId?: string;
  name?: string;
  type?: string;
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
  type: 'created' | 'transition' | 'updated' | 'output' | 'deleted';
  task: TaskSnapshot;
};

export interface TaskHandle<T = unknown> {
  readonly id: string;
  readonly signal: AbortSignal;
  readonly state: TaskState;
  readonly result: Promise<T>;
  cancel(reason?: unknown): boolean;
}

export interface TaskContext {
  readonly id: string;
  readonly owner: string;
  readonly signal: AbortSignal;
  update(progress: TaskData): void;
  /** Set a serializable observation result independently of the executor's return value. */
  setResult(result: TaskData): void;
  write(output: string, channel?: string): void;
  /** Call only at a whole-task wait point; reacquires admission before returning or throwing. */
  suspend<T>(wait: (signal: AbortSignal) => Promise<T>): Promise<T>;
  /** Wait at a whole-task boundary, releasing pool capacity. */
  waitFor(id: string, signal?: AbortSignal): Promise<TaskSnapshot>;
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

/** Durable facts supplied by a domain, never reconstructed live execution handles. */
export interface TaskHistoryRecord {
  task: TaskSnapshot;
  output?: TaskOutput;
}

export interface TaskPort {
  pool(limit: number): TaskPool;
  batch(jobs: Iterable<TaskJob>, options: { signal: AbortSignal; limit: number }): Promise<void>;
  start<T>(options: TaskOptions, execute: (context: TaskContext) => Promise<T>): TaskHandle<T>;
  get(id: string): TaskSnapshot | undefined;
  /** Active tasks and bounded recent history; older durable records remain queryable by ID. */
  list(owner?: string): TaskSnapshot[];
  cancel(id: string, reason?: unknown): boolean;
  wait(id: string, signal?: AbortSignal): Promise<TaskSnapshot>;
  subscribe(listener: (event: TaskEvent) => void): () => void;
  readOutput(id: string, after?: number): TaskOutput | undefined;
  /** Exclude new work during removal, drain tasks and delete their history. The domain owns resource existence. */
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
  interface Events {
    'tasks/admit'(owner: string): void;
    'tasks/record'(record: TaskHistoryRecord): void;
    'tasks/history'(id: string): TaskHistoryRecord | undefined;
  }
}
