import { isDeepStrictEqual } from 'node:util';
import type { PluginMetadata } from '../shared/metadata.ts';
import { DomainError } from '@mini-harness/platform/errors';
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  defineConfig,
  scopeKeys,
  type CompositionConfig,
  type EntryConfiguration,
} from '@mini-harness/plugin-api/configuration';
import type { PluginScope, ScopeKey } from '@mini-harness/plugin-api/scopes';
import { resolveConfig, type Context, type EntryOptions } from 'mini-harness/cordis';
import type { ResolvedPlugin } from '@mini-harness/plugin-api/descriptor';
import { builtinBrowserAssets } from './browser-assets.ts';
import { describePlugin, type DiscoveredPlugin } from './descriptor.ts';
import { loadPluginModule, resolveModule } from './module-resolution.ts';
import { bindInstance } from '@mini-harness/plugin-api/instance';

export interface ConfiguredPlugin {
  descriptor: DiscoveredPlugin;
  id: string;
  source?: string;
  config: Record<string, unknown>;
  live: boolean;
}

export class PluginCatalog {
  private resolved = new Map<string, DiscoveredPlugin>();
  constructor(
    private readonly profile: Pick<
      import('@mini-harness/plugin-api/profile').ProfileRuntime,
      'builtin' | 'source'
    >,
  ) {}

  enabled(descriptor: DiscoveredPlugin, settings: CompositionConfig) {
    const entry = descriptor.scopeKey
      ? settings.scopes[descriptor.scopeKey]?.entries?.[descriptor.id]
      : settings.entries[descriptor.id];
    return !!entry && entry.disabled !== true;
  }

  reserved(id: string) {
    return !this.resolved.get(id)?.external;
  }

  private describeModule(id: string, name: string, source: string): DiscoveredPlugin {
    const local = isAbsolute(name) || name.startsWith('./') || name.startsWith('../');
    if (local) {
      const path = resolve(dirname(source), name);
      if (statSync(path, { throwIfNoEntry: false })?.isDirectory()) return describePlugin(id, path);
    }
    let entry: string | undefined;
    let directory: string;
    try {
      entry = fileURLToPath(resolveModule(name, source));
      directory = dirname(entry);
    } catch (error) {
      if (local) throw error;
      directory = dirname(fileURLToPath(resolveModule(name + '/client', source)));
    }
    if (!local)
      while (!existsSync(join(directory, 'package.json')) && dirname(directory) !== directory)
        directory = dirname(directory);
    return describePlugin(id, directory, entry);
  }

