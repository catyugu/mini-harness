import { randomUUID } from 'node:crypto';
import { Service } from 'mini-harness/cordis';
import {
  terminal,
  TaskInterrupted,
  type TaskContext,
  type TaskEvent,
  type TaskHandle,
  type TaskHistoryRecord,
  type TaskOptions,
  type TaskOutput,
  type TaskPort,
  type TaskSnapshot,
} from './api.ts';
import { TaskOutputRing, readTaskOutput } from './output.ts';

interface Entry {
  snapshot: TaskSnapshot;
  handle: TaskHandle;
  output?: TaskOutputRing;
  finishing: boolean;
  waitingFor?: string;
  onEvent?: (event: TaskEvent) => void;
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
const clone = <T>(value: T): T => structuredClone(value);
// Observation data crosses the JSON persistence boundary, unlike handle results.
const jsonData = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

export class TaskRuntime implements TaskPort {
  private readonly entries = new Map<string, Entry>();
  private readonly recent = new Map<string, TaskHistoryRecord & { bytes: number }>();
  private recentBytes = 0;
  private readonly listeners = new Set<(event: TaskEvent) => void>();
  private readonly removing = new Map<string, Promise<void>>();
  private closing = false;

  get sealed() {
    return this.closing;
  }

  active(lane: string) {
    return [...this.entries.values()].find(
      ({ snapshot }) => snapshot.lane === lane && !terminal(snapshot.state),
    )?.handle;
  }

  service(): TaskPort {
    const runtime = this;
    return Service.track<TaskPort>({
      get sealed() {
        return runtime.sealed;
      },
      active: runtime.active.bind(runtime),
      start<T>(options: TaskOptions<T>, execute: (context: TaskContext) => Promise<T>) {
        return runtime.start({ ...options, provider: options.provider ?? Service.caller(this) }, execute);
      },
      get: runtime.get.bind(runtime),
      list: runtime.list.bind(runtime),
      cancel: runtime.cancel.bind(runtime),
      wait(id, signal) {
        const lifetime = Service.caller(this).fiber.signal;
        return runtime.wait(id, signal ? AbortSignal.any([signal, lifetime]) : lifetime);
      },
      subscribe(listener) {
        const caller = Service.caller(this);
        const signal = caller.fiber.signal;
        return caller.effect(() =>
          runtime.subscribe((event) => {
            if (!signal.aborted) listener(event);
          }),
        );
      },
      readOutput: runtime.readOutput.bind(runtime),
      removeOwner: runtime.removeOwner.bind(runtime),
    });
  }

