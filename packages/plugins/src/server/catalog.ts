import { isDeepStrictEqual } from 'node:util';
import type { PluginMetadata } from '../shared/metadata.ts';
import { localPluginIdPattern } from '@mini-harness/plugin-api/selection';
import { DomainError } from '@mini-harness/platform/errors';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { scopeKeys, type CompositionConfig } from '@mini-harness/plugin-api/configuration';
import type { PluginScope, ScopeKey, ScopeSettings } from '@mini-harness/plugin-api/scopes';
import { resolveConfig, type Context, type EntryOptions, type Plugin } from 'mini-harness/cordis';
import type { ResolvedPlugin } from '@mini-harness/plugin-api/descriptor';
import { builtinBrowserAssets } from './browser-assets.ts';
import { describePlugin, type DiscoveredPlugin } from './descriptor.ts';
import { resolveModule } from './module-resolution.ts';
import { bindInstance } from '@mini-harness/plugin-api/instance';

export interface ConfiguredPlugin {
  descriptor: DiscoveredPlugin;
  id: string;
  source?: string;
  config: Record<string, unknown>;
  live: boolean;
}

export class PluginCatalog {
  private readonly builtins: Map<string, DiscoveredPlugin>;
  private resolved = new Map<string, DiscoveredPlugin>();
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
        this.withSchema({
          ...descriptor,
          Config: descriptor.Config ?? descriptor.plugin?.Config,
          resources: builtinBrowserAssets(descriptor),
        }),
      ]),
    );
    if (this.builtins.size !== builtins.length) throw new Error('Duplicate builtin plugin ID');
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
      ...[...(this.profile?.modules ?? [])].map(([id, { name, source }]) =>
        this.describeModule(id, name, source),
      ),
      ...this.discover(),
    ];
  }

  async runtimeDescriptors(settings: CompositionConfig): Promise<DiscoveredPlugin[]> {
    const descriptors = await Promise.all(
      this.descriptors().map(async (descriptor) => {
        const { id, source, scope } = descriptor;
        if (!source || descriptor.error) return descriptor;
        const enabled =
          scope === 'application'
            ? this.enabled(descriptor, settings)
            : scopeKeys(settings).some(
                (key) =>
                  key.startsWith(scope + ':') && settings.scopes[key]?.entries?.[id]?.disabled === false,
              );
        if (!enabled) return descriptor;
        try {
          const module = pathToFileURL(source).href + '?v=' + lstatSync(source).mtimeMs;
          const exports = await import(module);
          const value = exports.default ?? exports;
          const plugin: Plugin | undefined =
            typeof value === 'function' || typeof value?.apply === 'function' ? value : undefined;
          const Config = plugin ? plugin.Config : exports.Config;
          if (!plugin && !(descriptor.resources && Config))
            throw new Error('Plugin ' + id + ' must export a Cordis plugin with apply(ctx, config)');
          return this.withSchema({ ...descriptor, plugin, module, Config });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { ...descriptor, error: message };
        }
      }),
    );
    this.resolved = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
    return descriptors;
  }

  private withSchema(descriptor: DiscoveredPlugin): DiscoveredPlugin {
    const schema = (descriptor.Config as { jsonSchema?: Record<string, any> } | undefined)?.jsonSchema;
    return schema ? { ...descriptor, configSchema: schema } : descriptor;
  }

  metadata(
    settings: CompositionConfig,
    failures: ReadonlyMap<string, string>,
    mounted: (id: string) => boolean,
  ): PluginMetadata[] {
    return this.descriptors()
      .filter(({ id }) => !id.startsWith('core:'))
      .map((discovered) => {
        const descriptor = this.resolved.get(discovered.id) ?? discovered;
        const {
          id,
          source,
          resources,
          plugin: _plugin,
          browserStyles,
          Config: _Config,
          module: _module,
          ...metadata
        } = descriptor;
        const configurationError = (key?: ScopeKey) => {
          try {
            const values = key
              ? { ...settings.entries[id]?.config, ...settings.scopes[key]?.entries?.[id]?.config }
              : settings.entries[id]?.config;
            this.configValues(descriptor, values);
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
              (!mounted(key) ? configurationError(scope === 'application' ? undefined : scope) : undefined);
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

  entry(
    plan: ConfiguredPlugin,
    context: Context,
    scope: PluginScope,
    id = plan.id,
    scopeKey?: ScopeKey,
  ): EntryOptions {
    const { descriptor } = plan;
    const plugin = descriptor.plugin;
    if (!plugin) throw new Error('Missing server module: ' + plan.id);
    return {
      id,
      context,
      config: plan.config ?? {},
      module: descriptor.module ?? plan.id,
      live: plan.live,
      load: () => plugin,
      prepare: (ctx) => {
        bindInstance(ctx.fiber.entry!, {
          pluginId: plan.id,
          scope,
          scopeKey,
          writableConfig: plan.live,
        });
        const changes = context.get('harnessChanges');
        if (changes) ctx.effect(() => changes.register('plugin:' + plan.id));
      },
    };
  }

  /** Disabled entries with a known schema can still reject malformed input without mounting. */
  validateDisabled(
    descriptors: DiscoveredPlugin[],
    previous: CompositionConfig,
    settings: CompositionConfig,
  ) {
    for (const descriptor of descriptors) {
      const { id, scope } = descriptor;
      const before = previous.entries[id]?.config;
      const after = settings.entries[id]?.config;
      if (scope === 'application' && !this.enabled(descriptor, settings) && !isDeepStrictEqual(before, after))
        this.configValues(descriptor, after);
      if (scope !== 'application')
        for (const key of scopeKeys(settings)) {
          if (!key.startsWith(scope + ':') || settings.scopes[key]?.entries?.[id]?.disabled === false)
            continue;
          const prior = { ...before, ...previous.scopes[key]?.entries?.[id]?.config };
          const next = { ...after, ...settings.scopes[key]?.entries?.[id]?.config };
          if (!isDeepStrictEqual(prior, next)) this.configValues(descriptor, next);
        }
    }
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
        if (
          entry.disabled === false &&
          descriptors.some((item) => item.id === id && item.scope !== 'application')
        )
          throw new DomainError('invalid_input', 'Select a scope for plugin ' + id);
      }
    for (const item of descriptors) {
      const { id, scope: kind } = item;
      if (
        kind !== scope ||
        !(isApp ? this.enabled(item, settings) : overrides?.entries?.[id]?.disabled === false)
      )
        continue;
      // Child groups isolate the services declared by their Cordis modules.
      const provide = item.plugin?.provide;
      for (const service of typeof provide === 'string' ? [provide] : (provide ?? [])) declared.add(service);
      try {
        if (item.error) throw new DomainError('invalid_input', 'Invalid plugin ' + id + ': ' + item.error);
        const values = isApp
          ? settings.entries[id]?.config
          : { ...settings.entries[id]?.config, ...overrides?.entries?.[id]?.config };
        const live =
          (isApp ? undefined : overrides?.entries?.[id]?.live) ?? settings.entries[id]?.live ?? false;
        const config = item.plugin ? structuredClone(values ?? {}) : this.configValues(item, values);
        plans.push({ descriptor: item, id, source: item.source, config, live });
      } catch (error) {
        if (!unavailable?.(id, error)) throw error;
      }
    }
    return { plans, declared };
  }

  configValues(descriptor: ResolvedPlugin, values: Record<string, unknown> | undefined) {
    try {
      return resolveConfig(
        descriptor.Config ?? descriptor.plugin?.Config,
        structuredClone(values ?? {}),
      ) as Record<string, unknown>;
    } catch (error) {
      throw new DomainError(
        'invalid_input',
        'Invalid configuration for plugin: ' + descriptor.id + ': ' + String(error),
        { cause: error },
      );
    }
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
      settings.entries[id]?.live !== previous.entries[id]?.live ||
      !isDeepStrictEqual(previous.entries[id]?.config, settings.entries[id]?.config)
    );
  const before = previous.scopes[key],
    after = settings.scopes[key];
  return (
    before?.entries?.[id]?.disabled !== after?.entries?.[id]?.disabled ||
    before?.entries?.[id]?.live !== after?.entries?.[id]?.live ||
    !isDeepStrictEqual(before?.entries?.[id]?.config, after?.entries?.[id]?.config) ||
    previous.entries[id]?.live !== settings.entries[id]?.live ||
    !isDeepStrictEqual(previous.entries[id]?.config, settings.entries[id]?.config)
  );
}
