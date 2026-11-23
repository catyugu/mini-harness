import { readdirSync, existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { Check } from 'typebox/value';
import { readJson } from '../platform/config.js';
import type { Settings } from '../contracts/config.js';
import type { BuiltinPlugin, PluginMetadata } from '../contracts/plugins.js';

function configDefaults(schema: Record<string, any>, value: any): any {
  if (value === undefined && Object.hasOwn(schema, 'default')) value = structuredClone(schema.default);
  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
      const item = configDefaults(property, value[key]);
      if (item !== undefined) value[key] = item;
    }
  }
  return value;
}

export interface PluginPlan {
  id: string;
  source?: string;
  config?: Record<string, unknown>;
  requires: string[];
  browser?: string;
  browserRequires?: string[];
  web?: boolean;
}

export class PluginCatalog {
  readonly builtins: Map<string, BuiltinPlugin>;
  constructor(private readonly directory: string, builtins: BuiltinPlugin[], private readonly rootServices: string[]) {
    this.builtins = new Map(builtins.map((plugin) => [plugin.id, plugin]));
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
      if (required) continue;
      plugins[id] ??= defaultEnabled ?? false;
      if (configSchema) pluginConfig[id] = configDefaults(configSchema, structuredClone(pluginConfig[id] ?? {}));
    }
    return { ...settings, plugins, pluginConfig };
  }

  reserved(id: string) { return this.builtins.has(id); }

  private discover(): { source?: string; metadata: PluginMetadata }[] {
    return readdirSync(this.directory, { withFileTypes: true }).flatMap((entry): { source?: string; metadata: PluginMetadata }[] => {
      const id = entry.name;
      if (!entry.isDirectory() || !/^[a-z][a-z0-9-]{0,63}$/.test(id) || this.builtins.has(id)) return [];
      const folder = join(this.directory, id);
      const source = join(folder, 'plugin.js');
      const webSource = join(folder, 'web.js');
      if (lstatSync(folder).isSymbolicLink()) return [];
      const hasHost = existsSync(source) && lstatSync(source).isFile() && !lstatSync(source).isSymbolicLink();
      const hasWeb = existsSync(webSource) && lstatSync(webSource).isFile() && !lstatSync(webSource).isSymbolicLink();
      if (!hasHost && !hasWeb) return [];
      try {
        const manifest = readJson<Partial<PluginMetadata> | null>(join(folder, 'plugin.json'), null);
        const title = typeof manifest?.title === 'string' ? manifest.title.slice(0, 100) : id;
        const description = typeof manifest?.description === 'string' ? manifest.description.slice(0, 300) : 'Runs local JavaScript with your user permissions.';
        const requires = manifest?.requires ?? [];
        if (!Array.isArray(requires) || requires.some((name) => typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(name)))
          throw new Error('Invalid plugin dependencies: ' + id);
        const configSchema = manifest?.configSchema;
        if (configSchema && (configSchema.type !== 'object' || !configSchema.properties || typeof configSchema.properties !== 'object'))
          throw new Error('Expected an object configSchema for plugin: ' + id);
        const icon = manifest?.icon;
        if (icon !== undefined && !(
          typeof icon === 'string' && icon.length > 0 && icon.length <= 128 ||
          icon !== null && typeof icon === 'object' && !Array.isArray(icon) &&
          typeof icon.path === 'string' && icon.path.length > 0 && icon.path.length <= 8192 &&
          (icon.viewBox === undefined || typeof icon.viewBox === 'string' && icon.viewBox.length <= 100)
        )) throw new Error('Invalid plugin icon: ' + id);
        return [{ source: hasHost ? source : undefined, metadata: {
          id, title, description, requires, configSchema, icon, web: hasWeb, trustedCode: true
        } }];
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return [{ metadata: { id, title: id, description: 'Plugin manifest cannot be loaded.', trustedCode: true,
          error: message, web: false, requires: [] } }];
      }
    });
  }

  metadata() {
    return [...[...this.builtins.values()].filter(({ required }) => !required).map(({ inject, setup, provides, optional, browserRequires, scope, required, configChanges, ...metadata }) => metadata),
      ...this.discover().map(({ metadata }) => metadata)];
  }

  plans(settings: Settings, unavailable?: (id: string, error: unknown) => boolean) {
    const enabled = [...this.builtins.values()].filter(({ id, required }) => required || settings.plugins[id] === true);
    const providers = new Map<string, string>();
    for (const { id, provides = [] } of enabled) for (const service of provides) {
      if (providers.has(service)) throw new Error('Multiple enabled providers for ' + service);
      providers.set(service, id);
    }
    const desired = new Map<string, PluginPlan>();
    const add = (id: string, make: () => PluginPlan) => {
      try { desired.set(id, make()); }
      catch (error) { if (!unavailable?.(id, error)) throw error; }
    };
    for (const { id, requires = [], inject = [], configSchema, browser, browserRequires } of enabled) {
      add(id, () => {
        const dependencies = inject.filter((service) => !this.rootServices.includes(service)).map((service) => {
          const provider = providers.get(service);
          if (!provider) throw new Error('No enabled provider for ' + service);
          return provider;
        });
        return { id, browser, browserRequires,
          requires: [...new Set([...requires, ...dependencies])],
          config: this.configValues(id, settings, configSchema) };
      });
    }
    for (const { source, metadata } of this.discover()) {
      const { id, web, requires = [], configSchema, error } = metadata;
      if (!settings.plugins[id]) continue;
      add(id, () => {
        if (error) throw new Error('Invalid plugin ' + id + ': ' + error);
        return { id, source, web, requires, browserRequires: requires, config: this.configValues(id, settings, configSchema) };
      });
    }
    const ordered: PluginPlan[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string) => {
      if (visited.has(id)) return;
      if (visiting.has(id)) throw new Error('Cyclic plugin dependency: ' + id);
      const plan = desired.get(id);
      if (!plan) throw new Error('Required plugin is not enabled: ' + id);
      visiting.add(id);
      try { for (const dependency of plan.requires) visit(dependency); }
      finally { visiting.delete(id); }
      visited.add(id);
      ordered.push(plan);
    };
    for (const id of desired.keys()) {
      try { visit(id); }
      catch (error) { if (!unavailable?.(id, error)) throw error; }
    }
    return ordered;
  }

  private configValues(id: string, settings: Settings, schema?: Record<string, any>) {
    const input = structuredClone(settings.pluginConfig[id] ?? {});
    if (!schema) return input;
    const config = configDefaults(schema, input) as Record<string, unknown>;
    if (!Check(schema, config)) throw new Error('Invalid configuration for plugin: ' + id);
    return config;
  }

}
