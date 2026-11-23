/** Browser-facing slot registry: declarations and contributions have independent lifetimes.
 * Contributions can arrive before their owner and are restored when an owner remounts.
 * The registry has no knowledge of business features or Cordis.
 */
/** Plugins declare their own slot names via TypeScript module augmentation. */
export interface SlotMap {
  'sidebar.primary': { kind: 'list' };
  'sidebar.actions': { kind: 'list' };
  'sidebar.navigation': { kind: 'list' };
  'sidebar.footer': { kind: 'list' };
  'header.actions': { kind: 'list' };
  'conversation.header': { kind: 'list' };
  'workspace.header': { kind: 'single' };
  'workspace.welcome': { kind: 'single' };
  'conversation.body': { kind: 'single' };
  'conversation.composer': { kind: 'list' };
  'conversation.approvals': { kind: 'list' };
  'settings.extensions': { kind: 'list' };
  'inspector.extensions': { kind: 'list' };
  'dialog.root': { kind: 'list' };
}
export type SlotName = keyof SlotMap & string;
export type SlotKind = 'single' | 'list';
export interface SlotMount {
  node: HTMLElement;
  dispose?(): void;
}
export type SlotRenderer = (signal: AbortSignal) => HTMLElement | SlotMount;
export type SlotDecorator = (node: HTMLElement, signal: AbortSignal) => HTMLElement | SlotMount;

interface Entry { key?: string; node?: HTMLElement; render?: SlotRenderer; order: number }
interface Decoration { key?: string; order: number; wrap: SlotDecorator }
interface Mounted { node: HTMLElement; release(): void }
interface ActiveEntry { base: Mounted; layers: { decoration: Decoration; mount: Mounted }[] }
interface Outlet { container: HTMLElement; kind: SlotKind; active: Map<Entry, ActiveEntry> }

export class SlotRegistry {
  private readonly owners = new Map<SlotName, Outlet>();
  private readonly entries = new Map<SlotName, Set<Entry>>();
  private readonly decorators = new Map<SlotName, Set<Decoration>>();

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
    if ([...(this.entries.get(name) ?? [])].some((entry) => entry.node === node))
      throw new Error('Duplicate node contribution: ' + name);
    return this.add(this.entries, name, { node, order });
  }

  registerKeyed(name: SlotName, key: string, render: SlotRenderer, order = 0): () => void {
    if (!key) throw new Error('A keyed slot contribution requires a key');
    return this.add(this.entries, name, { key, render, order });
  }

  decorate(name: SlotName, key: string | undefined, wrap: SlotDecorator, order = 0): () => void {
    return this.add(this.decorators, name, { key, wrap, order });
  }

  private add<T>(registry: Map<SlotName, Set<T>>, name: SlotName, value: T) {
    const entries = registry.get(name) ?? new Set<T>();
    entries.add(value);
    registry.set(name, entries);
    const dispose = () => {
      if (!entries.delete(value)) return;
      if (!entries.size) registry.delete(name);
      this.render(name);
    };
    try { this.render(name); }
    catch (error) { dispose(); throw error; }
    return dispose;
  }

  private mount(render: SlotRenderer, inner?: HTMLElement): Mounted {
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
          finally { if (mount.node !== inner) mount.node.remove(); }
        }
      };
    } catch (error) { lifetime.abort(); throw error; }
  }

  private unmount(outlet: Outlet, entry: Entry, active: ActiveEntry) {
    outlet.active.delete(entry);
    while (active.layers.length) active.layers.pop().mount.release();
    active.base.release();
  }

  private render(name: SlotName) {
    const owner = this.owners.get(name);
    if (!owner) return;
    const selected = new Map<string | Entry, Entry>();
    for (const entry of this.entries.get(name) ?? []) selected.set(entry.key ?? entry, entry);
    if (owner.kind === 'single' && selected.size > 1) throw new Error('Multiple entries for single slot: ' + name);
    const entries = [...selected.values()].sort((a, b) => a.order - b.order);
    const visible = new Set(entries);
    for (const [entry, active] of owner.active) if (!visible.has(entry)) this.unmount(owner, entry, active);
    const decorators = [...(this.decorators.get(name) ?? [])].sort((a, b) => a.order - b.order);
    const nodes = entries.map((entry) => {
      let active = owner.active.get(entry);
      if (!active) {
        active = { base: this.mount(entry.render ?? (() => entry.node)), layers: [] };
        owner.active.set(entry, active);
      }
      const applied = decorators.filter(({ key }) => key === undefined || key === entry.key);
      let reusable = 0;
      while (active.layers[reusable] && active.layers[reusable].decoration === applied[reusable]) reusable++;
      while (active.layers.length > reusable) active.layers.pop().mount.release();
      let node = active.layers.at(-1)?.mount.node ?? active.base.node;
      for (const decoration of applied.slice(reusable)) {
        const child = node;
        const mount = this.mount((signal) => decoration.wrap(child, signal), child);
        active.layers.push({ decoration, mount });
        node = mount.node;
      }
      return node;
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
