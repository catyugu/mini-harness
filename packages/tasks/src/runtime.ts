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
}

const outputLimit = 1024 * 1024;
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class TaskRuntime implements TaskPort {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(task: TaskSnapshot) => void>();
  private closing = false;

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
    const { signal: lifetime, acquire, ...metadata } = options;
    lifetime?.throwIfAborted();
    const controller = new AbortController();
    const signal = lifetime ? AbortSignal.any([lifetime, controller.signal]) : controller.signal;
    const snapshot: TaskSnapshot = {
      ...metadata,
      id: randomUUID(),
      state: 'queued',
      createdAt: new Date().toISOString(),
      cancellationRequested: false,
      outputCursor: 0,
    };
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
    const enter = async () => {
      signal.throwIfAborted();
      release = await acquire?.(signal);
      signal.throwIfAborted();
      update({ state: 'running', startedAt: snapshot.startedAt ?? new Date().toISOString() });
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
        update({ state: 'waiting' });
        const result = await wait(signal);
        signal.throwIfAborted();
        update({ state: 'queued' });
        await enter();
        return result;
      },
    };
    const cancelled = () => update({ cancellationRequested: true });
    const settle = (state: TaskSnapshot['state'], patch: Partial<TaskSnapshot>) => {
      signal.removeEventListener('abort', cancelled);
      update({ ...patch, state, finishedAt: new Date().toISOString() });
    };
    const result = Promise.resolve().then(async () => {
      try {
        let value: T;
        try {
          await enter();
          value = await execute(context);
        } finally {
          relinquish();
        }
        signal.throwIfAborted();
        settle('completed', { result: value });
        return value;
      } catch (error) {
        const reason = signal.aborted ? signal.reason : error;
        settle(signal.aborted ? (reason instanceof TaskInterrupted ? 'interrupted' : 'cancelled') : 'failed', {
          error: describe(reason),
        });
        throw reason;
      }
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
    const entry: Entry = { snapshot, handle, output: [], bytes: 0 };
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

  async removeOwner(owner: string) {
    const entries = [...this.entries.values()].filter(({ snapshot }) => snapshot.owner === owner);
    for (const { handle } of entries) handle.cancel();
    await Promise.allSettled(entries.map(({ handle }) => handle.result));
    for (const { handle } of entries) this.entries.delete(handle.id);
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
