/** A single owner for each live execution; durable state belongs to Session Log. */
export class AgentRegistry {
  private readonly active = new Map<string, 'run' | 'compaction'>();
  private readonly preparing = new Map<string, Promise<void>>();

  pendingInScope(keys: ReadonlySet<string> | undefined, address: (id: string) => readonly string[]) {
    if (!keys) return this.preparing.size > 0;
    return [...this.preparing.keys()].some((id) => address(id).some((key) => keys.has(key)));
  }
  has(id: string) { return this.active.has(id); }
  acceptsInput(id: string) { return this.active.get(id) === 'run'; }

  enter(id: string, kind: 'run' | 'compaction' = 'run') {
    if (this.active.has(id)) throw new Error('Conversation is already running');
    this.active.set(id, kind);
    return () => this.active.delete(id);
  }

  async prepare(id: string, prepare: () => Promise<void>) {
    let pending = this.preparing.get(id);
    if (!pending) {
      pending = Promise.resolve().then(prepare);
      this.preparing.set(id, pending);
    }
    try { await pending; }
    finally { if (this.preparing.get(id) === pending) this.preparing.delete(id); }
  }

  async settle(ids?: string[]) {
    await Promise.allSettled(ids ? ids.map((id) => this.preparing.get(id)) : this.preparing.values());
  }
}
