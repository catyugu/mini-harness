/** Lowest priority wins. Contributions with the same key and priority conflict. */
export class KeyedRegistry<Key, Value> {
  private readonly entries = new Map<Key, Set<{ value: Value; priority: number }>>();

  add(key: Key, value: Value, priority = 0) {
    const current = this.entries.get(key) ?? new Set();
    if ([...current].some((entry) => entry.priority === priority))
      throw new Error('Conflicting contribution priority: ' + String(key));
    this.entries.set(key, current);
    const entry = { value, priority };
    current.add(entry);
    return () => {
      if (current.delete(entry) && !current.size) this.entries.delete(key);
    };
  }

  get(key: Key) {
    let selected: { value: Value; priority: number } | undefined;
    for (const entry of this.entries.get(key) ?? [])
      if (!selected || entry.priority < selected.priority) selected = entry;
    return selected?.value;
  }

  get size() {
    return this.entries.size;
  }

  *values() {
    for (const key of this.entries.keys()) yield this.get(key)!;
  }
}
