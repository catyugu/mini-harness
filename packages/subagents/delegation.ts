import type { ModelCatalogPort } from '@mini-harness/models/api';
import type { AgentPort } from '@mini-harness/agent/api';
import type { RunPort } from '@mini-harness/runs/api';
import type { SessionStore } from '@mini-harness/sessions/store';
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

  async run<T>(work: (lease: { pause<R>(task: () => Promise<R>): Promise<R> }) => Promise<T>, signal?: AbortSignal) {
    let release: (() => void) | undefined = await this.acquire(signal);
    let waiting = 0;
    try {
      return await work({
        pause: async (task) => {
          waiting++;
          release?.();
          release = undefined;
          try { return await task(); }
          finally {
            waiting--;
            if (!waiting && !signal?.aborted) {
              const next = await this.acquire(signal);
              if (waiting) next();
              else release = next;
            }
          }
        }
      });
    } finally { release?.(); }
  }
}

type ChildLease = Parameters<Parameters<Semaphore['run']>[0]>[0];

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

  constructor(private readonly registry: SessionStore, private readonly agent: Pick<AgentPort, 'activeModel'>, private readonly models: (id?: string) => ModelCatalogPort,
    private readonly runs: () => RunPort, private readonly settings: () => SubagentPolicy,
    private readonly assertAvailable: (id: string) => void) {
    this.semaphore = new Semaphore(settings().maxParallel);
  }

  visible(id: string) { return this.registry.depth(id) < this.settings().maxDepth; }

  private schedule(record: SessionRecord, task: () => Promise<string>, signal: AbortSignal) {
    if (!record.parentId) return task();
    return this.semaphore.run(async (lease) => {
      this.leases.set(record.id, lease);
      try { return await task(); }
      finally { this.leases.delete(record.id); }
    }, signal);
  }

  delegate(id: string, request: { task: string; provider?: string; model?: string }, signal?: AbortSignal) {
    const model = selectChildModel(request, this.settings().model, this.agent.activeModel(id));
    const task = () => this.run(id, request.task, model, this.runs().signal(id, signal));
    const lease = this.leases.get(id);
    return lease ? lease.pause(task) : task();
  }

  private async run(parentId: string, task: string, choice: ModelChoice, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const parent = this.registry.get(parentId);
    if (!parent) throw new Error('Parent conversation not found');
    this.assertAvailable(parentId);
    requireChildDepth(this.registry.depth(parentId), this.settings().maxDepth);
    const model = this.models(parentId).resolve(choice);
    if (!model) throw new Error('Unknown child model: ' + choice.provider + '/' + choice.id);
    const record = this.registry.create({
      parentId, workspaceId: parent.workspaceId, title: childTitle(task)
    });
    try {
      const text = await this.runs().send(record.id, task, undefined, { signal, model, source: 'agent',
        schedule: (run, cancellation) => this.schedule(record, run, cancellation) });
      return { id: record.id, text };
    } catch (error) {
      if (this.registry.get(record.id)) this.registry.rename(record.id,
        (signal?.aborted || this.runs().info(record.id)?.state === 'cancelled' ? '[Cancelled] ' : '[Failed] ') + childTitle(task).slice(0, 60));
      throw error;
    }
  }
}
