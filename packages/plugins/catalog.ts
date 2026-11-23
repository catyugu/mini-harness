import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Check } from 'typebox/value';
import { readJson } from '../platform/config.js';
import type { Settings } from '../contracts/config.js';
import type { PluginScope, ScopeSettings } from '../contracts/capabilities.js';
import { resolveCapabilities } from '../kernel/composition.js';
import { isRegularFile, pluginBundle, pluginIdPattern } from './source.js';
import type { PluginDescriptor, PluginMetadata } from '../contracts/plugins.js';

function configDefaults(schema: Record<string, any>, value: any): any {
  if (value === undefined && Object.hasOwn(schema, 'default')) value = structuredClone(schema.default);
  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
      const item = configDefaults(property, Object.hasOwn(value, key) ? value[key] : undefined);
      if (item !== undefined) Object.defineProperty(value, key, { value: item, enumerable: true, writable: true, configurable: true });
    }
  }
  return value;
}

interface DiscoveredPlugin extends PluginDescriptor {
  source?: string;
}

export interface PluginPlan {
  descriptor: DiscoveredPlugin;
  id: string;
  services: Record<string, string>;
  source?: string;
  config?: Record<string, unknown>;
  requires: string[];
  browser?: string;
  browserRequires?: string[];
  web?: boolean;
}

export function describePlugin(id: string, folder: string): DiscoveredPlugin {
  const source = join(folder, 'plugin.js');
  const hasHost = isRegularFile(source);
  const hasWeb = isRegularFile(join(folder, 'web.js'));
  if (!hasHost && !hasWeb) throw new Error('Provide plugin.js, web.js or both');
  if (hasWeb && lstatSync(join(folder, 'web.js')).size > 1024 * 1024) throw new Error('Plugin browser entry exceeds 1 MiB');
  const descriptor = join(folder, 'plugin.json');
  const manifest = isRegularFile(descriptor) ? readJson<Partial<PluginDescriptor> | null>(descriptor, null) : null;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    throw new Error('Expected an object in plugin.json');
  const title = typeof manifest.title === 'string' ? manifest.title.slice(0, 100) : id;
  const description = typeof manifest.description === 'string' ? manifest.description.slice(0, 300) : 'Runs local JavaScript with your user permissions.';
  const scope = manifest.scope ?? 'application';
  if (scope !== 'application' && scope !== 'workspace' && scope !== 'session') throw new Error('Invalid plugin scope');
  const names = (field: 'requires' | 'inject' | 'optional' | 'provides' | 'browserRequires' | 'browserInject' | 'browserProvides', pattern: RegExp) => {
    const input = manifest[field] ?? [];
    if (!Array.isArray(input) || input.some((name) => typeof name !== 'string' || !pattern.test(name)) ||
        new Set(input).size !== input.length) throw new Error('Invalid plugin ' + field + ': ' + id);
    return input;
  };
  const pluginId = /^(?:core:)?[a-z][a-z0-9-]{0,63}$/;
  const serviceName = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,95}$/;
  const requires = names('requires', pluginId);
  const provides = names('provides', serviceName);
  const inject = names('inject', serviceName);
  const optional = names('optional', serviceName);
  const browserRequires = names('browserRequires', pluginId);
  const browserInject = names('browserInject', serviceName);
  const browserProvides = names('browserProvides', serviceName);
  if (!hasWeb && (browserRequires.length || browserInject.length || browserProvides.length))
    throw new Error('Browser dependencies require web.js');
  if (!hasHost && (provides.length || inject.length || optional.length)) throw new Error('Server services require plugin.js');
  if (scope !== 'application' && (hasWeb || inject.includes('harnessRoutes'))) throw new Error('Scoped plugins require a server entry without routes');
  if (inject.some((service) => optional.includes(service) || provides.includes(service))) throw new Error('Conflicting service declarations');
  const configSchema = manifest.configSchema;
  if (configSchema && (configSchema.type !== 'object' || !configSchema.properties || typeof configSchema.properties !== 'object'))
    throw new Error('Expected an object configSchema for plugin: ' + id);
  const icon = manifest.icon;
  if (icon !== undefined && !(
    typeof icon === 'string' && icon.length > 0 && icon.length <= 128 ||
    icon !== null && typeof icon === 'object' && !Array.isArray(icon) &&
    typeof icon.path === 'string' && icon.path.length > 0 && icon.path.length <= 8192 &&
    (icon.viewBox === undefined || typeof icon.viewBox === 'string' && icon.viewBox.length <= 100)
  )) throw new Error('Invalid plugin icon: ' + id);
  return { source: hasHost ? source : undefined, scope, id, title, description,
    requires, provides, inject, optional, browserRequires, browserInject, browserProvides, configSchema, icon, web: hasWeb, trustedCode: true };
}

