/** A runtime-owned concurrency budget. Shrinking a pool never preempts admitted work. */
export class TaskPool {
  private capacity = 0;
  private running = 0;
  private readonly queue: (() => void)[] = [];

  constructor(limit: number) {
    this.limit = limit;
  }

  get active() {
    return this.running;
  }

  get limit() {
    return this.capacity;
  }

  set limit(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid parallel limit');
    this.capacity = limit;
    this.drain();
  }

  private drain() {
    while (this.running < this.capacity && this.queue.length) this.queue.shift()!();
  }

  /** Admission is managed by Task Runtime; consumers configure the limit. */
  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const cancel = () => {
        const index = this.queue.indexOf(start);
        if (index >= 0) this.queue.splice(index, 1);
        reject(signal.reason);
      };
      const start = () => {
        signal.removeEventListener('abort', cancel);
        this.running++;
        let held = true;
        resolve(() => {
          if (!held) return;
          held = false;
          this.running--;
          this.drain();
        });
      };
      signal.addEventListener('abort', cancel, { once: true });
      this.queue.push(start);
      this.drain();
    });
  }
}
