import { isDeepStrictEqual } from 'node:util';
import type { PluginMetadata } from '../shared/metadata.ts';
import { localPluginIdPattern } from '@mini-harness/plugin-api/selection';
import { DomainError } from '@mini-harness/platform/errors';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { Check } from 'typebox/value';
import { scopeKeys, type CompositionConfig } from '@mini-harness/plugin-api/configuration';
import type { PluginScope, ScopeKey, ScopeSettings } from '@mini-harness/plugin-api/scopes';
import type { Context, EntryOptions, Plugin } from 'mini-harness/cordis';
import type { ConfigValidationContext, ResolvedPlugin } from '@mini-harness/plugin-api/descriptor';
import { builtinBrowserAssets } from './browser-assets.ts';
import { describePlugin, type DiscoveredPlugin } from './descriptor.ts';
import { resolveModule } from './module-resolution.ts';
import { bindInstance } from '@mini-harness/plugin-api/instance';

function configDefaults(schema: Record<string, any>, value: any): any {
  if (value === undefined && Object.hasOwn(schema, 'default')) value = structuredClone(schema.default);
  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
      if (!property || typeof property !== 'object' || Array.isArray(property))
        throw new DomainError('invalid_input', 'Invalid plugin config property');
      const item = configDefaults(
        property as Record<string, unknown>,
        Object.hasOwn(value, key) ? value[key] : undefined,
      );
      if (item !== undefined)
        Object.defineProperty(value, key, {
          value: item,
          enumerable: true,
          writable: true,
          configurable: true,
        });
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
  constructor(
    private readonly directory: string,
    builtins: ResolvedPlugin[],
    private readonly profile?: Pick<
      import('@mini-harness/plugin-api/profile').ProfileRuntime,
      'installed' | 'modules' | 'client'
    >,
  ) {
    this.builtins = new Map(
      builtins.map((descriptor) => [
        descriptor.id,
        { ...descriptor, resources: builtinBrowserAssets(descriptor) },
      ]),
    );
    if (this.builtins.size !== builtins.length) throw new Error('Duplicate builtin plugin ID');
  }

  effective<Settings extends CompositionConfig>(settings: Settings): Settings {
    const entries = { ...settings.entries };
    for (const { id, scope, configSchema, defaultEnabled } of this.builtins.values()) {
      const entry = { ...entries[id] };
      if (scope === 'application') entry.disabled ??= !defaultEnabled;
      if (configSchema)
        entry.config = configDefaults(configSchema, structuredClone(entry.config ?? {}));
      entries[id] = entry;
    }
    return { ...settings, entries };
  }

  enabled(descriptor: ResolvedPlugin, settings: CompositionConfig) {
    const disabled = settings.entries[descriptor.id]?.disabled;
    return disabled === undefined ? descriptor.defaultEnabled === true : !disabled;
  }

  reserved(id: string) {
    return this.builtins.has(id) || Boolean(this.profile?.modules.has(id));
  }

  private discover(): DiscoveredPlugin[] {
    const directories = new Map(
      readdirSync(this.directory, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() && localPluginIdPattern.test(entry.name) ? [[entry.name, entry.name]] : [],
      ),
    );
    for (const [id, module] of this.profile?.installed ?? []) directories.set(id, module);
    return [...directories].flatMap(([id, module]) =>
      this.reserved(id) ? [] : [this.describe(id, resolve(this.directory, module))],
    );
  }

  private describe(id: string, directory: string): DiscoveredPlugin {
    try {
      const descriptor = describePlugin(id, directory);
      if (this.profile && !this.profile.client(id)) {
        delete descriptor.resources;
      }
      return descriptor;
    } catch (error) {
      return {
        scope: 'application',
        id,
        title: id,
        description: 'Plugin manifest cannot be loaded.',
        trustedCode: true,
        error: error instanceof Error ? error.message : String(error),
        web: false,
      };
    }
  }

  private describeModule(id: string, name: string, source: string): DiscoveredPlugin {
    try {
      const entry = fileURLToPath(resolveModule(name, source));
      let directory = dirname(entry);
      while (!existsSync(join(directory, 'package.json')) && dirname(directory) !== directory)
        directory = dirname(directory);
      const descriptor = describePlugin(id, directory, entry);
      if (!this.profile?.client(id)) delete descriptor.resources;
      return descriptor;
    } catch (error) {
      return {
        id,
        scope: 'application',
        title: id,
        description: name,
        trustedCode: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  descriptors(): DiscoveredPlugin[] {
    return [
      ...this.builtins.values(),
      ...[...this.profile?.modules ?? []].map(([id, { name, source }]) => this.describeModule(id, name, source)),
      ...this.discover(),
    ];
  }

  async runtimeDescriptors(settings: CompositionConfig): Promise<DiscoveredPlugin[]> {
    return Promise.all(
      this.descriptors().map(async (descriptor) => {
        const { id, source, scope } = descriptor;
        if (!source || descriptor.error) return descriptor;
        const enabled =
          scope === 'application'
            ? this.enabled(descriptor, settings)
            : scopeKeys(settings).some(
                (key) => key.startsWith(scope + ':') && settings.scopes[key]?.entries?.[id]?.disabled === false,
              );
        if (!enabled) return descriptor;
        try {
          const module = pathToFileURL(source).href + '?v=' + lstatSync(source).mtimeMs;
          const exports = await import(module);
          const plugin: Plugin = exports.default ?? exports;
          if (typeof plugin !== 'function' && typeof plugin?.apply !== 'function')
            throw new Error('Plugin ' + id + ' must export a Cordis plugin with apply(ctx, config)');
          const validateConfig = exports.validateConfig;
          if (
            validateConfig !== undefined &&
            (typeof validateConfig !== 'function' || !descriptor.configSchema)
          )
            throw new Error('Export a validateConfig function with a configSchema in plugin.json');
          return { ...descriptor, plugin, module, validateConfig };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { ...descriptor, error: message };
        }
      }),
    );
  }

  metadata(
    settings: CompositionConfig,
    failures: ReadonlyMap<string, string>,
    mounted: (id: string) => boolean,
    context: (scope?: ScopeKey) => Context,
  ): PluginMetadata[] {
    return this.descriptors()
      .filter(({ id }) => localPluginIdPattern.test(id))
      .map((descriptor) => {
        const {
          id,
          source,
          resources,
          plugin: _plugin,
          browserStyles,
          configChanges,
          validateConfig,
          ...metadata
        } = descriptor;
        const configurationError = (key?: ScopeKey) => {
          try {
            const values = key
              ? { ...settings.entries[id]?.config, ...settings.scopes[key]?.entries?.[id]?.config }
              : settings.entries[id]?.config;
            const config = this.configValues(id, values, descriptor.configSchema);
            this.validateConfig(
              descriptor,
              config,
              'inspect',
              context(key),
              descriptor.validateConfig,
              key ? key + '/' + id : id,
            );
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        };
        const scopes: { scope: 'application' | ScopeKey; enabled: boolean }[] =
          metadata.scope === 'application'
            ? [{ scope: 'application', enabled: this.enabled(descriptor, settings) }]
            : scopeKeys(settings).flatMap((scope) => {
                const value = settings.scopes[scope];
                if (!value || !scope.startsWith(metadata.scope + ':')) return [];
                const enabled = value.entries?.[id]?.disabled === false;
                return enabled || Object.hasOwn(value.entries ?? {}, id) ? [{ scope, enabled }] : [];
              });
        const instances = scopes.map(
          ({ scope, enabled }): NonNullable<PluginMetadata['instances']>[number] => {
            const key = scope === 'application' ? id : scope + '/' + id;
            const error =
              failures.get(key) ??
              metadata.error ??
              configurationError(scope === 'application' ? undefined : scope);
            const state = !enabled ? 'disabled' : error ? 'failed' : mounted(key) ? 'ready' : 'inactive';
            return { scope, error, state };
          },
        );
        const enabled = instances.filter(({ state }) => state !== 'disabled');
        const failed = enabled.find(({ state }) => state === 'failed');
        const ready = enabled.filter(({ state }) => state === 'ready').length;
        const state = ready
          ? ready === enabled.length
            ? 'ready'
            : 'partial'
          : failed
            ? 'failed'
            : enabled.length
              ? 'inactive'
              : 'disabled';
        return {
          ...metadata,
          id,
          instances,
          state,
          error: failed?.error ?? instances.find(({ error }) => error)?.error ?? metadata.error,
        };
      });
  }

  entry(plan: ConfiguredPlugin, context: Context, scope: PluginScope, id = plan.id, scopeKey?: ScopeKey): EntryOptions {
    const { source, descriptor } = plan;
    const plugin = descriptor.plugin;
    if (!plugin) throw new Error('Missing server module: ' + plan.id);
    return {
      id,
      context,
      config: plan.config ?? {},
      module: descriptor.module ?? plan.id,
      live: descriptor.configChanges === 'live',
      load: () => plugin,
      prepare: (ctx) => {
        bindInstance(ctx.fiber.entry!, {
          pluginId: plan.id,
          scope,
          scopeKey,
          writableConfig: descriptor.configChanges === 'live' && descriptor.configSchema !== undefined,
          trusted: !source && descriptor.trustedContributor === true,
        });
        const changes = context.get('harnessChanges');
        if (changes) ctx.effect(() => changes.register('plugin:' + plan.id));
        this.validateConfig(descriptor, ctx.fiber.config, 'mount', ctx, descriptor.validateConfig, id);
      },
    };
  }

  validateConfig(
    descriptor: ResolvedPlugin,
    config: Record<string, unknown>,
    operation: ConfigValidationContext['operation'],
    ctx: Context,
    validator = descriptor.validateConfig,
    instance = descriptor.id,
  ) {
    if (!validator) return;
    try {
      const result: unknown = validator(Object.freeze(structuredClone(config)), {
        operation,
        service<Name extends keyof Context & string>(name: Name): NonNullable<Context[Name]> {
          const service = ctx.get(name) as Context[Name] | undefined;
          if (service == null)
            throw new DomainError('unavailable', 'Configuration dependency is unavailable: ' + name);
          return service;
        },
      });
      if (result instanceof Promise) {
        void result.catch(() => {});
        throw new Error('Plugin configuration validators must be synchronous');
      }
    } catch (error) {
      throw new DomainError(
        error instanceof DomainError ? error.code : 'invalid_input',
        'Plugin ' +
          instance +
          ' configuration ' +
          operation +
          ' failed: ' +
          (error instanceof Error ? error.message : String(error)),
        { cause: error },
      );
    }
  }

  changedConfig(descriptors: DiscoveredPlugin[], previous: CompositionConfig, settings: CompositionConfig) {
    const validations: { descriptor: DiscoveredPlugin; config: Record<string, unknown>; key?: ScopeKey }[] =
      [];
    for (const descriptor of descriptors) {
      const { id, configSchema, scope } = descriptor;
      const validate = (
        values: Record<string, unknown> | undefined,
        before: Record<string, unknown> | undefined,
        key?: ScopeKey,
      ) => {
        if (isDeepStrictEqual(values, before)) return;
        const config = this.configValues(id, values, configSchema);
        if (descriptor.validateConfig || descriptor.source) validations.push({ descriptor, config, key });
      };
      if (scope === 'application') validate(settings.entries[id]?.config, previous.entries[id]?.config);
      else {
        validate(settings.entries[id]?.config, previous.entries[id]?.config);
        for (const key of scopeKeys(settings)) {
          if (!key.startsWith(scope + ':')) continue;
          const changed = settings.scopes[key]?.entries?.[id]?.config;
          const before = previous.scopes[key]?.entries?.[id]?.config;
          const selected = settings.scopes[key];
          if (changed === undefined && selected?.entries?.[id]?.disabled !== false) continue;
          validate(
            { ...settings.entries[id]?.config, ...changed },
            { ...previous.entries[id]?.config, ...before },
            key,
          );
        }
      }
    }
    return validations;
  }

  plans(
    settings: CompositionConfig,
    descriptors: DiscoveredPlugin[],
    scope: PluginScope['kind'],
    overrides?: ScopeSettings,
    unavailable?: (id: string, error: unknown) => boolean,
  ) {
    const isApp = scope === 'application';
    const plans: ConfiguredPlugin[] = [];
    const declared = new Set<string>();
    for (const [id, entry] of Object.entries(overrides?.entries ?? {})) {
      if (entry.disabled === false && !descriptors.some((item) => item.id === id && item.scope === scope)) {
        const error = new DomainError(
          'invalid_input',
          'Plugin ' + id + ' is unavailable in ' + scope + ' scope',
        );
        if (!unavailable?.(id, error)) throw error;
      }
    }
    if (isApp)
      for (const [id, entry] of Object.entries(settings.entries)) {
        if (entry.disabled === false && descriptors.some((item) => item.id === id && item.scope !== 'application'))
          throw new DomainError('invalid_input', 'Select a scope for plugin ' + id);
      }
    for (const item of descriptors) {
      const { id, scope: kind } = item;
      if (kind !== scope || !(isApp ? this.enabled(item, settings) : overrides?.entries?.[id]?.disabled === false))
        continue;
      // Child groups isolate the services declared by their Cordis modules.
      const provide = item.plugin?.provide;
      for (const service of typeof provide === 'string' ? [provide] : (provide ?? [])) declared.add(service);
      try {
        if (item.error) throw new DomainError('invalid_input', 'Invalid plugin ' + id + ': ' + item.error);
        const values = isApp
          ? settings.entries[id]?.config
          : { ...settings.entries[id]?.config, ...overrides?.entries?.[id]?.config };
        plans.push({ descriptor: item, id, source: item.source, config: this.configValues(id, values, item.configSchema) });
      } catch (error) {
        if (!unavailable?.(id, error)) throw error;
      }
    }
    return { plans, declared };
  }

  configValues(id: string, values: Record<string, unknown> | undefined, schema?: Record<string, any>) {
    const input = structuredClone(values && typeof values === 'object' ? values : {});
    if (!schema) return input;
    const config = configDefaults(schema, input) as Record<string, unknown>;
    if (!Check(schema, config))
      throw new DomainError('invalid_input', 'Invalid configuration for plugin: ' + id);
    return config;
  }
}

export function changedSelection(
  id: string,
  previous: CompositionConfig,
  settings: CompositionConfig,
  key?: ScopeKey,
) {
  if (!key)
    return (
      settings.entries[id]?.disabled !== previous.entries[id]?.disabled ||
      !isDeepStrictEqual(previous.entries[id]?.config, settings.entries[id]?.config)
    );
  const before = previous.scopes[key],
    after = settings.scopes[key];
  return (
    before?.entries?.[id]?.disabled !== after?.entries?.[id]?.disabled ||
    !isDeepStrictEqual(before?.entries?.[id]?.config, after?.entries?.[id]?.config) ||
    !isDeepStrictEqual(previous.entries[id]?.config, settings.entries[id]?.config)
  );
}
