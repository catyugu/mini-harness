interface ScopedRefresh<T> {
  fetch(ids: string[]): Promise<T>;
  merge(current: T, updated: T, ids: ReadonlySet<string>): T;
}

export class RemoteStore<T> extends EventTarget {
  private snapshot?: T;
  private revision = -1;
  private full = false;
  private readonly dirty = new Set<string>();
  private pending?: Promise<void>;

  constructor(
    private readonly fetchSnapshot: () => Promise<T>,
    private readonly scoped?: ScopedRefresh<T>,
  ) {
    super();
  }

  get = (): T => {
    if (this.snapshot === undefined) throw new Error('Remote snapshot has not loaded');
    return this.snapshot;
  };

  subscribe = (listener: () => void, signal: AbortSignal) => {
    this.addEventListener('change', listener, { signal });
  };

  sync(revision: number, reconnect: boolean, id?: string) {
    if (!reconnect && revision <= this.revision) return this.pending;
    const consecutive = revision === this.revision + 1;
    this.revision = revision;
    if (!reconnect && consecutive && id && this.scoped && this.snapshot !== undefined) this.dirty.add(id);
    else this.full = true;
    return this.schedule();
  }

  refresh = () => {
    this.full = true;
    return this.schedule();
  };

  private schedule() {
    this.pending ??= this.load().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async load() {
    try {
      while (this.full || this.dirty.size) {
        const full = this.full || this.dirty.size > 100;
        const dirty = new Set(this.dirty);
        this.full = false;
        this.dirty.clear();
        if (full) this.snapshot = await this.fetchSnapshot();
        else {
          if (!this.scoped) throw new Error('Scoped refresh unavailable');
          const updated = await this.scoped.fetch([...dirty]);
          if (this.snapshot === undefined) throw new Error('Missing remote snapshot for scoped update');
          this.snapshot = this.scoped.merge(this.snapshot, updated, dirty);
        }
        if (!this.full && !this.dirty.size) this.dispatchEvent(new Event('change'));
      }
    } catch (error) {
      this.full = true;
      throw error;
    }
  }
}
