import { Context, type Fiber } from 'cordis';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { MiniHarnessRuntime } from './agent.js';
import { readJson, type Settings } from './config.js';
import { runShell } from './sandbox.js';

interface PluginMetadata {
  id: string;
  title: string;
  description: string;
  trustedCode?: boolean;
}

export const BUILTINS: readonly PluginMetadata[] = Object.freeze([
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
  }
}

const reservedTools = new Set(['read', 'edit', 'write', 'grep', 'find', 'ls', 'bash', 'powershell', 'codemode', 'tool_search']);

export class ToolRegistry {
  private tools = new Map<string, { bind: (id: string) => ToolDefinition; visible: (id: string) => boolean }>();

  register(tool: ToolDefinition, bind = (_id: string) => tool, visible = (_id: string) => true) {
    const { name } = tool;
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error('Invalid tool name: ' + name);
    if (reservedTools.has(name) || this.tools.has(name)) throw new Error('Duplicate or reserved tool: ' + name);
    this.tools.set(name, { bind, visible });
    return () => { this.tools.delete(name); };
  }

  forSession(id: string) {
    return [...this.tools.values()].filter((tool) => tool.visible(id)).map((tool) => tool.bind(id));
  }
}

export class PluginHost {
  readonly ctx = new Context();
  private readonly fibers: Fiber[] = [];

  constructor(private readonly runtime: MiniHarnessRuntime, private readonly settings: Settings) {
    this.ctx.provide('harnessAgent', { availableModels: () => runtime.availableModels() });
    this.ctx.provide('harnessSessions', {
      get: (id) => runtime.registry.get(id) && { ...runtime.registry.get(id) },
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
      const manifest = readJson<Partial<PluginMetadata> | null>(join(folder, 'plugin.json'), null);
      const title = typeof manifest?.title === 'string' ? manifest.title.slice(0, 100) : id;
      const description = typeof manifest?.description === 'string' ? manifest.description.slice(0, 300) : 'Runs local JavaScript with your user permissions.';
      return [{ source, metadata: { id, title, description, trustedCode: true } }];
    });
  }

  metadata() { return [...BUILTINS, ...this.discover().map(({ metadata }) => metadata)]; }

  private async mount(setup: (ctx: Context) => void | Promise<void>, dependencies = ['harnessAgent', 'harnessSessions', 'harnessTools']) {
    const fiber = this.ctx.inject(dependencies, setup);
    this.fibers.push(fiber);
    await fiber.await();
  }

  async activate() {
    try {
      if (this.settings.plugins.subagents) {
        await this.mount((ctx) => {
          const tool = this.runtime.delegateTool();
          ctx.effect(() => ctx.harnessTools.register(tool, (id) => this.runtime.delegateTool(id),
            (id) => this.runtime.canDelegate(id)));
        });
      }
      if (this.settings.plugins.shell) {
        await this.mount((ctx) => {
          ctx.effect(() => ctx.harnessTools.register(defineTool({
            name: 'sandbox_shell',
            label: 'Shell',
            description: 'Run a shell command in the workspace using the configured execution policy.',
            parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 16000 }) }),
            execute: async (_id, args, signal) => {
              const output = await runShell(args.command, this.runtime.paths.cwd, { ...this.runtime.settings.sandbox, signal, stateDir: this.runtime.paths.home });
              return { content: [{ type: 'text', text: JSON.stringify(output) }], details: output };
            }
          })));
        });
      }
      for (const { source, metadata: { id } } of this.discover()) {
        if (!Object.hasOwn(this.settings.plugins, id) || !this.settings.plugins[id]) continue;
        try {
          const mod = await import(pathToFileURL(source).href);
          const component = mod.default ?? mod.apply;
          const setup = typeof component === 'function' ? component : component?.apply?.bind(component);
          if (typeof setup !== 'function') throw new Error('Expected a setup function or a Cordis component');
          const deps = [...new Set(['harnessTools', ...(component.inject ?? mod.inject ?? [])])];
          if (deps.some((dep) => !['harnessAgent', 'harnessSessions', 'harnessTools'].includes(dep))) {
            throw new Error('Unknown harness service dependency');
          }
          await this.mount(async (ctx) => {
            const values = Object.freeze(structuredClone(this.settings.pluginConfig[id] ?? {}));
            const cleanup = await setup(ctx, {
              config: values,
              defineConfig(defaults, validate) {
                const config = Object.freeze({ ...structuredClone(defaults), ...values });
                validate?.(config);
                return config;
              },
              registerTool: (tool) => ctx.effect(() => ctx.harnessTools.register(tool)),
              onDispose: (dispose) => { ctx.effect(() => dispose); }
            } satisfies PluginApi);
            if (typeof cleanup === 'function') ctx.effect(() => cleanup);
          }, deps);
        } catch (error) {
          throw new Error('Plugin ' + id + ': ' + (error instanceof Error ? error.message : String(error)), { cause: error });
        }
      }
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  getTools(id: string) { return this.ctx.harnessTools.forSession(id); }

  async close() {
    for (const fiber of this.fibers.splice(0).reverse()) await fiber.dispose();
  }
}