export class PluginCatalog {
  readonly builtins: Map<string, PluginDescriptor>;
  private readonly protectedServices: Set<string>;
  constructor(private readonly directory: string, builtins: PluginDescriptor[], rootServices: string[]) {
    this.builtins = new Map(builtins.map((plugin) => [plugin.id, plugin]));
    this.protectedServices = new Set(rootServices);
    if (this.builtins.size !== builtins.length) throw new Error('Duplicate builtin plugin ID');
    const services = new Set(builtins.flatMap(({ provides }) => provides ?? []));
    for (const service of rootServices) if (services.has(service)) throw new Error('Duplicate provider for ' + service);
    for (const { id, inject = [], browserRequires = [] } of builtins) {
      for (const service of inject) if (!rootServices.includes(service) && !services.has(service))
        throw new Error('Missing provider for ' + service + ' (' + id + ')');
      for (const dependency of browserRequires) if (!this.builtins.get(dependency)?.browser)
        throw new Error('Missing browser dependency: ' + dependency);
    }
  }

  effective(settings: Settings): Settings {
    const plugins = { ...settings.plugins };
    const pluginConfig = { ...settings.pluginConfig };
    for (const { id, required, configSchema, defaultEnabled } of this.builtins.values()) {
      if (!required) plugins[id] ??= defaultEnabled ?? false;
      if (configSchema) pluginConfig[id] = configDefaults(configSchema, structuredClone(pluginConfig[id] ?? {}));
    }
    return { ...settings, plugins, pluginConfig };
  }

  reserved(id: string) { return this.builtins.has(id); }

  private discover(): DiscoveredPlugin[] {
    return readdirSync(this.directory, { withFileTypes: true }).flatMap((entry): DiscoveredPlugin[] => {
      const id = entry.name;
      if (!entry.isDirectory() || !pluginIdPattern.test(id) || this.builtins.has(id)) return [];
      try {
        const { folder, npm } = pluginBundle(join(this.directory, id));
        if (!npm && !isRegularFile(join(folder, 'plugin.js')) && !isRegularFile(join(folder, 'web.js'))) return [];
        return [{ ...describePlugin(id, folder), npm }];
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return [{ scope: 'application', id, title: id, description: 'Plugin manifest cannot be loaded.',
          trustedCode: true, error: message, web: false }];
      }
    });
  }

  descriptors(): DiscoveredPlugin[] { return [...this.builtins.values(), ...this.discover()]; }

  metadata(): PluginMetadata[] {
    return this.descriptors().filter(({ required }) => !required).map((item) => {
      const { source, inject, setup, provides, optional, browserRequires, browserInject, browserProvides, required, configChanges, ...metadata } = item;
      return metadata;
    });
  }

  plans(settings: Settings, descriptors: DiscoveredPlugin[], scope: PluginScope['kind'],
    inherited: ReadonlyMap<string, string>, parentIds: ReadonlySet<string>,
    overrides?: ScopeSettings, unavailable?: (id: string, error: unknown) => boolean) {
    const isApp = scope === 'application';
    const choices = isApp ? settings.providers : overrides?.providers ?? {};
    for (const [service, id] of Object.entries(choices))
      if (inherited.has(service) && inherited.get(service) !== id && this.protectedServices.has(service))
        throw new Error('Protected service cannot be overridden: ' + service);
    const enabled: DiscoveredPlugin[] = [];
    for (const [id, active] of Object.entries(overrides?.plugins ?? {})) {
      if (active && !descriptors.some((item) => item.id === id && item.scope === scope))
        throw new Error('Plugin ' + id + ' is unavailable in ' + scope + ' scope');
    }
    if (isApp) for (const [id, active] of Object.entries(settings.plugins)) {
      if (active && descriptors.some((item) => item.id === id && item.scope !== 'application'))
        throw new Error('Select a scope for plugin ' + id);
    }
    for (const item of descriptors) {
      const { id, scope: kind } = item;
      if (kind !== scope || !(isApp ? item.required || settings.plugins[id] === true : overrides?.plugins?.[id] === true)) continue;
      try {
        if (item.error) throw new Error('Invalid plugin ' + id + ': ' + item.error);
        enabled.push(item);
      } catch (error) { if (!unavailable?.(id, error)) throw error; }
    }
    const { ordered, providers } = resolveCapabilities(enabled.map((item) => ({
      ...item, requires: item.requires?.filter((id) => !parentIds.has(id))
    })), inherited, choices, unavailable, this.protectedServices);
    const plans: PluginPlan[] = [];
    for (const { descriptor, requires, services } of ordered) {
      const { id, browser, browserRequires, source, web, configSchema } = descriptor;
      try {
        const config = this.configValues(id, isApp ? settings.pluginConfig[id] : { ...settings.pluginConfig[id], ...overrides?.pluginConfig?.[id] }, configSchema);
        plans.push({ descriptor, id, source, browser, browserRequires, web, requires, services, config });
      } catch (error) { if (!unavailable?.(id, error)) throw error; }
    }
    return { plans, providers };
  }

  private configValues(id: string, values: Record<string, unknown> | undefined, schema?: Record<string, any>) {
    const input = structuredClone(values && typeof values === 'object' ? values : {});
    if (!schema) return input;
    const config = configDefaults(schema, input) as Record<string, unknown>;
    if (!Check(schema, config)) throw new Error('Invalid configuration for plugin: ' + id);
    return config;
  }

}
