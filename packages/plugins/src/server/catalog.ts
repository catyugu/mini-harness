import { isDeepStrictEqual } from 'node:util';
import type { PluginMetadata } from '../shared/metadata.js';
import { localPluginIdPattern } from '@mini-harness/plugin-api/selection';
import { DomainError } from '@mini-harness/platform/errors';
import { lstatSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { basename, join } from 'node:path';
import { Check } from 'typebox/value';
import { scopeKeys, type PluginSettings } from '@mini-harness/plugin-api/configuration';
import type { PluginScope, ScopeKey, ScopeSettings } from '@mini-harness/plugin-api/scopes';
import { ProtectedProviderError, selectProviders } from './providers.js';
import { pluginBundle } from './source.js';
import { Inject, type Context, type Plugin } from 'mini-harness/cordis';
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

export interface ConfiguredPlugin {
  descriptor: DiscoveredPlugin;
  id: string;
  source?: string;
  config?: Record<string, unknown>;
}

export class PluginCatalog {
  private readonly builtins: Map<string, DiscoveredPlugin>;
  readonly lockedPlugins: ReadonlySet<string>;
  readonly requiredClientCapabilities: ReadonlySet<string>;
  private readonly protectedProviders: ReadonlyMap<string, string>;
  constructor(private readonly directory: string, builtins: PluginDescriptor[], rootServices: string[],
    private readonly devPlugin?: string, private readonly profile?: Pick<import('@mini-harness/plugin-api/profile').ProfileRuntime, 'installed' | 'client'>) {
    this.builtins = new Map(builtins.map((descriptor) => {
      const { plugin } = descriptor;
      return [descriptor.id, { ...descriptor,
        inject: plugin ? Object.keys(Inject.resolve(plugin.inject)) : descriptor.inject,
        provides: typeof plugin?.provide === 'string' ? [plugin.provide] : plugin?.provide ?? descriptor.provides,
        resources: builtinBrowserAssets(descriptor) }];
    }));
    this.requiredClientCapabilities = new Set(builtins.filter(row => row.required).flatMap(row => row.browserProvides ?? []));
    this.protectedProviders = new Map([...rootServices.map((name) => [name, 'application'] as const), ...builtins.flatMap(row => row.protectServices?.map(name => [name, row.id] as const) ?? [])]);
    this.lockedPlugins = new Set(this.protectedProviders.values());
    if (this.builtins.size !== builtins.length) throw new Error('Duplicate builtin plugin ID');
    const services = new Set([...this.builtins.values()].flatMap(({ provides }) => provides ?? []));
    for (const service of rootServices) if (services.has(service)) throw new Error('Duplicate provider for ' + service);
    for (const { id, inject = [], browserRequires = [] } of this.builtins.values()) {
      for (const service of inject) if (!rootServices.includes(service) && !services.has(service))
        throw new Error('Missing provider for ' + service + ' (' + id + ')');
      for (const dependency of browserRequires) if (!this.builtins.get(dependency)?.browser)
        throw new Error('Missing browser dependency: ' + dependency);
    }
  }

  effective<Settings extends PluginSettings>(settings: Settings): Settings {
    const plugins = { ...settings.plugins };
    const pluginConfig = { ...settings.pluginConfig };
    for (const { id, scope, configSchema, defaultEnabled, required } of this.builtins.values()) {
      if (scope === 'application' && !required) plugins[id] ??= defaultEnabled ?? false;
      if (configSchema) pluginConfig[id] = configDefaults(configSchema, structuredClone(pluginConfig[id] ?? {}));
    }
    return { ...settings, plugins, pluginConfig };
  }

  enabled(descriptor: PluginDescriptor, settings: PluginSettings) {
    if (descriptor.required && settings.plugins[descriptor.id] === false)
      throw new DomainError('invalid_input', 'Required Profile entry cannot be disabled: ' + descriptor.id);
    return descriptor.required || (settings.plugins[descriptor.id] ?? descriptor.defaultEnabled) === true;
  }

  reserved(id: string) { return this.builtins.has(id); }

  private discover(): DiscoveredPlugin[] {
    if (this.devPlugin) {
      const id = basename(this.devPlugin);
      if (!localPluginIdPattern.test(id) || this.builtins.has(id)) throw new Error('Invalid development plugin ID');
      return [this.describe(id, this.devPlugin)];
    }
    const directories = new Map(readdirSync(this.directory, { withFileTypes: true }).flatMap(entry =>
      entry.isDirectory() && localPluginIdPattern.test(entry.name) ? [[entry.name, entry.name]] : []));
    for (const [id, module] of this.profile?.installed ?? []) directories.set(id, module);
    return [...directories].flatMap(([id, module]) => this.builtins.has(id) ? [] : [this.describe(id, join(this.directory, module))]);
  }

  private describe(id: string, directory: string): DiscoveredPlugin {
    try {
      const { folder, package: installedPackage } = pluginBundle(directory);
      const descriptor = describePlugin(id, folder);
      if (this.profile && !this.profile.client(id)) {
        delete descriptor.resources;
        delete descriptor.browserProvides;
        delete descriptor.browserRequires;
      }
      return { ...descriptor, package: installedPackage };
    } catch (error) {
      return { scope: 'application', id, title: id, description: 'Plugin manifest cannot be loaded.',
        trustedCode: true, error: error instanceof Error ? error.message : String(error), web: false };
    }
  }

  descriptors(): DiscoveredPlugin[] { return [...this.builtins.values(), ...this.discover()]; }

  async runtimeDescriptors(settings: PluginSettings): Promise<DiscoveredPlugin[]> {
    return Promise.all(this.descriptors().map(async descriptor => {
      const { id, source, scope } = descriptor;
      if (!source || descriptor.error) return descriptor;
      const enabled = scope === 'application' ? this.enabled(descriptor, settings) :
        scopeKeys(settings).some(key => key.startsWith(scope + ':') && settings.scopes[key]?.plugins?.[id]);
      if (!enabled) return descriptor;
      try {
        const module = pathToFileURL(source).href + '?v=' + lstatSync(source).mtimeMs;
        const exports = await import(module);
        const plugin: Plugin = exports.default ?? exports;
        if (typeof plugin !== 'function' && typeof plugin?.apply !== 'function')
          throw new Error('Plugin ' + id + ' must export a Cordis plugin with apply(ctx, config)');
        const inject = Object.keys(Inject.resolve(plugin.inject));
        const provides = typeof plugin.provide === 'string' ? [plugin.provide] : plugin.provide ?? [];
        if (descriptor.inject && !isDeepStrictEqual([...inject].sort(), [...descriptor.inject].sort()))
          throw new Error('Injected service declarations disagree with the manifest for ' + id);
        if (descriptor.provides && !isDeepStrictEqual([...provides].sort(), [...descriptor.provides].sort()))
          throw new Error('Provided service declarations disagree with the manifest for ' + id);
        if (descriptor.optional?.some(name => inject.includes(name) || provides.includes(name)))
          throw new Error('Conflicting service declarations for ' + id);
        if (scope !== 'application' && inject.some(name => name === 'harnessRoutes' || name === 'harnessNetwork'))
          throw new Error('Scoped plugins cannot register application routes');
        const validateConfig = exports.validateConfig;
        if (validateConfig !== undefined && (typeof validateConfig !== 'function' || !descriptor.configSchema))
          throw new Error('Export a validateConfig function with a configSchema in plugin.json');
        return { ...descriptor, plugin, module, inject, provides, validateConfig };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ...descriptor, error: message };
      }
    }));
  }

  metadata(settings: PluginSettings, failures: ReadonlyMap<string, string>,
    mounted: (id: string) => boolean, context: (scope?: ScopeKey) => Context): PluginMetadata[] {
    return this.descriptors().filter(({ id, required }) => !required && !this.lockedPlugins.has(id) && localPluginIdPattern.test(id)).map((descriptor) => {
      const { id, source, resources, inject, plugin: _plugin, optional, browserStyles, browserRequires,
        browserProvides, configChanges, validateConfig, ...metadata } = descriptor;
      const configurationError = (key?: ScopeKey) => {
        try {
          const values = key ? { ...settings.pluginConfig[id], ...settings.scopes[key]?.pluginConfig?.[id] } : settings.pluginConfig[id];
          const config = this.configValues(id, values, descriptor.configSchema);
          this.validateConfig(descriptor, config, 'inspect', context(key), descriptor.validateConfig, key ? key + '/' + id : id);
        } catch (error) { return error instanceof Error ? error.message : String(error); }
      };
      const scopes: { scope: 'application' | ScopeKey; enabled: boolean }[] = metadata.scope === 'application'
        ? [{ scope: 'application', enabled: this.enabled(descriptor, settings) }]
        : scopeKeys(settings).flatMap((scope) => {
          const value = settings.scopes[scope];
          if (!value || !scope.startsWith(metadata.scope + ':')) return [];
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
    operation: ConfigValidationContext['operation'], ctx: Context, validator = descriptor.validateConfig, instance = descriptor.id) {
    if (!validator) return;
    try {
      const result: unknown = validator(Object.freeze(structuredClone(config)), {
        operation,
        service<Name extends keyof Context & string>(name: Name): NonNullable<Context[Name]> {
          if (!descriptor.inject?.includes(name) && !descriptor.optional?.includes(name))
            throw new Error('Configuration dependency is not declared: ' + name);
          const service = ctx.get(name) as Context[Name] | undefined;
          if (service == null) throw new DomainError('unavailable', 'Configuration dependency is unavailable: ' + name);
          return service;
        }
      });
      if (result instanceof Promise) {
        void result.catch(() => {});
        throw new Error('Plugin configuration validators must be synchronous');
      }
    } catch (error) {
      throw new DomainError(error instanceof DomainError ? error.code : 'invalid_input',
        'Plugin ' + instance + ' configuration ' + operation + ' failed: ' +
        (error instanceof Error ? error.message : String(error)), { cause: error });
    }
  }

  changedConfig(descriptors: DiscoveredPlugin[], previous: PluginSettings, settings: PluginSettings) {
    const validations: { descriptor: DiscoveredPlugin; config: Record<string, unknown>; key?: ScopeKey }[] = [];
    for (const descriptor of descriptors) {
      const { id, configSchema, scope } = descriptor;
      const validate = (values: Record<string, unknown> | undefined, before: Record<string, unknown> | undefined, key?: ScopeKey) => {
        if (isDeepStrictEqual(values, before)) return;
        const config = this.configValues(id, values, configSchema);
        if (descriptor.validateConfig || descriptor.source) validations.push({ descriptor, config, key });
      };
      if (scope === 'application') validate(settings.pluginConfig[id], previous.pluginConfig[id]);
      else {
        validate(settings.pluginConfig[id], previous.pluginConfig[id]);
        for (const key of scopeKeys(settings)) {
          if (!key.startsWith(scope + ':')) continue;
          const changed = settings.scopes[key]?.pluginConfig?.[id];
          const before = previous.scopes[key]?.pluginConfig?.[id];
          const selected = settings.scopes[key];
          if (changed === undefined && !selected?.plugins?.[id] && !Object.values(selected?.providers ?? {}).includes(id)) continue;
          validate({ ...settings.pluginConfig[id], ...changed }, { ...previous.pluginConfig[id], ...before }, key);
        }
      }
    }
    return validations;
  }

  plans(settings: PluginSettings, descriptors: DiscoveredPlugin[], scope: PluginScope['kind'],
    inherited: ReadonlyMap<string, string>,
    overrides?: ScopeSettings, unavailable?: (id: string, error: unknown) => boolean) {
    const isApp = scope === 'application';
    const choices = isApp ? settings.providers : overrides?.providers ?? {};
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
      if (kind !== scope || !(isApp ? this.enabled(item, settings) : overrides?.plugins?.[id] === true)) continue;
      try {
        if (item.error) throw new DomainError('invalid_input', 'Invalid plugin ' + id + ': ' + item.error);
        enabled.push(item);
        const values = isApp ? settings.pluginConfig[id] : { ...settings.pluginConfig[id], ...overrides?.pluginConfig?.[id] };
        configs.set(id, this.configValues(id, values, item.configSchema));
      } catch (error) { if (!unavailable?.(id, error)) throw error; }
    }
    const { selected, providers } = (() => {
      try {
        return selectProviders(enabled, inherited, choices, this.protectedProviders);
      } catch (error) {
        if (error instanceof ProtectedProviderError && !isApp) throw error;
        throw new DomainError('invalid_input', error instanceof Error ? error.message : 'Invalid provider selection');
      }
    })();
    const plans: ConfiguredPlugin[] = [];
    for (const descriptor of selected) {
      const { id, source } = descriptor;
      const config = configs.get(id);
      if (config) plans.push({ descriptor, id, source, config });
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

export function changedSelection(id: string, previous: PluginSettings, settings: PluginSettings, key?: ScopeKey) {
  if (!key) return settings.plugins[id] !== previous.plugins[id] ||
    !isDeepStrictEqual(previous.providers, settings.providers) ||
    !isDeepStrictEqual(previous.browserProviders, settings.browserProviders) ||
    !isDeepStrictEqual(previous.pluginConfig[id], settings.pluginConfig[id]);
  const before = previous.scopes[key], after = settings.scopes[key];
  return before?.plugins?.[id] !== after?.plugins?.[id] ||
    !isDeepStrictEqual(before?.providers, after?.providers) ||
    !isDeepStrictEqual(before?.pluginConfig?.[id], after?.pluginConfig?.[id]) ||
    !isDeepStrictEqual(previous.pluginConfig[id], settings.pluginConfig[id]);
}
