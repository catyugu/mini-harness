export type RegionKind = 'single' | 'list' | 'keyed' | 'chain';
export interface ContributionScope { workspaceId: string; sessionId?: string }
export interface Contribution<T = unknown> {
  id: string;
  owner: string;
  value: T;
  key?: string;
  order?: number;
  priority?: number;
  scope?: ContributionScope;
  accepts?: (context: unknown) => boolean;
}
export const regions = {
  'conversation.chat.node': 'chain',
  'tool.call.toolview': 'keyed',
  'tool.call.action': 'keyed',
  'conversation.input.dock': 'list',
  'conversation.composer.dock': 'list',
  'sidebar.panellist': 'list',
  'sidebar.right.pane.tab': 'keyed',
  'settings.section': 'list',
  'plugins.detail.section': 'list'
} satisfies Record<string, RegionKind>;
export type Region = keyof typeof regions;

/** Pure registry; hosts own rendering and Cordis owns each registration's lifetime. */
export class ContributionRegistry {
  private definitions = new Map<string, RegionKind>(Object.entries(regions));
  private entries = new Map<string, (Contribution & { sequence: number })[]>();
  private listeners = new Set<(region: string) => void>();
  private sequence = 0;

  define(region: string, kind: RegionKind) {
    if (this.definitions.has(region)) throw new Error('Duplicate region: ' + region);
    this.definitions.set(region, kind);
  }

  register<T>(region: string, item: Contribution<T>) {
    const kind = this.definitions.get(region);
    if (!kind) throw new Error('Unknown region: ' + region);
    if (!item.owner || !item.id) throw new Error('Contribution requires owner and identity');
    if (kind === 'keyed' && !item.key) throw new Error('Keyed contribution requires a key');
    if (item.scope && (!item.scope.workspaceId || (item.scope.sessionId !== undefined && !item.scope.sessionId)))
      throw new Error('Invalid contribution scope');
    if (![item.order ?? 0, item.priority ?? 0].every(Number.isFinite)) throw new Error('Invalid contribution ordering');
    const entries = this.entries.get(region) ?? [];
    if (entries.some((entry) => entry.owner === item.owner && entry.id === item.id && JSON.stringify(entry.scope) === JSON.stringify(item.scope)))
      throw new Error('Duplicate contribution: ' + item.owner + '/' + item.id);
    const entry = { ...item, sequence: ++this.sequence };
    entries.push(entry);
    this.entries.set(region, entries);
    try { this.emit(region); }
    catch (error) { this.entries.set(region, entries.filter((item) => item !== entry)); throw error; }
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      this.entries.set(region, (this.entries.get(region) ?? []).filter((item) => item !== entry));
      this.emit(region);
    };
  }

  resolve<T>(region: string, scope?: ContributionScope, key?: string, context?: unknown): Contribution<T>[] {
    const kind = this.definitions.get(region);
    if (!kind) throw new Error('Unknown region: ' + region);
    const entries = (this.entries.get(region) ?? []).filter((entry) =>
      (!entry.scope || (entry.scope.workspaceId === scope?.workspaceId && (!entry.scope.sessionId || entry.scope.sessionId === scope?.sessionId))) &&
      (key === undefined || entry.key === key) && (kind !== 'chain' || !entry.accepts || entry.accepts(context)));
    const winners = new Map<string, typeof entries[number]>();
    for (const entry of entries) {
      const identity = kind === 'keyed' ? entry.key : kind === 'single' || kind === 'chain' ? region : entry.id;
      const previous = winners.get(identity);
      if (!previous || (entry.priority ?? 0) > (previous.priority ?? 0) ||
        ((entry.priority ?? 0) === (previous.priority ?? 0) && entry.sequence > previous.sequence)) winners.set(identity, entry);
    }
    return [...winners.values()].map((entry) => {
      // Replacing a list item retains its original position.
      const original = entries.find((candidate) => candidate.id === entry.id);
      return { ...entry, order: original?.order ?? entry.order ?? 0 };
    }).sort((a, b) => a.order - b.order || a.sequence - b.sequence) as Contribution<T>[];
  }

  watch(listener: (region: string) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit(region: string) { for (const listener of this.listeners) listener(region); }
}
