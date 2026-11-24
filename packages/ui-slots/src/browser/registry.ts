/** Browser-facing slot registry: declarations and contributions have independent lifetimes.
 * Contributions can arrive before their owner and are restored when an owner remounts.
 * The registry has no knowledge of business features or Cordis.
 */
import { KeyedRegistry } from '@mini-harness/ui-runtime/keyed-registry';
import type { KeyedSlotOptions, SlotKind, SlotName, SlotRenderer } from './api.js';

interface Entry { node?: HTMLElement; render?: SlotRenderer; order: number }
interface Mounted { node: HTMLElement; release(): void }
interface Outlet { container: HTMLElement; kind: SlotKind; active: Map<Entry, Mounted> }

export class SlotRegistry {
  private readonly owners = new Map<SlotName, Outlet>();
  private readonly entries = new Map<SlotName, KeyedRegistry<string | HTMLElement, Entry>>();

  define(name: SlotName, container: HTMLElement, kind: SlotKind = 'list'): () => void {
    if (this.owners.has(name)) throw new Error('Duplicate slot owner: ' + name);
    if (container.childElementCount) throw new Error('Slot outlet must start empty: ' + name);
    const owner: Outlet = { container, kind, active: new Map() };
    this.owners.set(name, owner);
    const dispose = () => {
      if (this.owners.get(name) !== owner) return;
      this.owners.delete(name);
      for (const [entry, active] of owner.active) this.unmount(owner, entry, active);
      container.replaceChildren();
    };
    try { this.render(name); }
    catch (error) { dispose(); throw error; }
    return dispose;
  }

  register(name: SlotName, node: HTMLElement, order = 0): () => void {
    if (this.entries.get(name)?.get(node))
      throw new Error('Duplicate node contribution: ' + name);
    return this.add(name, node, { node, order });
  }

  registerKeyed(name: SlotName, key: string, render: SlotRenderer, { order = 0 }: KeyedSlotOptions = {}): () => void {
    if (!key || !Number.isFinite(order)) throw new Error('Invalid keyed slot contribution');
    return this.add(name, key, { render, order });
  }

  private add(name: SlotName, key: string | HTMLElement, value: Entry) {
    const entries = this.entries.get(name) ?? new KeyedRegistry<string | HTMLElement, Entry>();
    this.entries.set(name, entries);
    const remove = entries.add(key, value, value.order);
    const dispose = () => {
      const prior = entries.get(key);
      remove();
      if (this.entries.get(name) === entries && !entries.size) this.entries.delete(name);
      if (prior !== entries.get(key)) this.render(name);
    };
    try { this.render(name); }
    catch (error) { dispose(); throw error; }
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
          try { mount.dispose?.(); }
          catch (error) { console.error('Slot cleanup failed', error); }
          finally { mount.node.remove(); }
        }
      };
    } catch (error) { lifetime.abort(); throw error; }
  }

  private unmount(outlet: Outlet, entry: Entry, active: Mounted) {
    outlet.active.delete(entry);
    active.release();
  }

  private render(name: SlotName) {
    const owner = this.owners.get(name);
    if (!owner) return;
    const entries = [...this.entries.get(name)?.values() ?? []].sort((a, b) => a.order - b.order);
    if (owner.kind === 'single' && entries.length > 1) throw new Error('Multiple entries for single slot: ' + name);
    const visible = new Set(entries);
    for (const [entry, active] of owner.active) if (!visible.has(entry)) this.unmount(owner, entry, active);
    const staged = new Map<Entry, Mounted>();
    try {
      for (const entry of entries) {
        if (owner.active.has(entry)) continue;
        const renderer: SlotRenderer = entry.render ?? (() => {
          if (!entry.node) throw new Error('Slot contribution has no node or renderer');
          return entry.node;
        });
        staged.set(entry, this.mount(renderer));
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
    const desired = new Set<Element>(nodes);
    const container = owner.container;
    for (const child of Array.from(container.children)) if (!desired.has(child)) child.remove();
    nodes.forEach((node, index) => {
      const current = container.children[index];
      if (current !== node) container.insertBefore(node, current ?? null);
    });
  }
}
