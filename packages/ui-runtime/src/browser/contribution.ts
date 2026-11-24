import type { Context } from 'cordis';
import type { PluginConfiguration } from '@mini-harness/kernel/configuration';

export type BrowserRelease = () => void | Promise<void>;

export interface BrowserContributionSource {
  readonly id: string;
  readonly signal: AbortSignal;
  readonly configuration: PluginConfiguration;
  service<Name extends keyof Context & string>(name: Name): NonNullable<Context[Name]>;
  effect(install: () => BrowserRelease): BrowserRelease;
}
export type BrowserContribution<Args extends unknown[], Result> =
  (source: BrowserContributionSource, ...args: Args) => Result;

/** Highest order wins. Equal orders prefer the most recently registered contribution. */
export class KeyedContributions<Key, Value> {
  private readonly entries = new Map<Key, Set<{ value: Value; order: number }>>();

  add(key: Key, value: Value, order = 0) {
    const current = this.entries.get(key) ?? new Set();
    this.entries.set(key, current);
    const entry = { value, order };
    current.add(entry);
    return () => {
      if (current.delete(entry) && !current.size) this.entries.delete(key);
    };
  }

  get(key: Key) {
    let selected: { value: Value; order: number } | undefined;
    for (const entry of this.entries.get(key) ?? []) if (!selected || entry.order >= selected.order) selected = entry;
    return selected?.value;
  }

  get size() { return this.entries.size; }

  *values() {
    for (const key of this.entries.keys()) yield this.get(key)!;
  }
}
