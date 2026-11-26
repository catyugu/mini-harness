/** Browser-facing slot registry: declarations and contributions have independent lifetimes.
 * Contributions can arrive before their owner and are restored when an owner remounts.
 * The registry has no knowledge of business features or Cordis.
 */
import { KeyedRegistry } from '@mini-harness/ui-runtime/keyed-registry';
import type { SlotOptions, SlotKind, SlotName, SlotRenderer } from './api.ts';

interface Entry {
  render: SlotRenderer;
  order: number;
}
type SlotKey = string | HTMLElement | SlotRenderer;

interface Mounted {
  node: HTMLElement;
  release(): void;
}
interface Outlet {
  place(nodes: readonly HTMLElement[]): void;
  kind: SlotKind;
  active: Map<Entry, Mounted>;
}

export class SlotRegistry {
  private readonly owners = new Map<SlotName, Outlet>();
  private readonly entries = new Map<SlotName, KeyedRegistry<SlotKey, Entry>>();

  define(
    name: SlotName,
    outlet: HTMLElement | ((nodes: readonly HTMLElement[]) => void),
    kind: SlotKind = 'list',
  ): () => void {
    if (this.owners.has(name)) throw new Error('Duplicate slot owner: ' + name);
    if (typeof outlet !== 'function' && outlet.childElementCount)
      throw new Error('Slot outlet must start empty: ' + name);
    const place =
      typeof outlet === 'function' ? outlet : (nodes: readonly HTMLElement[]) => placeNodes(outlet, nodes);
    const owner: Outlet = { place, kind, active: new Map() };
    this.owners.set(name, owner);
    const dispose = () => {
      if (this.owners.get(name) !== owner) return;
      this.owners.delete(name);
      for (const [entry, active] of owner.active) this.unmount(owner, entry, active);
      owner.place([]);
    };
    try {
      this.render(name);
    } catch (error) {
      dispose();
      throw error;
    }
    return dispose;
  }

  register(
    name: SlotName,
    contribution: HTMLElement | SlotRenderer,
    { key, order = 0, priority = 0 }: SlotOptions = {},
  ): () => void {
    const entries = this.entries.get(name) ?? new KeyedRegistry<SlotKey, Entry>();
    const render = typeof contribution === 'function' ? contribution : () => contribution;
    const identity = key ?? contribution;
    const remove = entries.add(identity, { render, order }, priority);
    this.entries.set(name, entries);
    const dispose = () => {
      const prior = entries.get(identity);
      remove();
      if (this.entries.get(name) === entries && !entries.size) this.entries.delete(name);
      if (prior !== entries.get(identity)) this.render(name);
    };
    try {
      this.render(name);
    } catch (error) {
      dispose();
      throw error;
    }
    return dispose;
  }

  private mount(render: SlotRenderer): Mounted {
    const lifetime = new AbortController();
    try {
      const result = render(lifetime.signal);
      const mount = 'node' in result ? result : { node: result };
      return {
        node: mount.node,
        release: () => {
          lifetime.abort();
          try {
            mount.dispose?.();
          } catch (error) {
            console.error('Slot cleanup failed', error);
          } finally {
            mount.node.remove();
          }
        },
      };
    } catch (error) {
      lifetime.abort();
      throw error;
    }
  }

  private unmount(outlet: Outlet, entry: Entry, active: Mounted) {
    outlet.active.delete(entry);
    active.release();
  }

  private render(name: SlotName) {
    const owner = this.owners.get(name);
    if (!owner) return;
    const entries = [...(this.entries.get(name)?.values() ?? [])].sort((a, b) => a.order - b.order);
    if (owner.kind === 'single' && entries.length > 1)
      throw new Error('Multiple entries for single slot: ' + name);
    const visible = new Set(entries);
    for (const [entry, active] of owner.active) if (!visible.has(entry)) this.unmount(owner, entry, active);
    const staged = new Map<Entry, Mounted>();
    try {
      for (const entry of entries) {
        if (owner.active.has(entry)) continue;
        staged.set(entry, this.mount(entry.render));
      }
    } catch (error) {
      for (const mount of staged.values()) mount.release();
      throw error;
    }
    for (const [entry, active] of staged) owner.active.set(entry, active);
    const nodes = entries.map((entry) => {
      const active = owner.active.get(entry);
      if (!active) throw new Error('Missing mounted slot contribution');
      return active.node;
    });
    owner.place(nodes);
  }
}

function placeNodes(container: HTMLElement, nodes: readonly HTMLElement[]) {
  const desired = new Set<Element>(nodes);
  for (const child of Array.from(container.children)) if (!desired.has(child)) child.remove();
  nodes.forEach((node, index) => {
    const current = container.children[index];
    if (current !== node) container.insertBefore(node, current ?? null);
  });
}