  start<T>(options: TaskOptions<T>, execute: (context: TaskContext) => Promise<T>): TaskHandle<T> {
    if (this.closing) throw new Error('Task runtime is closing');
    const { signal: lifetime, provider, pool, commit, onEvent, project, ...metadata } = options;
    if (this.removing.has(options.owner)) throw new Error('Task owner has been removed');
    if (options.lane !== undefined && this.active(options.lane))
      throw new Error('Task lane is already occupied');
    const controller = new AbortController();
    const signals = [controller.signal, lifetime, provider?.fiber.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    const signal = AbortSignal.any(signals);
    signal.throwIfAborted();
    const snapshot: TaskSnapshot = {
      ...jsonData(metadata),
      id: randomUUID(),
      state: 'queued',
      createdAt: new Date().toISOString(),
      cancellationRequested: false,
      outputCursor: 0,
    };
    const persist = (task: TaskSnapshot, output?: TaskOutput) => {
      commit?.({ task: clone(task), output });
    };
    let release: (() => void) | undefined;
    const relinquish = () => {
      const held = release;
      release = undefined;
      held?.();
    };
    const update = (patch: Partial<TaskSnapshot>, type: TaskEvent['type'] = 'updated') => {
      if (terminal(snapshot.state)) return;
      Object.assign(snapshot, clone(patch));
      this.notify(type, snapshot);
    };
    const transition = (patch: Partial<TaskSnapshot>) => {
      const next = { ...snapshot, ...patch };
      persist(next, terminal(next.state) ? entry.output?.read() : undefined);
      update(patch, 'transition');
    };
    const enter = async () => {
      signal.throwIfAborted();
      release = await pool?.acquire(signal);
      signal.throwIfAborted();
      transition({ state: 'running', startedAt: snapshot.startedAt ?? new Date().toISOString() });
    };
    let admissionFailure: { error: unknown } | undefined;
    let projected: TaskSnapshot['result'];
    const context: TaskContext = {
      id: snapshot.id,
      owner: snapshot.owner,
      signal,
      update: (progress) => update({ progress: jsonData(progress) }),
      write: (text, channel = 'log') => {
        if (terminal(snapshot.state) || !text) return;
        entry.output ??= new TaskOutputRing();
        entry.output.write(text, channel);
        update({ outputCursor: entry.output.cursor }, 'output');
      },
      waitFor: async (id, cancellation) => {
        const target = this.get(id);
        if (!target) throw new Error('Task not found: ' + id);
        if (terminal(target.state)) return target;
        if (snapshot.state !== 'running' || entry.finishing)
          throw new Error('Wait requires a single whole-task wait point');
        this.assertWait(entry, id);
        entry.waitingFor = id;
        try {
          signal.throwIfAborted();
          transition({ state: 'waiting' });
          relinquish();
          try {
            return await this.wait(id, cancellation ? AbortSignal.any([signal, cancellation]) : signal);
          } finally {
            signal.throwIfAborted();
            try {
              if (entry.finishing) throw new Error('Task ended with an unawaited wait');
              transition({ state: 'queued' });
              await enter();
            } catch (error) {
              relinquish();
              if (signal.aborted && error === signal.reason) throw error;
              admissionFailure = { error };
              controller.abort(error);
              throw error;
            }
          }
        } finally {
          entry.waitingFor = undefined;
        }
      },
    };
    const cancelled = () => update({ cancellationRequested: true });
    const run = async (failure?: { error: unknown }) => {
      let value: T;
      try {
        if (failure) throw failure.error;
        await enter();
        signal.throwIfAborted();
        value = await execute(context);
        signal.throwIfAborted();
        if (project) projected = jsonData(project(value));
      } catch (error) {
        failure = { error };
      }
      entry.finishing = true;
      try {
        relinquish();
      } catch (error) {
        failure ??= { error };
      }
      failure = admissionFailure ?? failure;
      if (!failure && signal.aborted) failure = { error: signal.reason };
      signal.removeEventListener('abort', cancelled);
      const error = failure?.error;
      const aborted =
        !admissionFailure &&
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
      // Keep the bounded output available to readers; release execution resources at settlement.
      let committed = false;
      try {
        transition(
          failure ? { state, error: describe(reason), finishedAt } : { state, result: projected, finishedAt },
        );
        committed = Boolean(commit);
      } catch (error) {
        update({ state: 'failed', error: describe(error), finishedAt }, 'transition');
        throw error;
      } finally {
        this.entries.delete(snapshot.id);
        if (!committed) this.remember({ task: snapshot, output: entry.output?.read() });
      }
      if (failure) throw reason;
      return value!;
    };
    let accepted = false;
    const executeTask = () => {
      if (!accepted) throw new Error('Task submission failed');
      return run();
    };
    const result = (
      provider ? provider.fiber.run(executeTask, signal) : Promise.resolve().then(executeTask)
    ).catch((error) => {
      if (!accepted || entry.finishing) throw error;
      return run({ error });
    });
    const handle: TaskHandle<T> = {
      id: snapshot.id,
      signal,
      get state() {
        return snapshot.state;
      },
      result,
      cancel(reason = new Error('Task cancelled')) {
        if (terminal(snapshot.state) || signal.aborted) return false;
        controller.abort(reason);
        return true;
      },
    };
    const entry: Entry = {
      snapshot,
      handle,
      finishing: false,
      onEvent,
    };
    this.entries.set(handle.id, entry);
    void result.catch(() => {});
    try {
      persist(snapshot);
      accepted = true;
    } catch (error) {
      this.entries.delete(handle.id);
      throw error;
    }
    if (signal.aborted) snapshot.cancellationRequested = true;
    else signal.addEventListener('abort', cancelled, { once: true });
    this.notify('created', snapshot);
    return handle;
  }

  private remember(record: TaskHistoryRecord) {
    const bytes = Buffer.byteLength(JSON.stringify(record));
    this.recent.set(record.task.id, { ...record, bytes });
    this.recentBytes += bytes;
    for (const recent of this.recent.values()) {
      if (this.recent.size <= 256 && this.recentBytes <= 16 * 1024 * 1024) break;
      this.forget(recent);
    }
  }

  private forget({ task, bytes }: TaskHistoryRecord & { bytes: number }) {
    this.recent.delete(task.id);
    this.recentBytes -= bytes;
    this.notify('deleted', task);
  }

  private assertWait(waiter: Entry, target: string) {
    for (let id: string | undefined = target; id; id = this.entries.get(id)?.waitingFor)
      if (id === waiter.snapshot.id) throw new Error('Circular task wait');
  }

  get(id: string) {
    const entry = this.entries.get(id);
    if (entry) return clone(entry.snapshot);
    return clone(this.recent.get(id)?.task);
  }

  list(owner?: string | ReadonlySet<string>) {
    return [
      ...Array.from(this.entries.values(), ({ snapshot }) => snapshot),
      ...Array.from(this.recent.values(), ({ task }) => task),
    ]
      .filter((task) => (typeof owner === 'string' ? task.owner === owner : (owner?.has(task.owner) ?? true)))
      .map(clone);
  }

  cancel(id: string, reason?: unknown) {
    return this.entries.get(id)?.handle.cancel(reason) ?? false;
  }

  wait(id: string, signal?: AbortSignal): Promise<TaskSnapshot> {
    const entry = this.entries.get(id);
    if (!entry || terminal(entry.snapshot.state)) {
      const current = this.get(id);
      return current ? Promise.resolve(current) : Promise.reject(new Error('Task not found: ' + id));
    }
    const { handle, snapshot } = entry;
    return new Promise((resolve, reject) => {
      const finish = () => {
        signal?.removeEventListener('abort', cancel);
        resolve(clone(snapshot));
      };
      const cancel = () => {
        if (terminal(snapshot.state)) return finish();
        signal?.removeEventListener('abort', cancel);
        reject(signal?.reason);
      };
      if (signal?.aborted) return cancel();
      signal?.addEventListener('abort', cancel, { once: true });
      void handle.result.then(finish, finish);
    });
  }

  subscribe(listener: (event: TaskEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(type: TaskEvent['type'], snapshot: TaskSnapshot) {
    const local = this.entries.get(snapshot.id)?.onEvent;
    for (const listener of local ? [local, ...this.listeners] : [...this.listeners]) {
      try {
        listener({ type, task: clone(snapshot) });
      } catch {
        // Observers cannot interrupt execution or other observers.
      }
    }
  }

  readOutput(id: string, after = 0) {
    const entry = this.entries.get(id);
    if (entry) return entry.output?.read(after) ?? { cursor: 0, truncated: false, chunks: [] };
    const recent = this.recent.get(id);
    if (recent) return readTaskOutput(recent.output ?? { cursor: 0, truncated: false, chunks: [] }, after);
  }

  private owned(owner: string) {
    return [...this.entries.values()].filter(({ snapshot }) => snapshot.owner === owner);
  }

  private async drain(entries: Entry[], reason?: unknown) {
    const handles = entries.map(({ handle }) => handle);
    for (const handle of handles) handle.cancel(reason);
    await Promise.allSettled(handles.map(({ result }) => result));
  }

  removeOwner(owner: string): Promise<void> {
    const existing = this.removing.get(owner);
    if (existing) return existing;
    const operation = Promise.resolve()
      .then(async () => {
        await this.drain(this.owned(owner));
        for (const recent of this.recent.values()) if (recent.task.owner === owner) this.forget(recent);
      })
      .finally(() => this.removing.delete(owner));
    this.removing.set(owner, operation);
    return operation;
  }

  seal() {
    this.closing = true;
  }

  async stop() {
    this.seal();
    await this.drain([...this.entries.values()], new TaskInterrupted());
  }
}
