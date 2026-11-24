export interface Capability {
  id: string;
  provides?: string[];
  inject?: string[];
  optional?: string[];
  requires?: string[];
}

export class ProtectedProviderError extends Error {
  constructor(service: string) { super('Protected service cannot be overridden: ' + service); }
}

/** Select providers according to application policy. */
export function selectProviders<T extends Capability>(
  descriptors: T[], inherited: ReadonlyMap<string, string>, choices: Readonly<Record<string, string>> = {},
  protectedProviders: ReadonlyMap<string, string> = new Map()
) {
  const byId = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  if (byId.size !== descriptors.length) throw new Error('Duplicate plugin ID in capability graph');
  const providers = new Map(inherited);
  const shadowed = new Set<string>();
  for (const [service, id] of Object.entries(choices)) {
    if (protectedProviders.has(service) && protectedProviders.get(service) !== id)
      throw new ProtectedProviderError(service);
    if (!byId.get(id)?.provides?.includes(service) && inherited.get(service) !== id)
      throw new Error('Selected provider ' + id + ' does not provide ' + service);
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
      if (protectedProviders.has(service) && (protectedProviders.get(service) !== id || inherited.has(service)))
        throw new ProtectedProviderError(service);
      const previous = providers.get(service);
      if (previous && (previous !== id || inherited.has(service))) {
        if (choices[service] !== id) throw new Error('Multiple enabled providers for ' + service);
      }
      providers.set(service, id);
    }
  }

  for (const [service, id] of protectedProviders)
    if (providers.get(service) !== id) throw new ProtectedProviderError(service);

  for (const [service, id] of Object.entries(choices))
    if (providers.get(service) !== id) throw new Error('Selected provider is unavailable: ' + id);

  return { selected: descriptors.filter(({ id }) => !shadowed.has(id)), providers };
}
