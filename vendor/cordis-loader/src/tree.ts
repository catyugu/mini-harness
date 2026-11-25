import { type Fiber } from '@mini-harness/cordis'
import { Entry, type EntryOptions } from './entry.ts'

/** Store the desired entries and their Cordis fibers for one runtime. */
export class EntryTree {
  private tail: Promise<unknown> = Promise.resolve()
  private closed = false
  private readonly entries = new Map<string, Entry>()

  get(id: string) {
    return this.entries.get(id)
  }

  values() {
    return this.entries.values()
  }

  /** Settle the desired graph, returning entry failures for the host to handle. */
  async update(options: readonly EntryOptions[]) {
    if (this.closed) throw new Error('Entry tree is closed')
    const desired = new Map(options.map(option => [option.id, option]))
    if (desired.size !== options.length) throw new Error('Duplicate loader entry ID')
    return this.enqueue(() => this.reconcile(desired))
  }

  private enqueue<T>(work: () => Promise<T>) {
    const next = this.tail.then(work)
    this.tail = next.catch(() => {})
    return next
  }

  private async reconcile(desired: ReadonlyMap<string, EntryOptions>) {
    const removed: Entry[] = []
    for (const [id, entry] of this.entries) {
      const next = desired.get(id)
      if (next && entry.matches(next)) continue
      this.entries.delete(id)
      removed.push(entry)
    }
    // Cordis tears down dependent fibers before their providers. Start every
    // disposal before waiting so sibling scopes can also settle concurrently.
    await Promise.all(removed.map(entry => entry.stop()))
    await Promise.all([...desired.values()].map(option => {
      const previous = this.entries.get(option.id)
      if (previous) return previous.update(option)
      const entry = new Entry(option)
      this.entries.set(option.id, entry)
      return entry.start()
    }))
    await this.settle()
    const failures = new Map<string, unknown>()
    for (const [id, entry] of this.entries) {
      if (entry.error !== undefined) failures.set(id, entry.error)
    }
    return failures
  }

  /** Wait for current lifecycle work, optionally restricted to selected entry subtrees. */
  async settle(ids?: readonly string[]) {
    while (true) {
      const entries = ids ? ids.flatMap(id => this.entries.get(id) ?? []) : [...this.entries.values()]
      const roots = new Set(entries.flatMap(({ fiber }) => fiber ? [fiber] : []))
      const first = roots.values().next().value
      if (!first) return
      const pending: Promise<void>[] = []
      // Include child plugin lifecycles, not just the entrypoint fibers.
      for (const runtime of first.ctx.registry.values()) {
        for (const fiber of runtime.fibers) {
          if (!fiber.inertia) continue
          for (let owner: Fiber = fiber; owner.runtime; owner = owner.parent.fiber) {
            if (!roots.has(owner)) continue
            pending.push(fiber.inertia)
            break
          }
        }
      }
      if (!pending.length) return
      await Promise.all(pending)
    }
  }

  close() {
    this.closed = true
    return this.enqueue(async () => { await this.reconcile(new Map()) })
  }
}
