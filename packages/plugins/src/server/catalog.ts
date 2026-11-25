import { isDeepStrictEqual } from 'node:util';
import type { PluginMetadata } from '../shared/metadata.ts';
import { DomainError } from '@mini-harness/platform/errors';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  defineConfig,
  scopeAddresses,
  type ProfileConfiguration,
  type EntryConfiguration,
} from '@mini-harness/plugin-api/configuration';
import type { ScopeAddress } from '@mini-harness/plugin-api/configuration';
import { resolveConfig, type Context, type EntryOptions } from 'mini-harness/cordis';
import type { ResolvedPlugin } from '@mini-harness/plugin-api/descriptor';
import { builtinBrowserAssets } from './browser-assets.ts';
import { describePlugin, type DiscoveredPlugin } from './descriptor.ts';
import { loadPluginModule, resolveModule } from './module-resolution.ts';

export interface ConfiguredPlugin {
  descriptor: DiscoveredPlugin;
  id: string;
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

  enabled(descriptor: DiscoveredPlugin, settings: ProfileConfiguration) {
    const entry = descriptor.scopeAddress
      ? settings.scopes[descriptor.scopeAddress]?.entries?.[descriptor.id]
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

  private describe(
    id: string,
    entry: EntryConfiguration,
    client: boolean,
    scopeAddress?: ScopeAddress,
  ): DiscoveredPlugin {
    const name = entry.name;
    try {
      if (!name) throw new Error('Profile entry requires a module name: ' + id);
      const builtin = this.profile.builtin(id, name, client);
      const descriptor = builtin
        ? { ...builtin, resources: builtinBrowserAssets(builtin) }
        : this.describeModule(id, name, this.profile.source(id, name));
      if (!client) delete descriptor.resources;
      return this.withSchema({ ...descriptor, name, scopeAddress, defaultEnabled: entry.disabled !== true });
    } catch (error) {
      return {
        id,
        name,
        scopeAddress,
        title: id,
        description: name ?? '',
        external: true,
        defaultEnabled: entry.disabled !== true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async runtimeDescriptors(settings: ProfileConfiguration): Promise<DiscoveredPlugin[]> {
    const declarations = [
      ...Object.entries(settings.entries).map(([id, entry]) =>
        this.describe(id, entry, entry.client ?? true),
      ),
      ...scopeAddresses(settings).flatMap((key) =>
        Object.entries(settings.scopes[key]?.entries ?? {}).map(([id, entry]) =>
          this.describe(id, entry, false, key),
        ),
      ),
    ];
    return Promise.all(
      declarations.map(async (descriptor) => {
        const { id, location } = descriptor;
        if (!location || descriptor.error) return descriptor;
        if (!this.enabled(descriptor, settings)) {
          const key = descriptor.scopeAddress ? descriptor.scopeAddress + '/' + id : id;
          const previous = this.resolved.get(key);
          return previous &&
            previous.location?.url === location?.url &&
            previous.location?.exportName === location?.exportName
            ? this.withSchema({ ...descriptor, Config: previous.Config })
            : descriptor;
        }
        try {
          const { url, exportName } = location;
          const { plugin, Config, metadata } = await loadPluginModule(url, exportName);
          if (!plugin && !descriptor.resources && !metadata?.browser)
            throw new Error('Plugin ' + id + ' must export a Cordis plugin with apply(ctx, config)');
          return this.withSchema({
            ...descriptor,
            plugin,
            module: url + '#' + (exportName ?? 'default'),
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
      descriptors.map((item) => [item.scopeAddress ? item.scopeAddress + '/' + item.id : item.id, item]),
    );
  }

  private withSchema(descriptor: DiscoveredPlugin): DiscoveredPlugin {
    const schema = (descriptor.Config as { jsonSchema?: Record<string, any> } | undefined)?.jsonSchema;
    return schema ? { ...descriptor, configSchema: schema } : descriptor;
  }

  metadata(
    settings: ProfileConfiguration,
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
      const descriptor = group.find((item) => !item.scopeAddress) ?? group[0];
      const {
        resources,
        plugin: _plugin,
        browserStyles,
        Config: _Config,
        location: _location,
        module: _module,
        scopeAddress: _scopeKey,
        ...metadata
      } = descriptor;
      const instances: PluginMetadata['instances'] = group.map((item) => {
        const key = item.scopeAddress ? item.scopeAddress + '/' + item.id : item.id;
        const enabled = this.enabled(item, settings);
        let error = failures.get(key) ?? item.error;
        if (!error && !mounted(key) && (item.Config || item.configSchema)) {
          try {
            const config = item.scopeAddress
              ? settings.scopes[item.scopeAddress]?.entries?.[item.id]?.config
              : settings.entries[item.id]?.config;
            this.configValues(item, config);
          } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause);
          }
        }
        return {
          scope: item.scopeAddress ?? 'application',
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

  entry(plan: ConfiguredPlugin, context: Context, id = plan.id): EntryOptions {
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
        const changes = context.get('harnessChanges');
        if (changes) ctx.effect(() => changes.register('plugin:' + plan.id));
      },
    };
  }

  /** Disabled entries with a known schema can still reject malformed input without mounting. */
  validateDisabled(
    descriptors: DiscoveredPlugin[],
    previous: ProfileConfiguration,
    settings: ProfileConfiguration,
  ) {
    for (const descriptor of descriptors) {
      const { id, scopeAddress } = descriptor;
      const before = scopeAddress ? previous.scopes[scopeAddress]?.entries?.[id] : previous.entries[id];
      const after = scopeAddress ? settings.scopes[scopeAddress]?.entries?.[id] : settings.entries[id];
      if (!this.enabled(descriptor, settings) && !isDeepStrictEqual(before?.config, after?.config))
        this.configValues(descriptor, after?.config);
    }
  }

  plans(
    settings: ProfileConfiguration,
    descriptors: DiscoveredPlugin[],
    scopeAddress?: ScopeAddress,
    unavailable?: (id: string, error: unknown) => boolean,
  ) {
    const plans: ConfiguredPlugin[] = [];
    for (const item of descriptors) {
      const { id } = item;
      if (item.scopeAddress !== scopeAddress || !this.enabled(item, settings)) continue;
      const entry = scopeAddress ? settings.scopes[scopeAddress]?.entries?.[id] : settings.entries[id];
      try {
        if (item.error) throw new DomainError('invalid_input', 'Invalid plugin ' + id + ': ' + item.error);
        const values = entry?.config;
        const config = item.plugin ? structuredClone(values ?? {}) : this.configValues(item, values);
        plans.push({ descriptor: item, id, config, live: entry?.live ?? false });
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
  previous: ProfileConfiguration,
  settings: ProfileConfiguration,
  key?: ScopeAddress,
) {
  const before = key ? previous.scopes[key]?.entries?.[id] : previous.entries[id];
  const after = key ? settings.scopes[key]?.entries?.[id] : settings.entries[id];
  return !isDeepStrictEqual(before, after);
}
