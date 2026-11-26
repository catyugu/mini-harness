import { randomUUID } from 'node:crypto';
import { Service } from 'mini-harness/cordis';
import {
  terminal,
  TaskInterrupted,
  type TaskContext,
  type TaskEvent,
  type TaskHandle,
  type TaskOptions,
  type TaskPort,
  type TaskSnapshot,
} from './api.ts';
import { TaskOutputRing } from './output.ts';

interface Entry {
  snapshot: TaskSnapshot;
  handle: TaskHandle;
  output: TaskOutputRing;
  finishing: boolean;
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
const clone = <T>(value: T): T => structuredClone(value);
const taskOwner = (id: string) => 'task:' + id;

export class TaskRuntime implements TaskPort {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(event: TaskEvent) => void>();
  private readonly closedOwners = new Map<string, Promise<void>>();
  private closing = false;

  service(): TaskPort {
    const runtime = this;
    return Service.track<TaskPort>({
      start<T>(options: TaskOptions<T>, execute: (context: TaskContext) => Promise<T>) {
        return runtime.start({ ...options, provider: options.provider ?? Service.caller(this) }, execute);
      },
      get: runtime.get.bind(runtime),
      list: runtime.list.bind(runtime),
      cancel: runtime.cancel.bind(runtime),
      wait(id, predicate, signal) {
        const lifetime = Service.caller(this).fiber.signal;
        return runtime.wait(id, predicate, signal ? AbortSignal.any([signal, lifetime]) : lifetime);
      },
      subscribe(listener) {
        const caller = Service.caller(this);
        const signal = caller.fiber.signal;
        signal.throwIfAborted();
        const dispose = runtime.subscribe(listener);
        const unsubscribe = () => {
          signal.removeEventListener('abort', unsubscribe);
          dispose();
        };
        signal.addEventListener('abort', unsubscribe, { once: true });
        return unsubscribe;
      },
      readOutput: runtime.readOutput.bind(runtime),
      removeOwner: runtime.removeOwner.bind(runtime),
    });
  }

