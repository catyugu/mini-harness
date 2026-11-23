import type { PluginScope } from '@mini-harness/contracts/capabilities';
import type { Settings } from '@mini-harness/contracts/config';
import type { SessionRecord } from '@mini-harness/contracts/conversation';
import type { PluginCatalog, PluginPlan } from './catalog.js';

interface Parent {
  key?: string;
  ids: ReadonlyMap<string, string>;
  owners: ReadonlyMap<string, string>;
  providers: ReadonlyMap<string, string>;
}

interface ScopedNode {
  key: string;
  parent?: string;
  scope: PluginScope;
  isolates: string[];
  plugins: { plan: PluginPlan; id: string; needs: string[] }[];
}

export function resolveScopes(settings: Settings, describe: PluginCatalog['plans'], session: (id: string) => SessionRecord | undefined,
  descriptors: ReturnType<PluginCatalog['descriptors']>, application: PluginPlan[], providers: ReadonlyMap<string, string>,
  active: ReadonlySet<string>, released: ReadonlySet<string>) {
  const root: Parent = { ids: new Map(application.map(({ id }) => [id, id])), owners: providers, providers };
  const graph = new Map<string, Parent>();
  const visiting = new Set<string>();
  const nodes: ScopedNode[] = [];
  function visit(key: string): Parent {
    const cached = graph.get(key);
    if (cached) return cached;
    if (visiting.has(key)) throw new Error('Cyclic scope ancestry: ' + key);
    visiting.add(key);
    const [kind, id] = key.split(':');
    const record = kind === 'session' ? session(id) : undefined;
    if (kind === 'session' && !record) { visiting.delete(key); return root; }
    const scope: PluginScope = record ? { kind: 'session', workspaceId: record.workspaceId, sessionId: id } :
      { kind: 'workspace', workspaceId: id };
    const parentKey = record && (record.parentId ? 'session:' + record.parentId : 'workspace:' + record.workspaceId);
    const parent = parentKey ? visit(parentKey) : root;
    visiting.delete(key);
    const overrides = settings.scopes[key];
    if (released.has(key) || !overrides) { graph.set(key, parent); return parent; }
    const { plans, providers } = describe(settings, descriptors, scope.kind, parent.providers, new Set(parent.ids.keys()), overrides);
    const ids = new Map(parent.ids);
    const owners = new Map(parent.owners);
    const isolates = new Set<string>();
    for (const plan of plans) {
      const id = key + '/' + plan.id;
      ids.set(plan.id, id);
      for (const service of plan.descriptor.provides ?? []) { owners.set(service, id); isolates.add(service); }
    }
    const current = { key, ids, owners, providers };
    graph.set(key, current);
    if (active.has(key)) nodes.push({
      key, parent: parent.key, scope, isolates: [...isolates].sort(),
      plugins: plans.map((plan) => {
        const needs = new Set<string>();
        for (const dependency of plan.descriptor.requires ?? []) {
          const id = ids.get(dependency);
          if (id) needs.add(id);
        }
        for (const service of Object.keys(plan.services)) {
          const owner = owners.get(service);
          if (owner && owner !== 'application') needs.add(owner);
        }
        return { plan, id: key + '/' + plan.id, needs: [...needs] };
      })
    });
    return current;
  }
  for (const key of new Set([...Object.keys(settings.scopes), ...active])) if (!released.has(key)) visit(key);
  return nodes;
}
