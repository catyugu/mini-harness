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
  liveConfig?: boolean;
}

export class PluginCatalog {
  readonly builtins: Map<string, BuiltinPlugin>;
  private readonly systemIds: Set<string>;

  constructor(private readonly directory: string, system: BuiltinPlugin[], builtins: BuiltinPlugin[]) {
    this.systemIds = new Set(system.map(({ id }) => id));
    this.builtins = new Map([...system, ...builtins].map((plugin) => [plugin.id, plugin]));
    if (this.builtins.size !== system.length + builtins.length) throw new Error('Duplicate builtin plugin ID');
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
    return [...[...this.builtins.values()].filter(({ id }) => !this.systemIds.has(id)).map(({ inject, setup, ...metadata }) => metadata),
      ...this.discover().map(({ metadata }) => metadata)];
  }

  plans(settings: Settings) {
    const next = [
      ...[...this.builtins.values()].filter(({ id }) => this.systemIds.has(id) || settings.plugins[id] === true)
        .map(({ id, requires = [], configSchema, liveConfig }): PluginPlan => ({
        id, requires, liveConfig, config: this.configValues(id, settings, configSchema)
      })),
      ...this.discover().filter(({ metadata: { id } }) => settings.plugins[id]).map(({ source, metadata }): PluginPlan => {
        if (metadata.error) throw new Error('Invalid plugin ' + metadata.id + ': ' + metadata.error);
        return { id: metadata.id, source, requires: metadata.requires ?? [],
          config: this.configValues(metadata.id, settings, metadata.configSchema) };
      })
    ];
    const desired = new Map(next.map((plan) => [plan.id, plan]));
    const ordered: PluginPlan[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string) => {
      if (visited.has(id)) return;
      if (visiting.has(id)) throw new Error('Cyclic plugin dependency: ' + id);
      const plan = desired.get(id);
      if (!plan) throw new Error('Required plugin is not enabled: ' + id);
      visiting.add(id);
      for (const dependency of plan.requires) visit(dependency);
      visiting.delete(id);
      visited.add(id);
      ordered.push(plan);
    };
    for (const plan of next) visit(plan.id);
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
