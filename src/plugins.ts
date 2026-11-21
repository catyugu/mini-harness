import { Context, type Fiber } from 'cordis';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { MiniHarnessRuntime } from './agent.js';
import { readJson, type Settings } from './config.js';
import { runShell } from './sandbox.js';
import { Workspace } from './workspace.js';

export interface PluginMetadata {
  id: string;
  title: string;
  description: string;
  trustedCode?: boolean;
  requires?: string[];
}

export const BUILTINS: readonly PluginMetadata[] = Object.freeze([
  { id: 'files', title: 'Workspace files', description: 'Read, search and edit files within the workspace.' },
  { id: 'skills', title: 'Skills', description: 'Discover Agent Skills from home and the workspace.' },
  { id: 'subagents', title: 'Subagents', description: 'Delegate tasks to child conversations.' },
  { id: 'shell', title: 'Shell', description: 'Run commands using the configured execution policy.' }
]);

export interface PluginApi {
  /** The value comes from settings.pluginConfig[pluginId]. */
  readonly config: Readonly<Record<string, unknown>>;
  defineConfig(defaults: Record<string, unknown>, validate?: (config: Readonly<Record<string, unknown>>) => void): Readonly<Record<string, unknown>>;
  registerTool(tool: ToolDefinition): () => Promise<void>;
  onDispose(cleanup: () => void | Promise<void>): void;
}

declare module 'cordis' {
  interface Context {
    harnessAgent: Pick<MiniHarnessRuntime, 'availableModels'>;
    harnessSessions: Pick<MiniHarnessRuntime['registry'], 'get' | 'list'>;
    harnessTools: ToolRegistry;
    harnessConfig: { get(): Settings; paths: MiniHarnessRuntime['paths'] };
    harnessRuntime: MiniHarnessRuntime;
    harnessSkills: { paths: string[] };
  }
}

const reservedTools = new Set(['read', 'edit', 'write', 'grep', 'find', 'ls', 'bash', 'powershell', 'codemode', 'tool_search']);

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
    return [...this.tools.values()].filter((tool) => tool.visible(id)).map((tool) => tool.bind(id));
  }
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

  constructor(private readonly runtime: MiniHarnessRuntime) {
    this.ctx.provide('harnessConfig', { get: () => structuredClone(runtime.settings), paths: runtime.paths });
    this.ctx.provide('harnessRuntime', runtime);
    this.ctx.provide('harnessAgent', { availableModels: () => runtime.availableModels() });
    this.ctx.provide('harnessSessions', {
      get: (id) => runtime.registry.get(id),
      list: () => runtime.registry.list()
    });
    this.ctx.provide('harnessTools', new ToolRegistry());
  }

  private discover() {
    const builtins = new Set(BUILTINS.map(({ id }) => id));
    return readdirSync(this.runtime.paths.plugins, { withFileTypes: true }).flatMap((entry) => {
      const id = entry.name;
      if (!entry.isDirectory() || !/^[a-z][a-z0-9-]{0,63}$/.test(id) || builtins.has(id)) return [];
      const folder = join(this.runtime.paths.plugins, id);
      const source = join(folder, 'plugin.js');
      if (!existsSync(source)) return [];
      let manifest: Partial<PluginMetadata> | null = null;
      try { manifest = readJson(join(folder, 'plugin.json'), null); }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      const title = typeof manifest?.title === 'string' ? manifest.title.slice(0, 100) : id;
      const description = typeof manifest?.description === 'string' ? manifest.description.slice(0, 300) : 'Runs local JavaScript with your user permissions.';
      const requires = manifest?.requires ?? [];
      if (!Array.isArray(requires) || requires.some((id) => typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(id)))
        throw new Error('Invalid plugin dependencies: ' + id);
      return [{ source, metadata: { id, title, description, requires, trustedCode: true } }];
    });
  }

  metadata() { return [...BUILTINS, ...this.discover().map(({ metadata }) => metadata)]; }

  private builtin(id: string) {
    const runtime = this.runtime;
    const setup = {
      files: (ctx: Context) => {
        for (const tool of new Workspace(runtime.paths.cwd, runtime.paths.home).tools())
          ctx.effect(() => ctx.harnessTools.register(tool, undefined, undefined, true));
      },
      skills: (ctx: Context) => { ctx.provide('harnessSkills', { paths: [runtime.paths.skills, runtime.paths.projectSkills] }); },
      subagents: (ctx: Context) => {
        ctx.effect(() => ctx.harnessTools.register(runtime.delegateTool(), (sessionId) => runtime.delegateTool(sessionId),
          (sessionId) => runtime.canDelegate(sessionId)));
      },
      shell: (ctx: Context) => {
        ctx.effect(() => ctx.harnessTools.register(defineTool({
          name: 'sandbox_shell', label: 'Shell',
          description: 'Run a shell command in the workspace using the configured execution policy.',
          parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 16000 }) }),
          execute: async (_id, args, signal) => {
            const output = await runShell(args.command, runtime.paths.cwd, {
              ...runtime.settings.sandbox, signal, stateDir: runtime.paths.home
            });
            return { content: [{ type: 'text', text: JSON.stringify(output) }], details: output };
          }
        })));
      }
    }[id];
    return setup && { inject: ['harnessTools'], setup };
  }

  private async mount(plan: PluginPlan) {
    const { id, source } = plan;
    let fiber: Fiber | undefined;
    try {
        const builtin = this.builtin(id);
        const mod = builtin ? undefined : await import(pathToFileURL(source).href);
        const component = builtin ?? mod.default ?? mod.apply;
        const setup = builtin?.setup ?? (typeof component === 'function' ? component : component?.apply?.bind(component));
        if (typeof setup !== 'function') throw new Error('Expected a setup function or a Cordis component');
        const deps = [...new Set<string>(component.inject ?? mod.inject ?? [])];
        if (deps.some((dep) => !['harnessAgent', 'harnessSessions', 'harnessConfig', 'harnessTools', 'harnessRuntime'].includes(dep)))
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

  async configure(settings: Settings, commit = () => {}) {
    const next = [
      ...BUILTINS.map(({ id }): PluginPlan => ({ id, requires: [] })),
      ...this.discover().map(({ source, metadata: { id, requires } }): PluginPlan => ({
        id, source, requires, config: Object.hasOwn(settings.pluginConfig, id) ? settings.pluginConfig[id] : undefined
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

  getTools(id: string) { return this.ctx.harnessTools.forSession(id); }

  async close() {
    const failures = [];
    for (const id of [...this.mounted.keys()].reverse()) {
      try { await this.unmount(id); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Plugin cleanup failed');
  }
}
