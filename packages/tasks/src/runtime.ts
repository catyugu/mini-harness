import { randomUUID } from 'node:crypto';
import { Service, type Context } from 'mini-harness/cordis';
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

interface Entry {
  snapshot: TaskSnapshot;
  handle: TaskHandle;
  waitingFor?: string;
  onEvent?: (event: TaskEvent) => void;
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class TaskRuntime implements TaskPort {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(event: TaskEvent) => void>();
  private readonly removing = new Map<string, Promise<void>>();
  private closing = false;

  constructor(private readonly context: Context) {}

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
        return caller.effect(() =>
          runtime.subscribe((event) => {
            if (!signal.aborted) listener(event);
          }),
        );
      },
      removeOwner: runtime.removeOwner.bind(runtime),
    });
  }

  start<T>(options: TaskOptions, execute: (context: TaskContext) => Promise<T>): TaskHandle<T> {
    if (this.closing) throw new Error('Task runtime is closing');
    const { signal: lifetime, provider = this.context, pool, onEvent, owner, lane } = options;
    if (this.removing.has(owner)) throw new Error('Task owner has been removed');
    if (lane !== undefined && this.active(lane)) throw new Error('Task lane is already occupied');
    const controller = new AbortController();
    const signals = [controller.signal, provider.fiber.signal];
    if (lifetime) signals.push(lifetime);
    const signal = AbortSignal.any(signals);
    signal.throwIfAborted();
    const snapshot: TaskSnapshot = {
      owner,
      lane,
      id: randomUUID(),
      state: 'queued',
      createdAt: new Date().toISOString(),
      cancellationRequested: false,
    };
    let release: (() => void) | undefined;
    const relinquish = () => {
      const held = release;
      release = undefined;
      held?.();
    };
    const transition = (patch: Partial<TaskSnapshot>) => {
      Object.assign(snapshot, patch);
      this.notify('transition', snapshot);
    };
    const enter = async () => {
      signal.throwIfAborted();
      release = await pool?.acquire(signal);
      signal.throwIfAborted();
      transition({ state: 'running', startedAt: snapshot.startedAt ?? new Date().toISOString() });
    };
    const context: TaskContext = {
      id: snapshot.id,
      signal,
      waitFor: async (id, cancellation) => {
        const target = this.get(id);
        if (!target) throw new Error('Task not found: ' + id);
        if (terminal(target.state)) return target;
        if (snapshot.state !== 'running') throw new Error('Wait requires a single whole-task wait point');
        this.assertWait(entry, id);
        signal.throwIfAborted();
        entry.waitingFor = id;
        transition({ state: 'waiting' });
        relinquish();
        try {
          return await this.wait(id, cancellation ? AbortSignal.any([signal, cancellation]) : signal);
        } finally {
          entry.waitingFor = undefined;
          signal.throwIfAborted();
          if (terminal(snapshot.state)) throw new Error('Task ended with an unawaited wait');
          transition({ state: 'queued' });
          await enter();
        }
      },
    };
    const cancelled = () => {
      snapshot.cancellationRequested = true;
      this.notify('cancelling', snapshot);
    };
    type Outcome = { value: T } | { error: unknown };
    const settle = (outcome: Outcome): T => {
      relinquish();
      if ('value' in outcome && signal.aborted) outcome = { error: signal.reason };
      signal.removeEventListener('abort', cancelled);
      const finishedAt = new Date().toISOString();
      const error = 'error' in outcome ? outcome.error : undefined;
      const aborted =
        signal.aborted &&
        (error === signal.reason ||
          (error instanceof Error && (error.name === 'AbortError' || error.cause === signal.reason)));
      const reason = aborted ? signal.reason : error;
      const failureState = aborted
        ? reason instanceof TaskInterrupted
          ? 'interrupted'
          : 'cancelled'
        : 'failed';
      transition(
        'error' in outcome
          ? { state: failureState, error: describe(reason), finishedAt }
          : {
              state: 'completed',
              finishedAt,
            },
      );
      this.entries.delete(snapshot.id);
      if ('error' in outcome) throw reason;
      return outcome.value;
    };
    const run = async () => {
      let outcome: Outcome;
      try {
        await enter();
        signal.throwIfAborted();
        const value = await execute(context);
        signal.throwIfAborted();
        outcome = { value };
      } catch (error) {
        outcome = { error };
      }
      return settle(outcome);
    };
    const result = Promise.resolve().then(() =>
      provider.fiber.run(run, signal).catch((error) => {
        if (terminal(snapshot.state)) throw error;
        return settle({ error });
      }),
    );
    const handle: TaskHandle<T> = {
      id: snapshot.id,
      signal,
      result,
      snapshot: () => ({ ...snapshot }),
      cancel(reason = new Error('Task cancelled')) {
        if (terminal(snapshot.state) || signal.aborted) return false;
        controller.abort(reason);
        return true;
      },
    };
    const entry: Entry = {
      snapshot,
      handle,
      onEvent,
    };
    this.entries.set(handle.id, entry);
    void result.catch(() => {});
    signal.addEventListener('abort', cancelled, { once: true });
    this.notify('created', snapshot);
    return handle;
  }

  private assertWait(waiter: Entry, target: string) {
    for (let id: string | undefined = target; id; id = this.entries.get(id)?.waitingFor)
      if (id === waiter.snapshot.id) throw new Error('Circular task wait');
  }

  get(id: string) {
    return this.entries.get(id)?.handle.snapshot();
  }

  list(owner?: string) {
    return [...this.entries.values()]
      .filter(({ snapshot }) => owner === undefined || snapshot.owner === owner)
      .map(({ handle }) => handle.snapshot());
  }

  cancel(id: string, reason?: unknown) {
    return this.entries.get(id)?.handle.cancel(reason) ?? false;
  }

  wait(id: string, signal?: AbortSignal): Promise<TaskSnapshot> {
    const entry = this.entries.get(id);
    if (!entry) return Promise.reject(new Error('Task not found: ' + id));
    const { handle, snapshot } = entry;
    return new Promise((resolve, reject) => {
      const finish = () => {
        signal?.removeEventListener('abort', cancel);
        resolve(handle.snapshot());
      };
      const cancel = () => (terminal(snapshot.state) ? finish() : reject(signal?.reason));
      if (terminal(snapshot.state)) return finish();
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
        listener({ type, task: { ...snapshot } });
      } catch {
        // Observers cannot interrupt execution or other observers.
      }
    }
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
      .then(() => this.drain([...this.entries.values()].filter(({ snapshot }) => snapshot.owner === owner)))
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
