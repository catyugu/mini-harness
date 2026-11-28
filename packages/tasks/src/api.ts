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

export interface TaskOptions {
  /** Opaque resource lifetime key. */
  owner: string;
  /** The fiber whose code/resources execute the work, defaulting to the submitting caller. */
  provider?: Context;
  signal?: AbortSignal;
  /** Capacity is held during execution and released at a whole-task wait point. */
  pool?: TaskPool;
  /** Exclusive admission from submission to settlement, including waits. */
  lane?: string;
  /** Observe this execution through settlement, without retaining the observer afterwards. */
  onEvent?(event: TaskEvent): void;
}

export interface TaskSnapshot {
  id: string;
  owner: string;
  lane?: string;
  state: TaskState;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  cancellationRequested: boolean;
  error?: string;
}

export type TaskEvent = {
  type: 'created' | 'transition' | 'cancelling';
  task: TaskSnapshot;
};

export interface TaskHandle<T = unknown> {
  readonly id: string;
  readonly signal: AbortSignal;
  snapshot(): TaskSnapshot;
  readonly result: Promise<T>;
  cancel(reason?: unknown): boolean;
}

export interface TaskContext {
  readonly id: string;
  readonly signal: AbortSignal;
  /** Wait at a whole-task boundary, releasing pool capacity. */
  waitFor(id: string, signal?: AbortSignal): Promise<TaskSnapshot>;
}

export interface TaskPort {
  readonly sealed: boolean;
  active(lane: string): TaskHandle | undefined;
  start<T>(options: TaskOptions, execute: (context: TaskContext) => Promise<T>): TaskHandle<T>;
  get(id: string): TaskSnapshot | undefined;
  /** Tasks remain addressable until execution settles. */
  list(owner?: string): TaskSnapshot[];
  cancel(id: string, reason?: unknown): boolean;
  wait(id: string, signal?: AbortSignal): Promise<TaskSnapshot>;
  subscribe(listener: (event: TaskEvent) => void): () => void;
  /** Exclude new work during removal, cancel and drain their tasks. The domain owns resource existence. */
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
