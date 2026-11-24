import { HttpError } from '@mini-harness/contracts/routes';
import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Check } from 'typebox/value';
import type { Settings } from '@mini-harness/contracts/config';
import type { PluginScope, ScopeSettings } from '@mini-harness/contracts/capabilities';
import { resolveCapabilities } from '@mini-harness/kernel/composition';
import { isRegularFile, pluginBundle, pluginIdPattern } from './source.js';
import type { PluginDescriptor, PluginMetadata } from '@mini-harness/contracts/plugins';
import { describePlugin, type DiscoveredPlugin } from './descriptor.js';

function configDefaults(schema: Record<string, any>, value: any): any {
  if (value === undefined && Object.hasOwn(schema, 'default')) value = structuredClone(schema.default);
  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
      if (!property || typeof property !== 'object' || Array.isArray(property)) throw new HttpError('invalid_input', 'Invalid plugin config property');
      const item = configDefaults(property as Record<string, unknown>, Object.hasOwn(value, key) ? value[key] : undefined);
      if (item !== undefined) Object.defineProperty(value, key, { value: item, enumerable: true, writable: true, configurable: true });
    }
  }
  return value;
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

export class PluginCatalog {
  readonly builtins: Map<string, PluginDescriptor>;
  private readonly protectedServices: Set<string>;
  constructor(private readonly directory: string, builtins: PluginDescriptor[], rootServices: string[], private readonly devPlugin?: string) {
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
    if (this.devPlugin) {
      const id = basename(this.devPlugin);
      if (!pluginIdPattern.test(id) || this.builtins.has(id)) throw new Error('Invalid development plugin ID');
      return [describePlugin(id, this.devPlugin)];
    }
    return readdirSync(this.directory, { withFileTypes: true }).flatMap((entry): DiscoveredPlugin[] => {
      const id = entry.name;
      if (!entry.isDirectory() || !pluginIdPattern.test(id) || this.builtins.has(id)) return [];
      try {
        const { folder, package: installedPackage } = pluginBundle(join(this.directory, id));
        if (!installedPackage && !isRegularFile(join(folder, 'plugin.js')) && !isRegularFile(join(folder, 'web.js'))) return [];
        return [{ ...describePlugin(id, folder), package: installedPackage }];
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return [{ scope: 'application', id, title: id, description: 'Plugin manifest cannot be loaded.',
          trustedCode: true, error: message, web: false }];
      }
    });
  }

  descriptors(): DiscoveredPlugin[] { return [...this.builtins.values(), ...this.discover()]; }

  metadata(descriptors = this.descriptors()): PluginMetadata[] {
    return descriptors.filter(({ required }) => !required).map((item) => {
      const { source, resources, inject, setup, optional, browserRequires, browserInject, browserProvides, required, configChanges, validateConfig, ...metadata } = item;
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
        throw new HttpError('invalid_input', 'Protected service cannot be overridden: ' + service);
    const enabled: DiscoveredPlugin[] = [];
    const configs = new Map<string, Record<string, unknown>>();
    for (const [id, active] of Object.entries(overrides?.plugins ?? {})) {
      if (active && !descriptors.some((item) => item.id === id && item.scope === scope)) {
        const error = new HttpError('invalid_input', 'Plugin ' + id + ' is unavailable in ' + scope + ' scope');
        if (!unavailable?.(id, error)) throw error;
      }
    }
    if (isApp) for (const [id, active] of Object.entries(settings.plugins)) {
      if (active && descriptors.some((item) => item.id === id && item.scope !== 'application'))
        throw new HttpError('invalid_input', 'Select a scope for plugin ' + id);
    }
    for (const item of descriptors) {
      const { id, scope: kind } = item;
      if (kind !== scope || !(isApp ? item.required || settings.plugins[id] === true : overrides?.plugins?.[id] === true)) continue;
      try {
        if (item.error) throw new HttpError('invalid_input', 'Invalid plugin ' + id + ': ' + item.error);
        enabled.push(item);
        const values = isApp ? settings.pluginConfig[id] : { ...settings.pluginConfig[id], ...overrides?.pluginConfig?.[id] };
        configs.set(id, this.configValues(id, values, item.configSchema));
      } catch (error) { if (!unavailable?.(id, error)) throw error; }
    }
    const { ordered, providers } = (() => {
      try {
        return resolveCapabilities(enabled.map((item) => ({
          ...item, requires: item.requires?.filter((id) => !parentIds.has(id))
        })), inherited, choices, unavailable, this.protectedServices);
      } catch (error) {
        throw new HttpError('invalid_input', error instanceof Error ? error.message : 'Invalid plugin dependency graph');
      }
    })();
    const plans: PluginPlan[] = [];
    for (const { descriptor, requires, services } of ordered) {
      const { id, browser, browserRequires, source, web } = descriptor;
      const config = configs.get(id);
      if (config) plans.push({ descriptor, id, source, browser, browserRequires, web, requires, services, config });
    }
    return { plans, providers };
  }

  configValues(id: string, values: Record<string, unknown> | undefined, schema?: Record<string, any>) {
    const input = structuredClone(values && typeof values === 'object' ? values : {});
    if (!schema) return input;
    const config = configDefaults(schema, input) as Record<string, unknown>;
    if (!Check(schema, config)) throw new HttpError('invalid_input', 'Invalid configuration for plugin: ' + id);
    return config;
  }

}
