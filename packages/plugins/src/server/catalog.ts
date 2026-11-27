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
import { resolveConfig, type Context, type EntryOptions, type Plugin } from 'mini-harness/cordis';
import { describePlugin, type ResolvedEntryConfiguration, type ResolvedPlugin } from './descriptor.ts';
import type { BrowserAssets } from './browser-assets.ts';
import { resolveModule } from './module-resolution.ts';

export interface ConfiguredPlugin {
  id: string;
  server?: { module: string; plugin: Plugin };
  resources?: BrowserAssets;
  configurable: boolean;
  config: Record<string, unknown>;
  live: boolean;
}

export class PluginCatalog {
  private resolved = new Map<string, ResolvedPlugin>();
  constructor(
    private readonly profile: Pick<
      import('@mini-harness/plugin-api/profile').ProfileRuntime,
      'locate' | 'source'
    >,
  ) {}

  origin(instanceId: string) {
    return this.resolved.get(instanceId)?.external ? 'local' : 'built-in';
  }

  private locateModule(name: string, source: string) {
    const local = isAbsolute(name) || name.startsWith('./') || name.startsWith('../');
    if (local) {
      const path = resolve(dirname(source), name);
      if (statSync(path, { throwIfNoEntry: false })?.isDirectory()) return { folder: path };
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
    const containing = directory;
    while (!existsSync(join(directory, 'package.json')) && !existsSync(join(directory, 'plugin.json'))) {
      const parent = dirname(directory);
      if (parent === directory) {
        directory = containing;
        break;
      }
      directory = parent;
    }
    return { folder: directory, entry };
  }

  private async describe(
    id: string,
    entry: EntryConfiguration,
    client: boolean,
    scopeAddress?: ScopeAddress,
  ): Promise<ResolvedPlugin> {
    const configuration: ResolvedEntryConfiguration = {
      name: entry.name,
      disabled: entry.disabled ?? false,
      live: entry.live ?? false,
      config: entry.config ?? {},
    };
    const name = configuration.name;
    const bundled = name && this.profile.locate(name);
    const external = !bundled;
    try {
      if (!name) throw new Error('Profile entry requires a module name: ' + id);
      const location = bundled || this.locateModule(name, this.profile.source(id, name));
      const key = scopeAddress ? scopeAddress + '/' + id : id;
      const descriptor = await describePlugin(id, location, client, configuration, this.resolved.get(key));
      return { ...descriptor, scopeAddress, external };
    } catch (error) {
      return {
        id,
        configuration,
        scopeAddress,
        external,
        info: { title: id, description: name ?? '' },
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  runtimeDescriptors(settings: ProfileConfiguration): Promise<ResolvedPlugin[]> {
    return Promise.all([
      ...Object.entries(settings.entries).map(([id, entry]) =>
        this.describe(id, entry, entry.client ?? true),
      ),
      ...scopeAddresses(settings).flatMap((key) =>
        Object.entries(settings.scopes[key]?.entries ?? {}).map(([id, entry]) =>
          this.describe(id, entry, false, key),
        ),
      ),
    ]);
  }

  descriptors() {
    return [...this.resolved.values()];
  }

  commit(descriptors: ResolvedPlugin[]) {
    this.resolved = new Map(
      descriptors.map((item) => [item.scopeAddress ? item.scopeAddress + '/' + item.id : item.id, item]),
    );
  }

  metadata(failures: ReadonlyMap<string, string>, mounted: (id: string) => boolean): PluginMetadata[] {
    const groups = new Map<string, ResolvedPlugin[]>();
    for (const item of this.descriptors()) {
      const group = groups.get(item.id) ?? [];
      group.push(item);
      groups.set(item.id, group);
    }
    return [...groups.values()].map((group) => {
      const descriptor = group.find((item) => !item.scopeAddress) ?? group[0];
      const { id, configuration, external, package: packageInfo, info, error: descriptorError } = descriptor;
      const instances: PluginMetadata['instances'] = group.map((item) => {
        const key = item.scopeAddress ? item.scopeAddress + '/' + item.id : item.id;
        const enabled = !item.configuration.disabled;
        let error = failures.get(key) ?? item.error;
        if (!error && !mounted(key) && (item.native?.Config || item.info.configSchema)) {
          try {
            this.configValues(item, item.configuration.config);
          } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause);
          }
        }
        return {
          scope: item.scopeAddress ?? 'application',
          name: item.configuration.name,
          configSchema: item.info.configSchema,
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
        ...info,
        id,
        name: configuration.name,
        external,
        package: packageInfo,
        instances,
        state,
        error: failed?.error ?? instances.find((instance) => instance.error)?.error ?? descriptorError,
      };
    });
  }

  entries(plans: ConfiguredPlugin[], context: Context, scope?: ScopeAddress): EntryOptions[] {
    return plans.flatMap((plan) => {
      const server = plan.server;
      if (!server) return [];
      return [
        {
          id: scope ? scope + '/' + plan.id : plan.id,
          context,
          config: plan.config,
          module: server.module,
          live: plan.live,
          load: () => server.plugin,
          prepare: (ctx) => {
            const changes = context.get('harnessChanges');
            if (changes) ctx.effect(() => changes.register('plugin:' + plan.id));
          },
        },
      ];
    });
  }

  plans(
    descriptors: ResolvedPlugin[],
    scopeAddress?: ScopeAddress,
    unavailable?: (id: string, error: unknown) => boolean,
  ) {
    const plans: ConfiguredPlugin[] = [];
    for (const item of descriptors) {
      const { id } = item;
      const entry = item.configuration;
      if (item.scopeAddress !== scopeAddress || entry.disabled) continue;
      try {
        if (item.error) throw new DomainError('invalid_input', 'Invalid plugin ' + id + ': ' + item.error);
        const values = entry.config;
        const plugin = item.native?.plugin;
        const config = plugin ? structuredClone(values) : this.configValues(item, values);
        const server =
          plugin && item.location
            ? { module: item.location.url + '#' + (item.location.exportName ?? 'default'), plugin }
            : undefined;
        plans.push({
          id,
          config,
          live: entry.live,
          server,
          resources: item.resources,
          configurable: Boolean(item.native?.Config || item.info.configSchema),
        });
      } catch (error) {
        if (!unavailable?.(id, error)) throw error;
      }
    }
    return plans;
  }

  configValues(descriptor: ResolvedPlugin, values: Record<string, unknown>) {
    try {
      return resolveConfig(
        descriptor.native?.Config ??
          (descriptor.info.configSchema ? defineConfig(descriptor.info.configSchema) : undefined),
        structuredClone(values),
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
