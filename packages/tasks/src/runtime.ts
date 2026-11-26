import { randomUUID } from 'node:crypto';
import { Service } from 'mini-harness/cordis';
import {
  terminal,
  TaskInterrupted,
  type TaskContext,
  type TaskHandle,
  type TaskOptions,
  type TaskPort,
  type TaskSnapshot,
} from './api.ts';

interface Entry {
  snapshot: TaskSnapshot;
  handle: TaskHandle;
  output: { sequence: number; text: string }[];
  bytes: number;
  finishing: boolean;
}

const outputLimit = 1024 * 1024;
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class TaskRuntime implements TaskPort {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(task: TaskSnapshot) => void>();
  private closing = false;
  private readonly removing = new Set<string>();

  service(): TaskPort {
    const runtime = this;
    return Service.track<TaskPort>({
      start<T>(options: TaskOptions, execute: (context: TaskContext) => Promise<T>) {
        const caller = Service.caller(this);
        const lifetime = caller.fiber.signal;
        const signal = options.signal ? AbortSignal.any([options.signal, lifetime]) : lifetime;
        const handle = runtime.start({ ...options, signal }, execute);
        // Register the outstanding task with the provider fiber, including queued work.
        void caller.fiber.run(() => handle.result).catch(() => {});
        return handle;
      },
      get: runtime.get.bind(runtime),
      list: runtime.list.bind(runtime),
      cancel: runtime.cancel.bind(runtime),
      wait: runtime.wait.bind(runtime),
      subscribe: runtime.subscribe.bind(runtime),
      readOutput: runtime.readOutput.bind(runtime),
      removeOwner: runtime.removeOwner.bind(runtime),
    });
  }

  start<T>(options: TaskOptions, execute: (context: TaskContext) => Promise<T>): TaskHandle<T> {
    if (this.closing) throw new Error('Task runtime is closing');
    const { signal: lifetime, acquire, record, ...metadata } = options;
    if (this.removing.has(options.owner)) throw new Error('Task owner is being removed');
    const parent = this.entries.get(options.owner);
    if (parent && (parent.finishing || terminal(parent.snapshot.state)))
      throw new Error('Task owner has ended');
    const controller = new AbortController();
    const signals = [controller.signal, lifetime, parent?.handle.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    const signal = AbortSignal.any(signals);
    signal.throwIfAborted();
    const snapshot: TaskSnapshot = {
      ...metadata,
      id: randomUUID(),
      state: 'queued',
      createdAt: new Date().toISOString(),
      cancellationRequested: false,
      outputCursor: 0,
    };
    record?.({ ...snapshot });
    let release: (() => void) | undefined;
    const relinquish = () => {
      const held = release;
      release = undefined;
      held?.();
    };
    const update = (patch: Partial<TaskSnapshot>) => {
      if (terminal(snapshot.state)) return;
      Object.assign(snapshot, patch);
      this.publish(snapshot);
    };
    const transition = (patch: Partial<TaskSnapshot>) => {
      record?.({ ...snapshot, ...patch });
      update(patch);
    };
    const enter = async () => {
      signal.throwIfAborted();
      release = await acquire?.(signal);
      signal.throwIfAborted();
      transition({ state: 'running', startedAt: snapshot.startedAt ?? new Date().toISOString() });
    };
    const context: TaskContext = {
      id: snapshot.id,
      signal,
      update: (progress) => update({ progress }),
      write: (text) => {
        if (terminal(snapshot.state) || !text) return;
        const chunk = text.slice(-outputLimit);
        const sequence = ++snapshot.outputCursor;
        entry.output.push({ sequence, text: chunk });
        entry.bytes += chunk.length;
        while (entry.bytes > outputLimit || entry.output.length > 2048)
          entry.bytes -= entry.output.shift()!.text.length;
        this.publish(snapshot);
      },
      suspend: async (wait) => {
        if (snapshot.state !== 'running') throw new Error('Only a running task can suspend');
        signal.throwIfAborted();
        relinquish();
        transition({ state: 'waiting' });
        const result = await wait(signal);
        signal.throwIfAborted();
        transition({ state: 'queued' });
        await enter();
        return result;
      },
    };
    const cancelled = () => update({ cancellationRequested: true });
    const result = Promise.resolve().then(async () => {
      let value: T;
      let failure: { error: unknown } | undefined;
      try {
        await enter();
        value = await execute(context);
      } catch (error) {
        failure = { error };
      }
      entry.finishing = true;
      try {
        relinquish();
      } catch (error) {
        failure ??= { error };
      }
      await this.drainOwned(snapshot.id, signal.aborted ? signal.reason : new Error('Task owner ended'));
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
      try {
        transition(
          failure ? { state, error: describe(reason), finishedAt } : { state, result: value!, finishedAt },
        );
      } catch (error) {
        // A durable projection failure must reject the task, not acknowledge success.
        update({ state: 'failed', error: describe(error), finishedAt });
        throw error;
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
    const entry: Entry = { snapshot, handle, output: [], bytes: 0, finishing: false };
    this.entries.set(handle.id, entry);
    signal.addEventListener('abort', cancelled, { once: true });
    void result.catch(() => {});
    this.publish(snapshot);
    return handle;
  }

  get(id: string) {
    const entry = this.entries.get(id);
    return entry && { ...entry.snapshot };
  }

  list(owner?: string) {
    return [...this.entries.values()]
      .filter(({ snapshot }) => owner === undefined || snapshot.owner === owner)
      .map(({ snapshot }) => ({ ...snapshot }));
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
      const unsubscribe = this.subscribe(check);
      signal?.addEventListener('abort', cancel, { once: true });
      check(current);
    });
  }

  subscribe(listener: (task: TaskSnapshot) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publish(snapshot: TaskSnapshot) {
    for (const listener of [...this.listeners]) {
      try {
        listener({ ...snapshot });
      } catch {
        // Observers cannot interrupt execution or other observers.
      }
    }
  }

  readOutput(id: string, after = 0) {
    const entry = this.entries.get(id);
    if (!entry) return;
    return {
      cursor: entry.snapshot.outputCursor,
      truncated: after < (entry.output[0]?.sequence ?? 1) - 1,
      chunks: entry.output.filter(({ sequence }) => sequence > after).map((chunk) => ({ ...chunk })),
    };
  }

  private owned(owner: string) {
    return [...this.entries.values()].filter(({ snapshot }) => snapshot.owner === owner);
  }

  private async drainOwned(owner: string, reason?: unknown) {
    const active = this.owned(owner).filter(({ snapshot }) => !terminal(snapshot.state));
    for (const { handle } of active) handle.cancel(reason);
    await Promise.allSettled(active.map(({ handle }) => handle.result));
  }

  async removeOwner(owner: string) {
    this.removing.add(owner);
    try {
      await this.drainOwned(owner);
      for (const { handle } of this.owned(owner)) {
        await this.removeOwner(handle.id);
        this.entries.delete(handle.id);
      }
    } finally {
      this.removing.delete(owner);
    }
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
