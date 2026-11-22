import type { Settings } from '../../src/config.js';
import type { DelegationPort } from '../../src/contracts/delegation.js';
import type { PiSessions } from '../../src/adapters/pi/sessions.js';
import type { Runs } from '../../src/services/runs.js';
import type { SessionRegistry } from '../../src/services/conversations.js';
import type { Conversation, ModelChoice } from '../../src/contracts/conversation.js';

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
    while (this.active < this.limit && this.queue.length) this.queue.shift().start();
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        cancel: () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(signal.reason);
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
    let release = await this.acquire(signal);
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

export type ChildLease = Parameters<Parameters<Semaphore['run']>[0]>[0];

export function selectChildModel(request: { provider?: string; model?: string },
    defaults: { provider: string; model: string }, parent: ModelChoice): ModelChoice {
  const provider = request.provider?.trim();
  const model = request.model?.trim();
  if (provider) return { provider, id: model ?? '' };
  const inheritedProvider = defaults.provider.trim() || parent.provider;
  const inheritedModel = defaults.model.trim() || (inheritedProvider === parent.provider ? parent.id : '');
  return { provider: inheritedProvider, id: model || inheritedModel };
}

export function requireChildDepth(parentDepth: number, maxDepth = 1): void {
  if (parentDepth >= maxDepth) throw new Error('Recursive subagents reached the configured depth limit');
}


export class Delegation implements DelegationPort {
  readonly semaphore: Semaphore;
  get parallelLimit() { return this.semaphore.limit; }
  get activeChildren() { return this.semaphore.active; }
  private readonly leases = new Map<string, ChildLease>();

  constructor(private readonly registry: SessionRegistry, private readonly pi: PiSessions,
    private readonly runs: () => Runs, private readonly settings: () => Settings['subagents'],
    private readonly assertAvailable: (id: string) => void) {
    this.semaphore = new Semaphore(settings().maxParallel);
  }

  validate(settings: Settings['subagents']) {
    if (settings.provider) this.pi.resolveModel({ provider: settings.provider, id: settings.model });
  }

  configure() { this.semaphore.setLimit(this.settings().maxParallel); }

  checkProvider(id: string, removing = false) {
    const policy = this.settings();
    if (policy.provider !== id) return;
    if (removing) throw new Error('Change the Subagents provider before removing this endpoint');
    this.validate(policy);
  }

  visible(id: string) { return this.registry.depth(id) < this.settings().maxDepth; }

  schedule(record: Conversation, task: () => Promise<string>, signal: AbortSignal) {
    if (!record.parentId) return task();
    return this.semaphore.run(async (lease) => {
      this.leases.set(record.id, lease);
      try { return await task(); }
      finally { this.leases.delete(record.id); }
    }, signal);
  }

  delegate(id: string, request: { task: string; provider?: string; model?: string }, signal?: AbortSignal) {
    const model = selectChildModel(request, this.settings(), this.pi.activeModel(id));
    const task = () => this.run(id, request.task, model, this.runs().signal(id, signal));
    const lease = this.leases.get(id);
    return lease ? lease.pause(task) : task();
  }

  async run(parentId: string, task: string, choice: ModelChoice, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const parent = this.registry.get(parentId);
    if (!parent) throw new Error('Parent conversation not found');
    this.assertAvailable(parentId);
    requireChildDepth(this.registry.depth(parentId), this.settings().maxDepth);
    const model = this.pi.resolveModel(choice);
    const record = this.registry.create({
      parentId, workspaceId: parent.workspaceId, title: task.slice(0, 72), model: model && this.pi.modelInfo(model)
    });
    try {
      const text = await this.runs().send(record.id, task, undefined, { signal });
      return { id: record.id, text };
    } catch (error) {
      if (this.registry.get(record.id)) this.registry.update(record.id, {
        title: (signal?.aborted || this.runs().info(record.id)?.state === 'cancelled' ? '[Cancelled] ' : '[Failed] ') + task.slice(0, 60)
      });
      throw error;
    }
  }
}
