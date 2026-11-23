/** Browser-facing slot registry: declarations and contributions have independent lifetimes.
 * Contributions can arrive before their owner and are restored when an owner remounts.
 * The registry has no knowledge of business features or Cordis.
 */
export type SlotName =
  | 'sidebar.primary' | 'sidebar.actions' | 'sidebar.navigation' | 'sidebar.footer'
  | 'header.title' | 'header.actions' | 'conversation.body' | 'conversation.header'
  | 'conversation.composer' | 'conversation.approvals'
  | 'settings.extensions' | 'inspector.extensions' | 'dialog.root' | 'page.main';
export type SlotKind = 'single' | 'list';
interface Entry { node: HTMLElement; order: number; sequence: number }

export class SlotRegistry {
  private readonly owners = new Map<SlotName, { container: HTMLElement; kind: SlotKind }>();
  private readonly entries = new Map<SlotName, Map<HTMLElement, Entry>>();
  private sequence = 0;

  define(name: SlotName, container: HTMLElement, kind: SlotKind = 'list'): () => void {
    if (this.owners.has(name)) throw new Error('Duplicate slot owner: ' + name);
    if (container.childElementCount) throw new Error('Slot outlet must start empty: ' + name);
    const owner = { container, kind };
    const entries = this.entries.get(name);
    if (kind === 'single' && entries && entries.size > 1) throw new Error('Multiple entries for single slot: ' + name);
    this.owners.set(name, owner);
    this.render(name);
    return () => {
      if (this.owners.get(name) !== owner) return;
      this.owners.delete(name);
      container.replaceChildren();
    };
  }

  register(name: SlotName, node: HTMLElement, order = 0): () => void {
    let entries = this.entries.get(name);
    if (!entries) this.entries.set(name, entries = new Map());
    if (entries.has(node)) throw new Error('Duplicate node contribution: ' + name);
    if (this.owners.get(name)?.kind === 'single' && entries.size)
      throw new Error('Multiple entries for single slot: ' + name);
    entries.set(node, { node, order, sequence: ++this.sequence });
    this.render(name);
    return () => {
      if (!entries.delete(node)) return;
      if (!entries.size) this.entries.delete(name);
      node.remove();
      this.render(name);
    };
  }

  private render(name: SlotName) {
    const owner = this.owners.get(name);
    if (!owner) return;
    const nodes = [...(this.entries.get(name)?.values() ?? [])]
      .sort((a, b) => a.order - b.order || a.sequence - b.sequence).map(({ node }) => node);
    owner.container.replaceChildren(...nodes);
  }
}