  start<T>(options: TaskOptions<T>, execute: (context: TaskContext) => Promise<T>): TaskHandle<T> {
    if (this.closing) throw new Error('Task runtime is closing');
    const {
      signal: lifetime,
      provider,
      acquire,
      record,
      retain = true,
      projectResult,
      ...metadata
    } = options;
    if (this.closedOwners.has(options.owner)) throw new Error('Task owner has been removed');
    const parent = options.owner.startsWith('task:') ? this.entries.get(options.owner.slice(5)) : undefined;
    if (options.owner.startsWith('task:') && (!parent || parent.finishing || terminal(parent.snapshot.state)))
      throw new Error('Task owner has ended');
    const controller = new AbortController();
    const signals = [controller.signal, lifetime, provider?.fiber.signal, parent?.handle.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    const signal = AbortSignal.any(signals);
    signal.throwIfAborted();
    const snapshot: TaskSnapshot = {
      ...clone(metadata),
      id: randomUUID(),
      state: 'queued',
      createdAt: new Date().toISOString(),
      cancellationRequested: false,
      outputCursor: 0,
      retained: retain,
    };
    record?.(clone(snapshot));
    let release: (() => void) | undefined;
    const relinquish = () => {
      const held = release;
      release = undefined;
      held?.();
    };
    const update = (patch: Partial<TaskSnapshot>, type: TaskEvent['type'] = 'updated') => {
      if (terminal(snapshot.state)) return;
      Object.assign(snapshot, clone(patch));
      this.publish(type, snapshot);
    };
    const transition = (patch: Partial<TaskSnapshot>) => {
      record?.(clone({ ...snapshot, ...patch }));
      update(patch);
    };
    const enter = async () => {
      signal.throwIfAborted();
      release = await acquire?.(signal);
      signal.throwIfAborted();
      transition({ state: 'running', startedAt: snapshot.startedAt ?? new Date().toISOString() });
    };
    let suspension:
      | {
          pending: number;
          ready: Promise<void>;
          resolve: () => void;
          reject: (error: unknown) => void;
        }
      | undefined;
    const context: TaskContext = {
      id: snapshot.id,
      signal,
      update: (progress) => update({ progress }),
      write: (text, channel = 'log') => {
        if (terminal(snapshot.state) || !text) return;
        entry.output.write(text, channel);
        update({ outputCursor: entry.output.cursor }, 'output');
      },
      suspend: async (wait) => {
        signal.throwIfAborted();
        if (entry.finishing || (snapshot.state !== 'running' && snapshot.state !== 'waiting'))
          throw new Error('Only an executing task can suspend');
        if (!suspension) {
          let resolve!: () => void;
          let reject!: (error: unknown) => void;
          const ready = new Promise<void>((ok, fail) => {
            resolve = ok;
            reject = fail;
          });
          void ready.catch(() => {});
          suspension = { pending: 0, ready, resolve, reject };
          relinquish();
          transition({ state: 'waiting' });
        }
        const round = suspension;
        round.pending++;
        let result: Awaited<ReturnType<typeof wait>>;
        let failure: { error: unknown } | undefined;
        try {
          result = await wait(signal);
        } catch (error) {
          failure = { error };
        } finally {
          if (--round.pending === 0) {
            try {
              signal.throwIfAborted();
              if (entry.finishing) throw new Error('Task ended with an unawaited suspension');
              transition({ state: 'queued' });
              await enter();
              round.resolve();
            } catch (error) {
              relinquish();
              controller.abort(error);
              round.reject(error);
            } finally {
              suspension = undefined;
            }
          }
          await round.ready;
        }
        if (failure) throw failure.error;
        return result!;
      },
    };
    const cancelled = () => update({ cancellationRequested: true });
    const result = Promise.resolve().then(async () => {
      let value: T;
      let failure: { error: unknown } | undefined;
      let projected: TaskSnapshot['result'];
      try {
        await enter();
        value = await execute(context);
        if (!signal.aborted && projectResult) projected = clone(projectResult(value));
      } catch (error) {
        failure = { error };
      }
      entry.finishing = true;
      try {
        relinquish();
      } catch (error) {
        failure ??= { error };
      }
      await this.drainOwned(
        taskOwner(snapshot.id),
        signal.aborted ? signal.reason : new Error('Task owner ended'),
      );
      if (!failure && signal.aborted) failure = { error: signal.reason };
      signal.removeEventListener('abort', cancelled);
      const error = failure?.error;
      const aborted =
        signal.aborted &&
        (error === signal.reason ||
          (error instanceof Error && (error.name === 'AbortError' || error.cause === signal.reason)));
      const reason = aborted ? signal.reason : error;
      const state = failure
        ? aborted
          ? reason instanceof TaskInterrupted
            ? 'interrupted'
            : 'cancelled'
          : 'failed'
        : 'completed';
      const finishedAt = new Date().toISOString();
      entry.output.shrink(128 * 1024);
      try {
        transition(
          failure ? { state, error: describe(reason), finishedAt } : { state, result: projected, finishedAt },
        );
      } catch (error) {
        update({ state: 'failed', error: describe(error), finishedAt });
        throw error;
      } finally {
        if (!retain) this.forget(entry);
      }
      if (failure) throw reason;
      return value!;
    });
    const handle: TaskHandle<T> = {
      id: snapshot.id,
      signal,
      result,
      cancel(reason = new Error('Task cancelled')) {
        if (terminal(snapshot.state) || signal.aborted) return false;
        controller.abort(reason);
        return true;
      },
    };
    const entry: Entry = { snapshot, handle, output: new TaskOutputRing(), finishing: false };
    this.entries.set(handle.id, entry);
    signal.addEventListener('abort', cancelled, { once: true });
    void result.catch(() => {});
    if (provider) void provider.fiber.run(() => result).catch(() => {});
    this.publish('created', snapshot);
    return handle;
  }

  get(id: string) {
    const entry = this.entries.get(id);
    return entry && clone(entry.snapshot);
  }

  list(owner?: string) {
    return [...this.entries.values()]
      .filter(({ snapshot }) => owner === undefined || snapshot.owner === owner)
      .map(({ snapshot }) => clone(snapshot));
  }

  cancel(id: string, reason?: unknown) {
    return this.entries.get(id)?.handle.cancel(reason) ?? false;
  }

  wait(id: string, predicate = (task: TaskSnapshot) => terminal(task.state), signal?: AbortSignal) {
    return new Promise<TaskSnapshot>((resolve, reject) => {
      const current = this.get(id);
      if (!current) return reject(new Error('Task not found: ' + id));
      if (signal?.aborted) return reject(signal.reason);
      const cleanup = () => {
        unsubscribe();
        signal?.removeEventListener('abort', cancel);
      };
      const cancel = () => {
        cleanup();
        reject(signal?.reason);
      };
      const check = (task: TaskSnapshot) => {
        if (task.id !== id) return;
        try {
          if (!predicate(task) && !terminal(task.state)) return;
          cleanup();
          resolve(task);
        } catch (error) {
          cleanup();
          reject(error);
        }
      };
      const unsubscribe = this.subscribe(({ task }) => check(task));
      signal?.addEventListener('abort', cancel, { once: true });
      check(current);
    });
  }

  subscribe(listener: (event: TaskEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publish(type: TaskEvent['type'], snapshot: TaskSnapshot) {
    for (const listener of [...this.listeners]) {
      try {
        listener({ type, task: clone(snapshot) });
      } catch {
        // Observers cannot interrupt execution or other observers.
      }
    }
  }

  readOutput(id: string, after = 0) {
    return this.entries.get(id)?.output.read(after);
  }

  private owned(owner: string) {
    return [...this.entries.values()].filter(({ snapshot }) => snapshot.owner === owner);
  }

  private async drainOwned(owner: string, reason?: unknown) {
    const active = this.owned(owner).filter(({ snapshot }) => !terminal(snapshot.state));
    for (const { handle } of active) handle.cancel(reason);
    await Promise.allSettled(active.map(({ handle }) => handle.result));
  }

  private forget(entry: Entry) {
    if (this.entries.delete(entry.snapshot.id)) this.publish('deleted', entry.snapshot);
  }

  removeOwner(owner: string): Promise<void> {
    const existing = this.closedOwners.get(owner);
    if (existing) return existing;
    const operation = Promise.resolve().then(async () => {
      await this.drainOwned(owner);
      for (const entry of this.owned(owner)) {
        await this.removeOwner(taskOwner(entry.snapshot.id));
        this.forget(entry);
      }
    });
    this.closedOwners.set(owner, operation);
    return operation;
  }

  seal() {
    this.closing = true;
  }

  async stop() {
    this.seal();
    const entries = [...this.entries.values()];
    for (const { handle } of entries) handle.cancel(new TaskInterrupted());
    await Promise.allSettled(entries.map(({ handle }) => handle.result));
  }
}
