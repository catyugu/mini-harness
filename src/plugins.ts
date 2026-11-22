import type { Context, Fiber } from 'cordis';
import { readdirSync, existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { Check, Default } from 'typebox/value';
import { readJson, type Settings } from './config.js';
import type { BuiltinPlugin, PluginApi, PluginMetadata, SessionRecords } from './plugin-api.js';

const publicServices = new Set(['harnessModels', 'harnessSessions']);

interface PluginPlan {
  id: string;
  source?: string;
  config?: Record<string, unknown>;
  requires: string[];
}

export class PluginHost {
  private readonly mounted = new Map<string, { plan: PluginPlan; fiber: Fiber }>();
  private readonly builtins: Map<string, BuiltinPlugin>;

  constructor(readonly ctx: Context, private readonly directory: string, builtins: BuiltinPlugin[],
    private readonly sessionRecords: (sessionId: string, pluginId: string) => Promise<SessionRecords>) {
    this.builtins = new Map(builtins.map((plugin) => [plugin.id, plugin]));
  }

  private discover() {
    return readdirSync(this.directory, { withFileTypes: true }).flatMap((entry) => {
      const id = entry.name;
      if (!entry.isDirectory() || !/^[a-z][a-z0-9-]{0,63}$/.test(id) || this.builtins.has(id)) return [];
      const folder = join(this.directory, id);
      const source = join(folder, 'plugin.js');
      if (!existsSync(source) || lstatSync(folder).isSymbolicLink() || !lstatSync(source).isFile() || lstatSync(source).isSymbolicLink()) return [];
      const manifest = readJson<Partial<PluginMetadata> | null>(join(folder, 'plugin.json'), null);
      const title = typeof manifest?.title === 'string' ? manifest.title.slice(0, 100) : id;
      const description = typeof manifest?.description === 'string' ? manifest.description.slice(0, 300) : 'Runs local JavaScript with your user permissions.';
      const requires = manifest?.requires ?? [];
      if (!Array.isArray(requires) || requires.some((id) => typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(id)))
        throw new Error('Invalid plugin dependencies: ' + id);
      const configSchema = manifest?.configSchema;
      if (configSchema && (configSchema.type !== 'object' || !configSchema.properties || typeof configSchema.properties !== 'object'))
        throw new Error('Expected an object configSchema for plugin: ' + id);
      return [{ source, metadata: { id, title, description, requires, configSchema, web: existsSync(join(folder, 'web.js')), trustedCode: true } }];
    });
  }

  metadata() {
    return [...[...this.builtins.values()].map(({ inject, setup, ...metadata }) => metadata),
      ...this.discover().map(({ metadata }) => metadata)];
  }

  private async mount(plan: PluginPlan) {
    const { id, source } = plan;
    let fiber: Fiber | undefined;
    try {
        const builtin = this.builtins.get(id);
        const mod = builtin ? undefined : await import(pathToFileURL(source).href + '?v=' + lstatSync(source).mtimeMs);
        const component = builtin ?? mod.default ?? mod.apply;
        const setup = builtin?.setup ?? (typeof component === 'function' ? component : component?.apply?.bind(component));
        if (typeof setup !== 'function') throw new Error('Expected a setup function or a Cordis component');
        const deps = [...new Set<string>(component.inject ?? mod.inject ?? [])];
        if (!builtin && deps.some((dep) => !publicServices.has(dep)))
          throw new Error('Unknown harness service dependency');
        fiber = this.ctx.inject(deps, async (ctx) => {
          const values = Object.freeze(structuredClone(plan.config ?? {}));
          const cleanup = await setup(ctx, {
            config: values,
            defineConfig(defaults, validate) {
              const config = Object.freeze({ ...structuredClone(defaults), ...values });
              validate?.(config);
              return config;
            },
            registerTool: (tool) => ctx.effect(() => this.ctx.harnessTools.register(tool.name, () => tool)),
            registerRoute: (method, path, handler) => {
              if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ||
                  !/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/.test(path)) throw new Error('Invalid plugin route');
              return ctx.effect(() => this.ctx.harnessRoutes.register(method, '/api/extensions/' + id + path, handler));
            },
            records: {
              list: async (sessionId) => (await this.sessionRecords(sessionId, id)).list(),
              append: async (sessionId, data) => (await this.sessionRecords(sessionId, id)).append(data)
            },
            onDispose: (dispose) => { ctx.effect(() => dispose); }
          } satisfies PluginApi);
          if (typeof cleanup === 'function') ctx.effect(() => cleanup);
        });
      await fiber.await();
      this.mounted.set(id, { plan, fiber });
    } catch (error) {
      await fiber?.dispose();
      throw new Error('Plugin ' + id + ': ' + (error instanceof Error ? error.message : String(error)), { cause: error });
    }
  }

  private async unmount(id: string) {
    const installed = this.mounted.get(id);
    if (!installed) return;
    this.mounted.delete(id);
    await installed.fiber.dispose();
  }

  private plans(settings: Settings) {
    const next = [
      ...[...this.builtins.keys()].map((id): PluginPlan => ({ id, requires: [] })),
      ...this.discover().filter(({ metadata: { id } }) => settings.plugins[id]).map(({ source, metadata: { id, requires, configSchema } }): PluginPlan => ({
        id, source, requires, config: this.configValues(id, settings, configSchema)
      }))
    ].filter(({ id }) => Object.hasOwn(settings.plugins, id) && settings.plugins[id]);
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

  configure(settings: Settings, commit = () => {}, beforeChange = () => {}) {
    const ordered = this.plans(settings);
    const desired = new Map(ordered.map((plan) => [plan.id, plan]));
    const affected = new Set([...this.mounted.values()].filter(({ plan }) => !isDeepStrictEqual(plan, desired.get(plan.id))).map(({ plan }) => plan.id));
    for (const plan of ordered) if (plan.requires.some((id) => affected.has(id))) affected.add(plan.id);
    const obsolete = [...this.mounted.values()].map(({ plan }) => plan).filter((plan) => affected.has(plan.id));
    const additions = ordered.filter((plan) => affected.has(plan.id) || !this.mounted.has(plan.id));
    if (!obsolete.length && !additions.length) { commit(); return; }
    beforeChange();
    return this.apply(obsolete, additions, commit);
  }

  private async apply(obsolete: PluginPlan[], additions: PluginPlan[], commit: () => void) {
    const unloaded: PluginPlan[] = [];
    const loaded: string[] = [];
    try {
      for (const plan of obsolete.reverse()) {
        unloaded.unshift(plan);
        await this.unmount(plan.id);
      }
      for (const plan of additions) {
        await this.mount(plan);
        loaded.push(plan.id);
      }
      commit();
    } catch (error) {
      const failures = [];
      for (const id of loaded.reverse()) {
        try { await this.unmount(id); } catch (failure) { failures.push(failure); }
      }
      for (const plan of unloaded) {
        try { await this.mount(plan); } catch (failure) { failures.push(failure); }
      }
      if (failures.length) throw new AggregateError([error, ...failures], 'Could not restore the previous plugin configuration');
      throw error;
    }
  }

  configuration(id: string) { return structuredClone(this.mounted.get(id)?.plan.config ?? {}); }

  private configValues(id: string, settings: Settings, schema?: Record<string, any>) {
    const input = structuredClone(settings.pluginConfig[id] ?? {});
    if (!schema) return input;
    const config = Default(schema, input) as Record<string, unknown>;
    if (!Check(schema, config)) throw new Error('Invalid configuration for plugin: ' + id);
    return config;
  }

  async close() {
    const failures = [];
    for (const id of [...this.mounted.keys()].reverse()) {
      try { await this.unmount(id); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Plugin cleanup failed');
  }
}
