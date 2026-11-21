export class Semaphore {
  limit: number;
  active: number;
  queue: any[];
  constructor(limit: number = 2) {
    this.limit = limit;
    this.active = 0;
    this.queue = [];
  }
  setLimit(limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 16) throw new Error('Invalid parallel limit');
    this.limit = limit;
    this.drain();
  }
  drain() {
    while (this.active < this.limit && this.queue.length) {
      const next = this.queue.shift();
      if (next.signal?.aborted) { next.reject(next.signal.reason ?? new Error('Aborted')); continue; }
      next.signal?.removeEventListener('abort', next.cancel);
      this.active++;
      next.resolve(() => { this.active--; this.drain(); });
    }
  }
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Aborted'));
    return new Promise<() => void>((resolve, reject) => {
      const entry: any = { resolve, reject, signal };
      entry.cancel = () => {
        const i = this.queue.indexOf(entry);
        if (i >= 0) this.queue.splice(i, 1);
        reject(signal.reason ?? new Error('Aborted'));
      };
      signal?.addEventListener('abort', entry.cancel, { once: true });
      this.queue.push(entry);
      this.drain();
    });
  }
  async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try { return await work(); } finally { release(); }
  }
}

export function selectChildModel(request: {provider?: string; model?: string}, defaults: {provider:string; model:string}, parent: {provider:string; id:string}) {
  const explicit = typeof request?.provider === 'string' && request.provider.trim();
  const provider = explicit ? request.provider.trim() : (defaults.provider || parent.provider || '');
  const model = explicit ? (request.model || '') : (request?.model || defaults.model || (provider === parent.provider ? parent.id : ''));
  return { provider, id: model };
}

export function requireChildDepth(parentDepth: number): void {
  if (parentDepth !== 0) throw new Error('Recursive subagents are prohibited');
}
