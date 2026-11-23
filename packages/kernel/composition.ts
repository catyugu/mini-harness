export interface Capability {
  id: string;
  provides?: string[];
  inject?: string[];
  optional?: string[];
  requires?: string[];
}

export interface ResolvedCapability<T extends Capability> {
  descriptor: T;
  requires: string[];
  services: Record<string, string>;
}

/** Resolve a graph before Cordis starts any user code. Optional services are live lookups. */
export function resolveCapabilities<T extends Capability>(
  descriptors: T[], inherited: ReadonlyMap<string, string>, choices: Readonly<Record<string, string>> = {},
  unavailable?: (id: string, error: unknown) => boolean
) {
  const byId = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  const providers = new Map(inherited);
  const shadowed = new Set<string>();
  for (const [service, id] of Object.entries(choices)) {
    if (!byId.get(id)?.provides?.includes(service)) throw new Error('Selected provider ' + id + ' does not provide ' + service);
  }
  for (const descriptor of descriptors) {
    const services = descriptor.provides ?? [];
    const replaced = services.filter((service) => Object.hasOwn(choices, service) && choices[service] !== descriptor.id);
    if (!replaced.length) continue;
    if (replaced.length !== services.length) throw new Error('Provider ' + descriptor.id + ' must be replaced as a unit');
    shadowed.add(descriptor.id);
  }
  for (const { id, provides = [] } of descriptors) {
    if (shadowed.has(id)) continue;
    for (const service of provides) {
      if (providers.has(service)) throw new Error('Multiple enabled providers for ' + service);
      providers.set(service, id);
    }
  }

  const ordered: ResolvedCapability<T>[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error('Cyclic plugin dependency: ' + id);
    const descriptor = byId.get(id);
    if (!descriptor || shadowed.has(id)) throw new Error('Required plugin is not enabled: ' + id);
    visiting.add(id);
    try {
      const services = Object.fromEntries((descriptor.inject ?? []).map((service) => {
        const provider = providers.get(service);
        if (!provider) throw new Error('No enabled provider for ' + service + ' (' + id + ')');
        return [service, provider];
      }));
      const requires = [...new Set([...(descriptor.requires ?? []), ...Object.values(services).filter((provider) => byId.has(provider))])];
      for (const dependency of requires) visit(dependency);
      visited.add(id);
      ordered.push({ descriptor, requires, services });
    } finally { visiting.delete(id); }
  };
  for (const { id } of descriptors) {
    if (shadowed.has(id)) continue;
    try { visit(id); }
    catch (error) { if (!unavailable?.(id, error)) throw error; }
  }
  return { ordered, providers };
}
