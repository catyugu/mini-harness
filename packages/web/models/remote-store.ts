export class RemoteStore<T> extends EventTarget {
  private snapshot: T;
  private revision = -1;
  private requested = 0;
  private loaded = 0;
  private pending?: Promise<void>;

  constructor(private readonly fetchSnapshot: () => Promise<T>) { super(); }

  get = (): T => this.snapshot;

  subscribe = (listener: () => void, signal: AbortSignal) => {
    this.addEventListener('change', listener, { signal });
  };

  sync(revision: number, reconnect: boolean) {
    if (!reconnect && revision <= this.revision) return;
    return this.refresh().then(() => { this.revision = revision; });
  }

  refresh = (): Promise<void> => {
    this.requested++;
    this.pending ??= this.load().finally(() => { this.pending = undefined; });
    return this.pending;
  };

  private async load() {
    while (this.loaded < this.requested) {
      const requested = this.requested;
      const snapshot = await this.fetchSnapshot();
      if (requested !== this.requested) continue;
      this.loaded = requested;
      if (JSON.stringify(snapshot) === JSON.stringify(this.snapshot)) continue;
      this.snapshot = snapshot;
      this.dispatchEvent(new Event('change'));
    }
  }
}
