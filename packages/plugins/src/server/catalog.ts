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
import { describePlugin, type ResolvedPlugin } from './descriptor.ts';
import { resolveModule } from './module-resolution.ts';

export interface ConfiguredPlugin {
  descriptor: ResolvedPlugin;
  id: string;
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
    const name = entry.name;
    const bundled = name && this.profile.locate(name);
    const external = !bundled;
    try {
      if (!name) throw new Error('Profile entry requires a module name: ' + id);
      const location = bundled || this.locateModule(name, this.profile.source(id, name));
      const key = scopeAddress ? scopeAddress + '/' + id : id;
      const descriptor = await describePlugin(id, location, client, entry, this.resolved.get(key));
      return { ...descriptor, scopeAddress, external };
    } catch (error) {
      return {
        id,
        configuration: entry,
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

  metadata(
    failures: ReadonlyMap<string, string>,
    mounted: (id: string) => boolean,
  ): PluginMetadata[] {
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

  entry(plan: ConfiguredPlugin, context: Context, id = plan.id): EntryOptions {
    const { descriptor } = plan;
    const plugin = descriptor.native?.plugin;
    if (!plugin || !descriptor.location) throw new Error('Missing server module: ' + plan.id);
    return {
      id,
      context,
      config: plan.config ?? {},
      module: descriptor.location.url + '#' + (descriptor.location.exportName ?? 'default'),
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
    descriptors: ResolvedPlugin[],
    previous: ProfileConfiguration,
  ) {
    for (const descriptor of descriptors) {
      const { id, scopeAddress } = descriptor;
      const before = scopeAddress ? previous.scopes[scopeAddress]?.entries?.[id] : previous.entries[id];
      const { configuration } = descriptor;
      if (configuration.disabled && !isDeepStrictEqual(before?.config, configuration.config))
        this.configValues(descriptor, configuration.config);
    }
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
        const config = item.native?.plugin ? structuredClone(values ?? {}) : this.configValues(item, values);
        plans.push({ descriptor: item, id, config, live: entry.live ?? false });
      } catch (error) {
        if (!unavailable?.(id, error)) throw error;
      }
    }
    return plans;
  }

  configValues(descriptor: ResolvedPlugin, values: Record<string, unknown> | undefined) {
    try {
      return resolveConfig(
        descriptor.native?.Config ??
          (descriptor.info.configSchema ? defineConfig(descriptor.info.configSchema) : undefined),
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
