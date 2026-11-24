import type { PluginScope, ScopeDirectory } from '@mini-harness/kernel/scopes';
import type { PluginSettings } from '@mini-harness/plugin-api/configuration';
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

export function resolveScopes(settings: PluginSettings, describe: PluginCatalog['plans'], address: ScopeDirectory['address'],
  descriptors: ReturnType<PluginCatalog['descriptors']>, application: PluginPlan[], providers: ReadonlyMap<string, string>,
  active: ReadonlySet<string>, released: ReadonlySet<string>,
  unavailable: (id: string, error: unknown) => boolean) {
  const root: Parent = { ids: new Map(application.map(({ id }) => [id, id])), owners: providers, providers };
  const graph = new Map<string, Parent>();
  const visiting = new Set<string>();
  const nodes: ScopedNode[] = [];
  function visit(key: string): Parent {
    const cached = graph.get(key);
    if (cached) return cached;
    if (visiting.has(key)) throw new Error('Cyclic scope ancestry: ' + key);
    visiting.add(key);
    const lineage = address(key);
    const target = lineage.at(-1);
    if (!target || target.key !== key) { visiting.delete(key); return root; }
    const { scope } = target;
    const parentKey = lineage.at(-2)?.key;
    const parent = parentKey ? visit(parentKey) : root;
    visiting.delete(key);
    const overrides = settings.scopes[key];
    if (released.has(key) || !overrides) { graph.set(key, parent); return parent; }
    const enabled = descriptors.filter(({ id, scope: kind }) => kind === scope.kind && overrides.plugins?.[id]);
    const isolates = new Set<string>();
    const ids = new Map(parent.ids);
    const owners = new Map(parent.owners);
    let providers = parent.providers;
    let plans: PluginPlan[] = [];
    try {
      ({ plans, providers } = describe(settings, descriptors, scope.kind, parent.providers,
        new Set(parent.ids.keys()), overrides, (id, error) => unavailable(key + '/' + id, error)));
    } catch (error) {
      if (!enabled.length && !Object.keys(overrides.providers ?? {}).length) throw error;
      for (const id of new Set([...enabled.map(({ id }) => id), ...Object.values(overrides.providers ?? {})])) {
        if (!unavailable(key + '/' + id, error)) throw error;
      }
    }
    for (const { id } of enabled) ids.set(id, key + '/' + id);
    for (const [service, id] of Object.entries(overrides.providers ?? {})) {
      if (parent.providers.get(service) === id && !enabled.some((item) => item.id === id)) continue;
      isolates.add(service);
      owners.set(service, key + '/' + id);
    }
    for (const { id, provides } of enabled) {
      for (const service of provides ?? []) {
        if (providers.get(service) !== id && parent.providers.has(service)) continue;
        owners.set(service, key + '/' + id);
        isolates.add(service);
      }
    }
    providers = new Map([...providers, ...Object.entries(overrides.providers ?? {})]);
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
