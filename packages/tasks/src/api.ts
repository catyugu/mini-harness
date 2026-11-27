import type { Context } from 'mini-harness/cordis';
import type { TaskPool } from './pool.ts';
export { TaskPool } from './pool.ts';

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

export interface TaskOptions<T = unknown> {
  /** Opaque resource lifetime key. */
  owner: string;
  name?: string;
  type?: string;
  metadata?: Readonly<Record<string, TaskData>>;
  /** The fiber whose code/resources execute the work, defaulting to the submitting caller. */
  provider?: Context;
  signal?: AbortSignal;
  /** Capacity is held during execution and released at a whole-task wait point. */
  pool?: TaskPool;
  /** Exclusive admission from submission to settlement, including waits. */
  lane?: string;
  /** Project the returned value into a serializable observation. */
  project?(value: T): TaskData | undefined;
  /** Synchronously commit a task transition before notifying observers. */
  commit?(record: TaskHistoryRecord): void;
  /** Observe this execution through settlement, without retaining the observer afterwards. */
  onEvent?(event: TaskEvent): void;
}

export interface TaskSnapshot {
  id: string;
  owner: string;
  lane?: string;
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
  write(output: string, channel?: string): void;
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
  readonly sealed: boolean;
  active(lane: string): TaskHandle | undefined;
  start<T>(options: TaskOptions<T>, execute: (context: TaskContext) => Promise<T>): TaskHandle<T>;
  get(id: string): TaskSnapshot | undefined;
  /** Live tasks and bounded recent observations of tasks without a durable commit. */
  list(owner?: string | ReadonlySet<string>): TaskSnapshot[];
  cancel(id: string, reason?: unknown): boolean;
  wait(id: string, signal?: AbortSignal): Promise<TaskSnapshot>;
  subscribe(listener: (event: TaskEvent) => void): () => void;
  readOutput(id: string, after?: number): TaskOutput | undefined;
  /** Exclude new work during removal, drain tasks and discard their recent observations. The domain owns resource existence. */
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
