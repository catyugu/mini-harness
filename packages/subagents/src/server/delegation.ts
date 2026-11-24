import type { ModelCatalogPort } from '@mini-harness/models/api';
import type { ExecutionAccess } from '@mini-harness/runs/api';
import type { SessionAccess } from '@mini-harness/sessions/records';
import type { SessionRecord } from '@mini-harness/sessions/identity';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';

export interface SubagentPolicy { maxDepth: number; maxParallel: number; model: ModelChoice | null }

interface Waiter {
  cancel(): void;
  start(): void;
}

export class Semaphore {
  active = 0;
  private readonly queue: Waiter[] = [];

  constructor(public limit = 4) {}

  setLimit(limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 16) throw new Error('Invalid parallel limit');
    this.limit = limit;
    this.drain();
  }

  private drain() {
    while (this.active < this.limit && this.queue.length) {
      const next = this.queue.shift();
      if (!next) break;
      next.start();
    }
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        cancel: () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(signal?.reason ?? new Error('Acquisition cancelled'));
        },
        start: () => {
          signal?.removeEventListener('abort', waiter.cancel);
          this.active++;
          let held = true;
          resolve(() => {
            if (!held) return;
            held = false;
            this.active--;
            this.drain();
          });
        }
      };
      signal?.addEventListener('abort', waiter.cancel, { once: true });
      this.queue.push(waiter);
      this.drain();
    });
  }

  async lease(signal?: AbortSignal) {
    let release: (() => void) | undefined = await this.acquire(signal);
    let waiting = 0, closed = false;
    return {
      pause: async <T>(task: () => Promise<T>): Promise<T> => {
        waiting++;
        release?.();
        release = undefined;
        try { return await task(); }
        finally {
          waiting--;
          if (!waiting && !closed && !signal?.aborted) {
            const next = await this.acquire(signal);
            if (closed || waiting) next();
            else release = next;
          }
        }
      },
      release() { closed = true; release?.(); release = undefined; }
    };
  }
}

type ChildLease = Awaited<ReturnType<Semaphore['lease']>>;

export function selectChildModel(request: { provider?: string; model?: string },
    defaults: ModelChoice | null, parent: ModelChoice): ModelChoice {
  const provider = request.provider?.trim();
  const model = request.model?.trim();
  if (provider) return { provider, id: model ?? '' };
  const inherited = defaults ?? parent;
  return { provider: inherited.provider, id: model || inherited.id };
}

/** Prefer the action over an injected workspace preamble in delegated task titles. */
export function childTitle(task: string) {
  const action = task.trim().replace(/^in the workspace at [^,\n]+,\s*/i, '').trim();
  const firstLine = action.split(/\r?\n/).find((line) => line.trim()) ?? action;
  return (firstLine || 'Subagent task').slice(0, 72);
}

export function requireChildDepth(parentDepth: number, maxDepth = 1): void {
  if (parentDepth >= maxDepth) throw new Error('Recursive subagents reached the configured depth limit');
}


export class Delegation {
  readonly semaphore: Semaphore;
  private readonly leases = new Map<string, ChildLease>();

  constructor(private readonly sessions: SessionAccess, private readonly runs: ExecutionAccess, private readonly models: (id?: string) => ModelCatalogPort,
    private readonly settings: () => SubagentPolicy) {
    this.semaphore = new Semaphore(settings().maxParallel);
  }

  visible(id: string) { return this.sessions.depth(id) < this.settings().maxDepth; }

  private async acquire(record: SessionRecord, signal: AbortSignal) {
    const lease = await this.semaphore.lease(signal);
    this.leases.set(record.id, lease);
    return () => { this.leases.delete(record.id); lease.release(); };
  }

  delegate(id: string, request: { task: string; provider?: string; model?: string }, signal?: AbortSignal) {
    const model = selectChildModel(request, this.settings().model, this.runs.model(id));
    const task = () => this.run(id, request.task, model, this.runs.signal(id, signal));
    const lease = this.leases.get(id);
    return lease ? lease.pause(task) : task();
  }

  private async run(parentId: string, task: string, choice: ModelChoice, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const parent = this.sessions.get(parentId);
    if (!parent) throw new Error('Parent conversation not found');
    this.sessions.assertAvailable(parentId);
    requireChildDepth(this.sessions.depth(parentId), this.settings().maxDepth);
    const model = this.models(parentId).resolve(choice);
    if (!model) throw new Error('Unknown child model: ' + choice.provider + '/' + choice.id);
    const record = this.sessions.create({
      parentId, workspaceId: parent.workspaceId, title: childTitle(task)
    });
    try {
      const text = await this.runs.send(record.id, task, { signal, model, source: 'agent',
        acquire: (cancellation) => this.acquire(record, cancellation) });
      return { id: record.id, text };
    } catch (error) {
      if (this.sessions.get(record.id)) this.sessions.rename(record.id,
        (signal?.aborted || this.runs.info(record.id)?.state === 'cancelled' ? '[Cancelled] ' : '[Failed] ') + childTitle(task).slice(0, 60));
      throw error;
    }
  }
}