  private async describe(
    id: string,
    entry: EntryConfiguration,
    client: boolean,
    scopeKey?: ScopeKey,
  ): Promise<DiscoveredPlugin> {
    const name = entry.name;
    try {
      if (!name) throw new Error('Profile entry requires a module name: ' + id);
      const builtin = this.profile.builtin(id, name, client);
      let descriptor: DiscoveredPlugin;
      if (builtin) {
        descriptor = { ...builtin, id, resources: client ? builtinBrowserAssets(builtin) : undefined };
      } else {
        descriptor = this.describeModule(id, name, this.profile.source(id, name));
      }
      if (!client || scopeKey) delete descriptor.resources;
      return this.withSchema({ ...descriptor, name, scopeKey, defaultEnabled: entry.disabled !== true });
    } catch (error) {
      return {
        id,
        name,
        scopeKey,
        title: id,
        description: name ?? '',
        external: true,
        defaultEnabled: entry.disabled !== true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async runtimeDescriptors(settings: CompositionConfig): Promise<DiscoveredPlugin[]> {
    const client = Object.values(settings.entries).some(
      ({ name, disabled }) => name === '@mini-harness/web-gateway' && !disabled,
    );
    const declarations = [
      ...Object.entries(settings.entries).map(([id, entry]) =>
        this.describe(id, entry, entry.client ?? (client || !!entry.name?.endsWith('/client'))),
      ),
      ...scopeKeys(settings).flatMap((key) =>
        Object.entries(settings.scopes[key]?.entries ?? {}).map(([id, entry]) =>
          this.describe(id, entry, false, key),
        ),
      ),
    ];
    return Promise.all(
      (await Promise.all(declarations)).map(async (descriptor) => {
        const { id, source, location } = descriptor;
        if ((!source && !location) || descriptor.error) return descriptor;
        if (!this.enabled(descriptor, settings)) {
          const key = descriptor.scopeKey ? descriptor.scopeKey + '/' + id : id;
          const previous = this.resolved.get(key);
          return previous &&
            previous.source === source &&
            previous.location?.url === location?.url &&
            previous.location?.exportName === location?.exportName
            ? this.withSchema({ ...descriptor, Config: previous.Config })
            : descriptor;
        }
        try {
          const url = location?.url ?? pathToFileURL(source!).href + '?v=' + lstatSync(source!).mtimeMs;
          const { plugin, Config, metadata } = await loadPluginModule(
            url,
            location?.exportName,
          );
          if (!plugin && !descriptor.resources && !metadata?.browser)
            throw new Error('Plugin ' + id + ' must export a Cordis plugin with apply(ctx, config)');
          return this.withSchema({
            ...descriptor,
            plugin,
            module: url + '#' + (location?.exportName ?? 'default'),
            Config,
          });
        } catch (error) {
          return { ...descriptor, error: error instanceof Error ? error.message : String(error) };
        }
      }),
    );
  }

  descriptors() {
    return [...this.resolved.values()];
  }

  commit(descriptors: DiscoveredPlugin[]) {
    this.resolved = new Map(
      descriptors.map((item) => [item.scopeKey ? item.scopeKey + '/' + item.id : item.id, item]),
    );
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
    const groups = new Map<string, DiscoveredPlugin[]>();
    for (const item of this.descriptors()) {
      const group = groups.get(item.id) ?? [];
      group.push(item);
      groups.set(item.id, group);
    }
    return [...groups.values()].map((group) => {
      const descriptor = group.find((item) => !item.scopeKey) ?? group[0];
      const {
        source,
        resources,
        plugin: _plugin,
        browserStyles,
        Config: _Config,
        location: _location,
        module: _module,
        scopeKey: _scopeKey,
        ...metadata
      } = descriptor;
      const instances: NonNullable<PluginMetadata['instances']> = group.map((item) => {
        const key = item.scopeKey ? item.scopeKey + '/' + item.id : item.id;
        const enabled = this.enabled(item, settings);
        let error = failures.get(key) ?? item.error;
        if (!error && !mounted(key) && (item.Config || item.configSchema)) {
          try {
            const config = item.scopeKey
              ? settings.scopes[item.scopeKey]?.entries?.[item.id]?.config
              : settings.entries[item.id]?.config;
            this.configValues(item, config);
          } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause);
          }
        }
        return {
          scope: item.scopeKey ?? 'application',
          name: item.name,
          configSchema: item.configSchema,
          error,
          state: !enabled ? 'disabled' : error ? 'failed' : mounted(key) ? 'ready' : 'inactive',
        };
      });
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
        instances,
        state,
        error: failed?.error ?? instances.find((instance) => instance.error)?.error ?? metadata.error,
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
      module: descriptor.module ?? descriptor.name ?? plan.id,
      live: plan.live,
      load: () => plugin,
      prepare: (ctx) => {
        bindInstance(ctx.fiber.entry!, {
          pluginId: plan.id,
          scope,
          scopeKey,
          writableConfig: plan.live,
          module: descriptor.source
            ? pathToFileURL(realpathSync(descriptor.source)).href
            : (descriptor.name ?? plan.id),
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
      const { id, scopeKey } = descriptor;
      const before = scopeKey ? previous.scopes[scopeKey]?.entries?.[id] : previous.entries[id];
      const after = scopeKey ? settings.scopes[scopeKey]?.entries?.[id] : settings.entries[id];
      if (!this.enabled(descriptor, settings) && !isDeepStrictEqual(before?.config, after?.config))
        this.configValues(descriptor, after?.config);
    }
  }

  plans(
    settings: CompositionConfig,
    descriptors: DiscoveredPlugin[],
    scope: PluginScope['kind'],
    scopeKey?: ScopeKey,
    unavailable?: (id: string, error: unknown) => boolean,
  ) {
    const plans: ConfiguredPlugin[] = [];
    for (const item of descriptors) {
      const { id } = item;
      if (item.scopeKey !== scopeKey || !this.enabled(item, settings)) continue;
      const entry =
        scope === 'application' ? settings.entries[id] : settings.scopes[scopeKey!]?.entries?.[id];
      try {
        if (item.error) throw new DomainError('invalid_input', 'Invalid plugin ' + id + ': ' + item.error);
        const values = entry?.config;
        const config = item.plugin ? structuredClone(values ?? {}) : this.configValues(item, values);
        plans.push({ descriptor: item, id, source: item.source, config, live: entry?.live ?? false });
      } catch (error) {
        if (!unavailable?.(id, error)) throw error;
      }
    }
    return plans;
  }

  configValues(descriptor: ResolvedPlugin, values: Record<string, unknown> | undefined) {
    try {
      return resolveConfig(
        descriptor.Config ??
          descriptor.plugin?.Config ??
          (descriptor.configSchema ? defineConfig(descriptor.configSchema) : undefined),
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
  const before = key ? previous.scopes[key]?.entries?.[id] : previous.entries[id];
  const after = key ? settings.scopes[key]?.entries?.[id] : settings.entries[id];
  return !isDeepStrictEqual(before, after);
}
