import { Entry, type EntryOptions } from './entry.js'

/** Store the desired entries and their Cordis fibers for one runtime. */
export class EntryTree {
  private readonly entries = new Map<string, Entry>()

  get(id: string) {
    return this.entries.get(id)
  }

  values() {
    return this.entries.values()
  }

  async update(options: readonly EntryOptions[]) {
    const desired = new Map(options.map(option => [option.id, option]))
    const removed: Entry[] = []
    for (const [id, entry] of this.entries) {
      const next = desired.get(id)
      if (next?.context === entry.options.context && next.module === entry.options.module) continue
      this.entries.delete(id)
      removed.push(entry)
    }
    // Cordis tears down dependent fibers before their providers. Start every
    // disposal before waiting so sibling scopes can also settle concurrently.
    await Promise.all(removed.map(entry => entry.stop()))
    await Promise.all(options.map(option => {
      const previous = this.entries.get(option.id)
      if (previous) return previous.update(option)
      const entry = new Entry(option)
      this.entries.set(option.id, entry)
      return entry.start()
    }))
    await this.settle()
  }

  private async settle() {
    while (true) {
      const pending = [...this.entries.values()].flatMap(({ fiber }) => fiber?.inertia ?? [])
      if (!pending.length) return
      await Promise.all(pending)
    }
  }

  close() {
    return this.update([])
  }
}
