import { Context, type Fiber } from 'cordis';
import { readdirSync, existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { Check } from 'typebox/value';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { MiniHarnessRuntime } from './agent.js';
import { readJson, type Settings } from './config.js';
import { RouteRegistry, type RouteHandler } from './http.js';
import { todos } from './builtins/todos.js';
import { files } from './builtins/files.js';
import { skills } from './builtins/skills.js';
import { shell } from './builtins/shell.js';
import { subagents } from './builtins/subagents.js';

export interface PluginMetadata {
  id: string;
  title: string;
  description: string;
  trustedCode?: boolean;
  web?: boolean;
  browser?: string;
  icon?: 'files' | 'skills' | 'delegate' | 'terminal';
  preferences?: { key: 'subagents' | 'sandbox'; schema: Record<string, unknown>; groups?: { title: string; fields: string[] }[] };
  requires?: string[];
  configSchema?: Record<string, any>;
}

export interface BuiltinPlugin extends PluginMetadata {
  inject: string[];
  setup(ctx: Context): void;
}

const builtins = [files, skills, subagents, shell, todos];
export const BUILTINS: readonly PluginMetadata[] = builtins.map(({ inject, setup, ...metadata }) => metadata);

export interface PluginApi {
  /** The value comes from settings.pluginConfig[pluginId]. */
  readonly config: Readonly<Record<string, unknown>>;
  defineConfig(defaults: Record<string, unknown>, validate?: (config: Readonly<Record<string, unknown>>) => void): Readonly<Record<string, unknown>>;
  registerTool(tool: ToolDefinition): () => Promise<void>;
  /** Mount an authenticated route under /api/extensions/<plugin-id>/. */
  registerRoute(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, handler: RouteHandler): () => Promise<void>;
  onDispose(cleanup: () => void | Promise<void>): void;
}

type RuntimeServices = {
  paths: MiniHarnessRuntime['paths'];
  settings(): Settings;
  models: { list(): ReturnType<MiniHarnessRuntime['availableModels']> };
  sessions: Pick<MiniHarnessRuntime['registry'], 'get' | 'list'>;
  workspaces: { resolve(id: string): string; approval(id: string, waiting: boolean): void };
  delegation: MiniHarnessRuntime['delegation'];
  todos: { get(id: string): Promise<import('./protocol.js').TodoItem[]>; set(id: string, items: import('./protocol.js').TodoItem[]): Promise<void> };
  publish(id: string, event: import('./protocol.js').StreamEvent): void;
};

declare module 'cordis' {
  interface Context {
    harnessAgent: { availableModels: RuntimeServices['models']['list'] };
    harnessModels: RuntimeServices['models'];
    harnessSessions: RuntimeServices['sessions'];
    harnessTools: ToolRegistry;
    harnessState: { paths: RuntimeServices['paths'] };
    harnessShellPolicy: { get(): Settings['sandbox'] };
    harnessChildPolicy: { get(): Settings['subagents'] };
    harnessRoutes: RouteRegistry;
    harnessDelegation: RuntimeServices['delegation'];
    harnessSkills: { options(cwd: string): ReturnType<typeof import('./skill-sources.js').harnessSkillOptions> };
    harnessWorkspace: RuntimeServices['workspaces'];
    harnessTodos: RuntimeServices['todos'];
    harnessSessionEvents: { publish: RuntimeServices['publish'] };
  }
}

const publicServices = new Set(['harnessAgent', 'harnessModels', 'harnessSessions']);

const reservedTools = new Set(['read', 'edit', 'write', 'grep', 'find', 'ls', 'bash', 'powershell', 'codemode', 'tool_search']);

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

export class ToolRegistry {
  private tools = new Map<string, { bind: (id: string) => ToolDefinition; visible: (id: string) => boolean }>();

  register(tool: ToolDefinition, bind = (_id: string) => tool, visible = (_id: string) => true, builtin = false) {
    const { name } = tool;
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error('Invalid tool name: ' + name);
    if ((!builtin && reservedTools.has(name)) || this.tools.has(name)) throw new Error('Duplicate or reserved tool: ' + name);
    this.tools.set(name, { bind, visible });
    return () => { this.tools.delete(name); };
  }

  forSession(id: string) {
    return this.resources(id).map((tool) => tool.bind(id));
  }

  resources(id: string) { return [...this.tools.values()].filter((tool) => tool.visible(id)); }
}

interface PluginPlan {
  id: string;
  source?: string;
  config?: Record<string, unknown>;
  requires: string[];
}

export class PluginHost {
  readonly ctx = new Context();
  private readonly mounted = new Map<string, { plan: PluginPlan; fiber: Fiber }>();

  constructor(private readonly services: RuntimeServices) {
    this.ctx.provide('harnessState', { paths: services.paths });
    this.ctx.provide('harnessShellPolicy', { get: () => ({ ...services.settings().sandbox }) });
    this.ctx.provide('harnessChildPolicy', { get: () => ({ ...services.settings().subagents }) });
    this.ctx.provide('harnessAgent', { availableModels: services.models.list });
    this.ctx.provide('harnessModels', services.models);
    this.ctx.provide('harnessSessions', services.sessions);
    this.ctx.provide('harnessTools', new ToolRegistry());
    this.ctx.provide('harnessTodos', services.todos);
    this.ctx.provide('harnessSessionEvents', { publish: services.publish });
    this.ctx.provide('harnessRoutes', new RouteRegistry());
    this.ctx.provide('harnessWorkspace', services.workspaces);
    this.ctx.provide('harnessDelegation', services.delegation);
  }

  private discover() {
    const builtins = new Set(BUILTINS.map(({ id }) => id));
    return readdirSync(this.services.paths.plugins, { withFileTypes: true }).flatMap((entry) => {
      const id = entry.name;
      if (!entry.isDirectory() || !/^[a-z][a-z0-9-]{0,63}$/.test(id) || builtins.has(id)) return [];
      const folder = join(this.services.paths.plugins, id);
      const source = join(folder, 'plugin.js');
      if (!existsSync(source) || lstatSync(folder).isSymbolicLink() || !lstatSync(source).isFile() || lstatSync(source).isSymbolicLink()) return [];
      let manifest: Partial<PluginMetadata> | null = null;
      try { manifest = readJson(join(folder, 'plugin.json'), null); }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; }
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

  metadata() { return [...BUILTINS, ...this.discover().map(({ metadata }) => metadata)]; }

  private async mount(plan: PluginPlan) {
    const { id, source } = plan;
    let fiber: Fiber | undefined;
    try {
        const builtin = builtins.find((plugin) => plugin.id === id);
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
            registerTool: (tool) => ctx.effect(() => this.ctx.harnessTools.register(tool)),
            registerRoute: (method, path, handler) => {
              if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ||
                  !/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/.test(path)) throw new Error('Invalid plugin route');
              return ctx.effect(() => this.ctx.harnessRoutes.register(method, '/api/extensions/' + id + path, handler));
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
      ...BUILTINS.map(({ id }): PluginPlan => ({ id, requires: [] })),
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

  needsUpdate(settings: Settings) {
    const next = this.plans(settings);
    return next.length !== this.mounted.size || next.some((plan) => !isDeepStrictEqual(plan, this.mounted.get(plan.id)?.plan));
  }

  async configure(settings: Settings, commit = () => {}) {
    const ordered = this.plans(settings);
    const desired = new Map(ordered.map((plan) => [plan.id, plan]));
    const affected = new Set([...this.mounted.values()].filter(({ plan }) => !isDeepStrictEqual(plan, desired.get(plan.id))).map(({ plan }) => plan.id));
    for (const plan of ordered) if (plan.requires.some((id) => affected.has(id))) affected.add(plan.id);
    const obsolete = [...this.mounted.values()].map(({ plan }) => plan).filter((plan) => affected.has(plan.id));
    const additions = ordered.filter((plan) => affected.has(plan.id) || !this.mounted.has(plan.id));
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

  getTools(id: string) { return this.ctx.harnessTools.forSession(id); }
  resources(id: string) { return [this.ctx.harnessSkills, ...this.ctx.harnessTools.resources(id)]; }

  private configValues(id: string, settings: Settings, schema?: Record<string, any>) {
    const input = structuredClone(settings.pluginConfig[id] ?? {});
    if (!schema) return input;
    const config = configDefaults(schema, input) as Record<string, unknown>;
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
