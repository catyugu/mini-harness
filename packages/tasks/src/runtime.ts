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
const taskOwner = (id: string) => 'task:' + id;

export class TaskRuntime implements TaskPort {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(event: TaskEvent) => void>();
  private readonly removing = new Map<string, Promise<void>>();
  private readonly waiters = new Map<string, Set<(task: TaskSnapshot) => void>>();
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
    if (this.removing.has(options.owner)) throw new Error('Task owner has been removed');
    this.domain.admit?.(options.owner);
    const parent = options.owner.startsWith('task:') ? this.entries.get(options.owner.slice(5)) : undefined;
    if (options.owner.startsWith('task:') && (!parent || parent.finishing || terminal(parent.snapshot.state)))
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
    const persist = (next: TaskSnapshot, output?: TaskOutput) => {
      if (record) return record(clone(next));
      else if (retain) this.domain.record?.({ task: clone(next), output });
    };
    const accepted = persist(snapshot);
    let release: (() => void) | undefined;
    const relinquish = () => {
      const held = release;
      release = undefined;
      held?.();
    };
    const update = (
      patch: Partial<TaskSnapshot>,
      type: TaskEvent['type'] = 'updated',
      committed?: void | (() => void),
    ) => {
      if (terminal(snapshot.state)) return;
      Object.assign(snapshot, clone(patch));
      this.notify(type, snapshot, committed);
    };
    const transition = (patch: Partial<TaskSnapshot>) => {
      const next = { ...snapshot, ...patch };
      const committed = persist(
        next,
        terminal(next.state) && next.outputCursor ? entry.output.read() : undefined,
      );
      update(patch, 'updated', committed);
    };
    const enter = async () => {
      signal.throwIfAborted();
      release = await acquire?.(signal);
      signal.throwIfAborted();
      transition({ state: 'running', startedAt: snapshot.startedAt ?? new Date().toISOString() });
    };
    let admissionFailure: { error: unknown } | undefined;
    const context: TaskContext = {
      id: snapshot.id,
      signal,
      update: (progress) => update({ progress: jsonData(progress) }),
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
    const result = Promise.resolve().then(async () => {
      let value: T;
      let failure: { error: unknown } | undefined;
      let projected: TaskSnapshot['result'];
      try {
        await enter();
        signal.throwIfAborted();
        value = await execute(context);
        if (!signal.aborted && projectResult) projected = jsonData(projectResult(value));
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
      entry.handle = undefined;
      try {
        transition(
          failure ? { state, error: describe(reason), finishedAt } : { state, result: projected, finishedAt },
        );
      } catch (error) {
        update({ state: 'failed', error: describe(error), finishedAt });
        throw error;
      } finally {
        if (!retain) this.forgetTree(entry);
        else {
          entry.retainedBytes =
            Buffer.byteLength(JSON.stringify(snapshot)) + Math.min(snapshot.outputCursor, 1024 * 1024);
          this.prune();
        }
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
    this.notify('created', snapshot, accepted);
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

  wait(id: string, predicate = (task: TaskSnapshot) => terminal(task.state), signal?: AbortSignal) {
    return new Promise<TaskSnapshot>((resolve, reject) => {
      const current = this.get(id);
      if (!current) return reject(new Error('Task not found: ' + id));
      if (signal?.aborted && !terminal(current.state)) return reject(signal.reason);
      const group = this.waiters.get(id) ?? new Set<(task: TaskSnapshot) => void>();
      this.waiters.set(id, group);
      const cleanup = () => {
        group.delete(check);
        if (!group.size && this.waiters.get(id) === group) this.waiters.delete(id);
        signal?.removeEventListener('abort', cancel);
      };
      const cancel = () => {
        cleanup();
        reject(signal?.reason);
      };
      const check = (task: TaskSnapshot) => {
        try {
          const view = clone(task);
          if (!terminal(view.state) && !predicate(view)) return;
          cleanup();
          resolve(view);
        } catch (error) {
          cleanup();
          reject(error);
        }
      };
      group.add(check);
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

  private notify(type: TaskEvent['type'], snapshot: TaskSnapshot, committed?: void | (() => void)) {
    if (type !== 'deleted') {
      for (const waiter of [...(this.waiters.get(snapshot.id) ?? [])]) waiter(snapshot);
    }
    try {
      committed?.();
    } catch {
      /* The transition is already committed. */
    }
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

  private async drainOwned(owner: string, reason?: unknown) {
    const handles = this.owned(owner).flatMap(({ handle }) => (handle ? [handle] : []));
    for (const handle of handles) handle.cancel(reason);
    await Promise.allSettled(handles.map(({ result }) => result));
  }

  private forgetTree(entry: Entry) {
    // All descendants have settled before an owning task can reach terminal state.
    for (const child of this.owned(taskOwner(entry.snapshot.id))) this.forgetTree(child);
    if (this.entries.delete(entry.snapshot.id)) this.notify('deleted', entry.snapshot);
  }

  private prune() {
    const history = [...this.entries.values()].filter(({ snapshot }) => terminal(snapshot.state));
    // Only retained snapshots/output remain here, not execution promises. Long-term history is domain-owned.
    let bytes = history.reduce((sum, entry) => sum + (entry.retainedBytes ?? 0), 0);
    let remaining = history.length;
    for (const entry of history) {
      if (remaining <= 256 && bytes <= 16 * 1024 * 1024) break;
      this.forgetTree(entry);
      remaining--;
      bytes -= entry.retainedBytes ?? 0;
    }
  }

  removeOwner(owner: string): Promise<void> {
    const existing = this.removing.get(owner);
    if (existing) return existing;
    const operation = Promise.resolve()
      .then(async () => {
        await this.drainOwned(owner);
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
    const handles = [...this.entries.values()].flatMap(({ handle }) => (handle ? [handle] : []));
    for (const handle of handles) handle.cancel(new TaskInterrupted());
    await Promise.allSettled(handles.map(({ result }) => result));
  }
}
