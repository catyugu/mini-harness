import type { ModelChoice } from './registry.js';

interface Waiter {
  signal?: AbortSignal;
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
        signal,
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
