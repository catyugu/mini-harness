export const mountSlots = ['sidebar', 'composer', 'settings', 'inspector', 'approvals', 'session-navigation', 'conversation', 'dialogs', 'main', 'conversation-header'] as const;
export type MountSlot = typeof mountSlots[number];
type RegionKind = 'list' | 'keyed' | 'match';
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

const regions = {
  'conversation.chat.node': 'match',
  'tool.call.toolview': 'keyed',
  'tool.call.action': 'keyed',
  'conversation.input.dock': 'list',
  'conversation.composer.dock': 'list',
  'sidebar.panellist': 'list',
  'sidebar.right.pane.tab': 'keyed',
  'settings.section': 'list',
  'plugins.detail.section': 'list'
} satisfies Record<string, RegionKind>;
export type PluginRegion = keyof typeof regions;
export type Region = PluginRegion | `mount:${MountSlot}`;

const definitions = new Map<string, RegionKind>(Object.entries(regions));
for (const slot of mountSlots) definitions.set('mount:' + slot, 'list');

export class ContributionRegistry {
  private entries = new Map<Region, Set<Contribution>>();
  private listeners = new Set<(region: Region) => void>();

  constructor(private readonly report: (error: Error) => void = console.error) {}

  register<T>(region: Region, item: Contribution<T>) {
    const kind = definitions.get(region);
    if (!kind) throw new Error('Unknown region: ' + region);
    if (!item.owner || !item.id) throw new Error('Contribution requires owner and identity');
    if (kind === 'keyed' && !item.key) throw new Error('Keyed contribution requires a key');
    if (item.scope && (!item.scope.workspaceId || item.scope.sessionId === '')) throw new Error('Invalid contribution scope');
    if (![item.order ?? 0, item.priority ?? 0].every(Number.isFinite)) throw new Error('Invalid contribution ordering');
    const entries = this.entries.get(region) ?? new Set();
    for (const entry of entries) {
      if (entry.owner === item.owner && entry.id === item.id &&
        entry.scope?.workspaceId === item.scope?.workspaceId && entry.scope?.sessionId === item.scope?.sessionId)
        throw new Error('Duplicate contribution: ' + item.owner + '/' + item.id);
    }
    const entry = { ...item };
    entries.add(entry);
    this.entries.set(region, entries);
    this.emit(region);
    return () => { if (entries.delete(entry)) this.emit(region); };
  }

  resolve<T>(region: Region, scope?: ContributionScope, key?: string, context?: unknown): Contribution<T>[] {
    const kind = definitions.get(region);
    const winners = new Map<string, { entry: Contribution; order: number }>();
    for (const entry of this.entries.get(region) ?? []) {
      if (entry.scope && (entry.scope.workspaceId !== scope?.workspaceId ||
        (entry.scope.sessionId && entry.scope.sessionId !== scope?.sessionId))) continue;
      if (kind === 'keyed' && key !== undefined && entry.key !== key) continue;
      if (kind === 'match' && entry.accepts && !entry.accepts(context)) continue;
      const id = kind === 'keyed' ? entry.key : kind === 'match' ? region : entry.id;
      const previous = winners.get(id);
      if (!previous || (entry.priority ?? 0) >= (previous.entry.priority ?? 0))
        winners.set(id, { entry, order: previous?.order ?? entry.order ?? 0 });
    }
    return [...winners.values()].sort((a, b) => a.order - b.order).map(({ entry }) => entry as Contribution<T>);
  }

  watch(listener: (region: Region) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(region: Region) {
    const errors: Error[] = [];
    for (const listener of this.listeners) {
      try { listener(region); }
      catch (error) { errors.push(error); }
    }
    for (const error of errors) this.report(error);
  }
}
