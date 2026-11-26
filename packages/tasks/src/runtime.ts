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
  handle?: TaskHandle;
  output: TaskOutputRing;
  finishing: boolean;
  retainedBytes?: number;
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
const clone = <T>(value: T): T => structuredClone(value);
// Observation data crosses the JSON persistence boundary, unlike handle results.
const jsonData = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

export class TaskRuntime implements TaskPort {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(event: TaskEvent) => void>();
  private readonly removing = new Map<string, Promise<void>>();
  private closing = false;

  constructor(
    private readonly domain: {
      admit?(owner: string): void;
      record?(record: TaskHistoryRecord): void;
      history?(id: string): TaskHistoryRecord | undefined;
    } = {},
  ) {}

  service(): TaskPort {
    const runtime = this;
    return Service.track<TaskPort>({
      start<T>(options: TaskOptions, execute: (context: TaskContext) => Promise<T>) {
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

  start<T>(options: TaskOptions, execute: (context: TaskContext) => Promise<T>): TaskHandle<T> {
    if (this.closing) throw new Error('Task runtime is closing');
    const { signal: lifetime, provider, acquire, retain = true, ...metadata } = options;
    if (this.removing.has(options.owner)) throw new Error('Task owner has been removed');
    this.domain.admit?.(options.owner);
    const parent = options.parentId ? this.entries.get(options.parentId) : undefined;
    if (options.parentId && (!parent || parent.finishing || terminal(parent.snapshot.state)))
      throw new Error('Task owner has ended');
    const controller = new AbortController();
    const signals = [controller.signal, lifetime, provider?.fiber.signal, parent?.handle?.signal].filter(
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
      retained: retain,
    };
    const persist = (task: TaskSnapshot, output?: TaskOutput) => {
      if (retain) this.domain.record?.({ task: clone(task), output });
    };
    persist(snapshot);
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
      persist(next, terminal(next.state) && next.outputCursor ? entry.output.read() : undefined);
      update(patch, 'transition');
    };
    const enter = async () => {
      signal.throwIfAborted();
      release = await acquire?.(signal);
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
      setResult: (result) => {
        projected = jsonData(result);
      },
      write: (text, channel = 'log') => {
        if (terminal(snapshot.state) || !text) return;
        entry.output.write(text, channel);
        update({ outputCursor: entry.output.cursor }, 'output');
      },
      suspend: async (wait) => {
        signal.throwIfAborted();
        if (entry.finishing || snapshot.state !== 'running')
          throw new Error('Suspend requires a single whole-task wait point');
        // Commit waiting before relinquishing the slot, so a record fault cannot leave
        // an executor running without admission.
        transition({ state: 'waiting' });
        relinquish();
        try {
          return await wait(signal);
        } finally {
          signal.throwIfAborted();
          try {
            if (entry.finishing) throw new Error('Task ended with an unawaited suspension');
            transition({ state: 'queued' });
            await enter();
            signal.throwIfAborted();
          } catch (error) {
            relinquish();
            if (signal.aborted && error === signal.reason) throw error;
            admissionFailure = { error };
            controller.abort(error);
            throw error;
          }
        }
      },
    };
    const cancelled = () => update({ cancellationRequested: true });
    const run = async () => {
      let value: T;
      let failure: { error: unknown } | undefined;
      try {
        await enter();
        signal.throwIfAborted();
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
      await this.drain(
        this.children(snapshot.id),
        signal.aborted ? signal.reason : new Error('Task owner ended'),
      );
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
      try {
        transition(
          failure ? { state, error: describe(reason), finishedAt } : { state, result: projected, finishedAt },
        );
      } catch (error) {
        update({ state: 'failed', error: describe(error), finishedAt }, 'transition');
        throw error;
      } finally {
        entry.handle = undefined;
        if (!retain) this.forgetTree(entry);
        else {
          entry.retainedBytes =
            Buffer.byteLength(JSON.stringify(snapshot)) + Math.min(snapshot.outputCursor, 1024 * 1024);
          this.prune();
        }
      }
      if (failure) throw reason;
      return value!;
    };
    // Fiber.run owns execution, including cleanup. If activation ends before
    // its callback starts, settle using the already-aborted task signal.
    let executing: Promise<T> | undefined;
    const result = provider
      ? provider.fiber.run(() => (executing = run())).catch(() => executing ?? run())
      : Promise.resolve().then(run);
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
    const entry: Entry = { snapshot, handle, output: new TaskOutputRing(), finishing: false };
    this.entries.set(handle.id, entry);
    signal.addEventListener('abort', cancelled, { once: true });
    void result.catch(() => {});
    this.notify('created', snapshot);
    return handle;
  }

  get(id: string) {
    const entry = this.entries.get(id);
    if (entry) return clone(entry.snapshot);
    const historical = this.domain.history?.(id)?.task;
    if (!historical) return;
    // A durable record without an executor cannot represent live work.
    return terminal(historical.state)
      ? clone(historical)
      : {
          ...clone(historical),
          state: 'interrupted' as const,
          error: 'No live executor remains for this task',
        };
  }

  list(owner?: string) {
    return [...this.entries.values()]
      .filter(({ snapshot }) => owner === undefined || snapshot.owner === owner)
      .map(({ snapshot }) => clone(snapshot));
  }

  cancel(id: string, reason?: unknown) {
    return this.entries.get(id)?.handle?.cancel(reason) ?? false;
  }

  wait(id: string, signal?: AbortSignal): Promise<TaskSnapshot> {
    const entry = this.entries.get(id);
    if (!entry?.handle || terminal(entry.snapshot.state)) {
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
    for (const listener of [...this.listeners]) {
      try {
        listener({ type, task: clone(snapshot) });
      } catch {
        // Observers cannot interrupt execution or other observers.
      }
    }
  }

  readOutput(id: string, after = 0) {
    const entry = this.entries.get(id);
    if (entry) return entry.output.read(after);
    const history = this.domain.history?.(id);
    if (!history) return;
    return readTaskOutput(
      history.output ?? {
        cursor: history.task.outputCursor,
        truncated: history.task.outputCursor > 0,
        chunks: [],
      },
      after,
    );
  }

  private owned(owner: string) {
    return [...this.entries.values()].filter(({ snapshot }) => snapshot.owner === owner);
  }

  private children(id: string) {
    return [...this.entries.values()].filter(({ snapshot }) => snapshot.parentId === id);
  }

  private async drain(entries: Entry[], reason?: unknown) {
    const handles = entries.flatMap(({ handle }) => (handle ? [handle] : []));
    for (const handle of handles) handle.cancel(reason);
    await Promise.allSettled(handles.map(({ result }) => result));
  }

  private forgetTree(entry: Entry) {
    // All descendants have settled before an owning task can reach terminal state.
    for (const child of this.children(entry.snapshot.id)) this.forgetTree(child);
    this.forget(entry);
  }

  private forget(entry: Entry) {
    if (this.entries.delete(entry.snapshot.id)) this.notify('deleted', entry.snapshot);
  }

  private prune() {
    const history = [...this.entries.values()].filter(({ snapshot }) => terminal(snapshot.state));
    // Only retained snapshots/output remain here, not execution promises. Long-term history is domain-owned.
    let bytes = history.reduce((sum, entry) => sum + (entry.retainedBytes ?? 0), 0);
    let remaining = history.length;
    for (const entry of history) {
      if (remaining <= 256 && bytes <= 16 * 1024 * 1024) break;
      this.forget(entry);
      remaining--;
      bytes -= entry.retainedBytes ?? 0;
    }
  }

  removeOwner(owner: string): Promise<void> {
    const existing = this.removing.get(owner);
    if (existing) return existing;
    const operation = Promise.resolve()
      .then(async () => {
        await this.drain(this.owned(owner));
        for (const entry of this.owned(owner)) this.forgetTree(entry);
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
