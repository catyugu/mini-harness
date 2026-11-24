import { isDeepStrictEqual } from 'node:util';
import type { PluginMetadata } from '../shared/metadata.js';
import { localPluginIdPattern } from '@mini-harness/plugin-api/selection';
import { DomainError } from '@mini-harness/platform/errors';
import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Check } from 'typebox/value';
import type { PluginSettings } from '@mini-harness/plugin-api/configuration';
import type { PluginScope, ScopeSettings } from '@mini-harness/kernel/scopes';
import { resolveCapabilities } from '@mini-harness/kernel/composition';
import { isRegularFile, pluginBundle } from './source.js';
import type { Context } from 'cordis';
import type { ServiceMap } from '@mini-harness/kernel/services';
import type { ConfigValidationContext, PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { builtinBrowserAssets } from './browser-assets.js';
import { describePlugin, type DiscoveredPlugin } from './descriptor.js';

function configDefaults(schema: Record<string, any>, value: any): any {
  if (value === undefined && Object.hasOwn(schema, 'default')) value = structuredClone(schema.default);
  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
      if (!property || typeof property !== 'object' || Array.isArray(property)) throw new DomainError('invalid_input', 'Invalid plugin config property');
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
}

export class PluginCatalog {
  readonly builtins: Map<string, DiscoveredPlugin>;
  private readonly protectedServices: Set<string>;
  constructor(private readonly directory: string, builtins: PluginDescriptor[], rootServices: string[],
    private readonly devPlugin?: string, private readonly protectedProviders: ReadonlyMap<string, string> = new Map()) {
    this.builtins = new Map(builtins.map((plugin) => [plugin.id, { ...plugin, resources: builtinBrowserAssets(plugin) }]));
    this.protectedServices = new Set([...rootServices, ...protectedProviders.keys()]);
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

  effective<Settings extends PluginSettings>(settings: Settings): Settings {
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
      if (!localPluginIdPattern.test(id) || this.builtins.has(id)) throw new Error('Invalid development plugin ID');
      return [describePlugin(id, this.devPlugin)];
    }
    return readdirSync(this.directory, { withFileTypes: true }).flatMap((entry): DiscoveredPlugin[] => {
      const id = entry.name;
      if (!entry.isDirectory() || !localPluginIdPattern.test(id) || this.builtins.has(id)) return [];
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

  metadata(settings: PluginSettings, failures: ReadonlyMap<string, string>,
    mounted: (id: string) => boolean, context: (scope?: string) => Context): PluginMetadata[] {
    return this.descriptors().filter(({ required }) => !required).map((descriptor) => {
      const { id, source, resources, inject, setup, optional, browserStyles, browserRequires, browserInject,
        browserProvides, required, configChanges, validateConfig, ...metadata } = descriptor;
      const configurationError = (key?: string) => {
        try {
          const values = key ? { ...settings.pluginConfig[id], ...settings.scopes[key]?.pluginConfig?.[id] } : settings.pluginConfig[id];
          const config = this.configValues(id, values, descriptor.configSchema);
          if (descriptor.validateConfig) this.validateConfig(descriptor, config, 'inspect', context(key));
        } catch (error) { return error instanceof Error ? error.message : String(error); }
      };
      const scopes = metadata.scope === 'application'
        ? [{ scope: 'application', enabled: settings.plugins[id] === true }]
        : Object.entries(settings.scopes).flatMap(([scope, value]) => {
          if (!scope.startsWith(metadata.scope + ':')) return [];
          const enabled = value.plugins?.[id] === true || Object.values(value.providers ?? {}).includes(id);
          return enabled || Object.hasOwn(value.pluginConfig ?? {}, id) ? [{ scope, enabled }] : [];
        });
      const instances = scopes.map(({ scope, enabled }): NonNullable<PluginMetadata['instances']>[number] => {
        const key = scope === 'application' ? id : scope + '/' + id;
        const error = failures.get(key) ?? metadata.error ?? configurationError(scope === 'application' ? undefined : scope);
        const state = !enabled ? 'disabled' : error ? 'failed' : mounted(key) ? 'ready' : 'inactive';
        return { scope, error, state };
      });
      const enabled = instances.filter(({ state }) => state !== 'disabled');
      const failed = enabled.find(({ state }) => state === 'failed');
      const ready = enabled.filter(({ state }) => state === 'ready').length;
      const state = ready ? ready === enabled.length ? 'ready' : 'partial' : failed ? 'failed' : enabled.length ? 'inactive' : 'disabled';
      return { ...metadata, id, instances, state,
        error: failed?.error ?? instances.find(({ error }) => error)?.error ?? metadata.error };
    });
  }

  validateConfig(descriptor: PluginDescriptor, config: Record<string, unknown>,
    operation: ConfigValidationContext['operation'], ctx: Context, validator = descriptor.validateConfig) {
    validator?.(Object.freeze(structuredClone(config)), {
      operation,
      service<Name extends keyof ServiceMap & string>(name: Name): NonNullable<ServiceMap[Name]> {
        if (!descriptor.inject?.includes(name) && !descriptor.optional?.includes(name))
          throw new Error('Configuration dependency is not declared by ' + descriptor.id + ': ' + name);
        const service = ctx.get(name) as ServiceMap[Name] | undefined;
        if (service == null) throw new DomainError('unavailable', 'Configuration dependency is unavailable to ' + descriptor.id + ': ' + name);
        return service;
      }
    });
  }

  changedConfig(descriptors: DiscoveredPlugin[], previous: PluginSettings, settings: PluginSettings) {
    const validations: { descriptor: DiscoveredPlugin; config: Record<string, unknown>; key?: string }[] = [];
    for (const descriptor of descriptors) {
      const { id, configSchema, scope } = descriptor;
      const validate = (values: Record<string, unknown> | undefined, before: Record<string, unknown> | undefined, key?: string) => {
        if (isDeepStrictEqual(values, before)) return;
        const config = this.configValues(id, values, configSchema);
        if (descriptor.validateConfig || descriptor.source) validations.push({ descriptor, config, key });
      };
      if (scope === 'application') validate(settings.pluginConfig[id], previous.pluginConfig[id]);
      else {
        validate(settings.pluginConfig[id], previous.pluginConfig[id]);
        for (const key of Object.keys(settings.scopes)) {
          if (!key.startsWith(scope + ':')) continue;
          const changed = settings.scopes[key]?.pluginConfig?.[id];
          const before = previous.scopes[key]?.pluginConfig?.[id];
          const selected = settings.scopes[key];
          if (changed === undefined && !selected.plugins?.[id] && !Object.values(selected.providers ?? {}).includes(id)) continue;
          validate({ ...settings.pluginConfig[id], ...changed }, { ...previous.pluginConfig[id], ...before }, key);
        }
      }
    }
    return validations;
  }

  plans(settings: PluginSettings, descriptors: DiscoveredPlugin[], scope: PluginScope['kind'],
    inherited: ReadonlyMap<string, string>, parentIds: ReadonlySet<string>,
    overrides?: ScopeSettings, unavailable?: (id: string, error: unknown) => boolean) {
    const isApp = scope === 'application';
    const choices = isApp ? settings.providers : overrides?.providers ?? {};
    for (const [service, id] of Object.entries(choices))
      if (this.protectedServices.has(service) && (inherited.get(service) ?? this.protectedProviders.get(service)) !== id)
        throw new DomainError('invalid_input', 'Protected service cannot be overridden: ' + service);
    const enabled: DiscoveredPlugin[] = [];
    const configs = new Map<string, Record<string, unknown>>();
    for (const [id, active] of Object.entries(overrides?.plugins ?? {})) {
      if (active && !descriptors.some((item) => item.id === id && item.scope === scope)) {
        const error = new DomainError('invalid_input', 'Plugin ' + id + ' is unavailable in ' + scope + ' scope');
        if (!unavailable?.(id, error)) throw error;
      }
    }
    if (isApp) for (const [id, active] of Object.entries(settings.plugins)) {
      if (active && descriptors.some((item) => item.id === id && item.scope !== 'application'))
        throw new DomainError('invalid_input', 'Select a scope for plugin ' + id);
    }
    for (const item of descriptors) {
      const { id, scope: kind } = item;
      if (kind !== scope || !(isApp ? item.required || settings.plugins[id] === true : overrides?.plugins?.[id] === true)) continue;
      try {
        if (item.error) throw new DomainError('invalid_input', 'Invalid plugin ' + id + ': ' + item.error);
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
        throw new DomainError('invalid_input', error instanceof Error ? error.message : 'Invalid plugin dependency graph');
      }
    })();
    const plans: PluginPlan[] = [];
    for (const { descriptor, requires, services } of ordered) {
      const { id, source } = descriptor;
      const config = configs.get(id);
      if (config) plans.push({ descriptor, id, source, requires, services, config });
    }
    return { plans, providers };
  }

  configValues(id: string, values: Record<string, unknown> | undefined, schema?: Record<string, any>) {
    const input = structuredClone(values && typeof values === 'object' ? values : {});
    if (!schema) return input;
    const config = configDefaults(schema, input) as Record<string, unknown>;
    if (!Check(schema, config)) throw new DomainError('invalid_input', 'Invalid configuration for plugin: ' + id);
    return config;
  }

}

export function changedSelection(instance: string, previous: PluginSettings, settings: PluginSettings) {
  const separator = instance.indexOf('/');
  if (separator < 0) return settings.plugins[instance] !== previous.plugins[instance] ||
    !isDeepStrictEqual(previous.providers, settings.providers) ||
    !isDeepStrictEqual(previous.browserProviders, settings.browserProviders) ||
    !isDeepStrictEqual(previous.pluginConfig[instance], settings.pluginConfig[instance]);
  const key = instance.slice(0, separator), id = instance.slice(separator + 1);
  const before = previous.scopes[key], after = settings.scopes[key];
  return before?.plugins?.[id] !== after?.plugins?.[id] ||
    !isDeepStrictEqual(before?.providers, after?.providers) ||
    !isDeepStrictEqual(before?.pluginConfig?.[id], after?.pluginConfig?.[id]) ||
    !isDeepStrictEqual(previous.pluginConfig[id], settings.pluginConfig[id]);
}
