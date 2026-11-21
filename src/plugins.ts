import { Context } from 'cordis';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Type } from 'typebox';
import { runShell } from './sandbox.js';
import { requireChildDepth, selectChildModel, Semaphore } from './subagents.js';

export const BUILTINS = Object.freeze([
  { id: 'skills', title: 'Skills', description: 'Discover Agent Skills from global and project directories.' },
  { id: 'subagents', title: 'Subagents', description: 'Manage isolated, non-recursive child conversations.' },
  { id: 'shell', title: 'Shell', description: 'Execute commands inside the configured sandbox or explicitly trusted host.' }
]);

export class PluginHost {
  runtime: any;
  ctx: Context;
  fibers: any[];
  tools: Map<string, any>;
  semaphore: Semaphore;
  constructor(runtime: any) {
    this.runtime = runtime;
    this.ctx = new Context();
    this.fibers = [];
    this.tools = new Map();
    this.semaphore = new Semaphore(runtime.settings.subagents.maxParallel);
  }

  // Cordis owns each optional feature's registration and cleanup.
  async activate() {
    const register = (id: string, setup: () => () => void) => {
      if (!this.runtime.settings.plugins[id]) return;
      this.fibers.push(this.ctx.plugin((ctx: Context) => {
        ctx.effect(() => setup());
      }));
    };
    register('subagents', () => this.registerTool('delegate', {
      name: 'delegate',
      label: 'Delegate',
      description: 'Create a child agent to handle a specific task. Child agents cannot create further agents. Provide provider/model only if you intentionally want to override the default.',
      parameters: Type.Object({
        task: Type.String({ minLength: 1, maxLength: 12000 }),
        provider: Type.Optional(Type.String()),
        model: Type.Optional(Type.String())
      }),
      execute: async (_id, args, signal) => {
        const result = await this.semaphore.run(async () => {
          const parent = this.runtime.currentTaskParent;
          if (!parent) throw new Error('No parent conversation');
          requireChildDepth(parent.depth);
          const chosen = selectChildModel(args, this.runtime.settings.subagents, parent.model);
          return this.runtime.runChild(parent.id, args.task, chosen, signal);
        }, signal);
        return { content: [{ type: 'text', text: result.text }], details: { sessionId: result.id } };
      }
    }));
    register('shell', () => this.registerTool('sandbox_shell', {
      name: 'sandbox_shell',
      label: 'Shell',
      description: 'Run a shell command in the workspace, subject to the configured sandbox policy.',
      parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 16000 }) }),
      execute: async (_id, args, signal) => {
        const output = await runShell(args.command, this.runtime.paths.cwd, {
          mode: this.runtime.settings.sandbox.mode,
          timeoutSeconds: this.runtime.settings.sandbox.timeoutSeconds,
          signal
        });
        return { content: [{ type: 'text', text: JSON.stringify(output) }] };
      }
    }));
    // External plugin code is trusted executable JavaScript. Only explicitly enabled modules load.
    for (const entry of readdirSync(this.runtime.paths.plugins, { withFileTypes: true })) {
      if (!entry.isDirectory() || !this.runtime.settings.plugins[entry.name]) continue;
      const source = join(this.runtime.paths.plugins, entry.name, 'plugin.js');
      if (!existsSync(source)) continue;
      const mod = await import(pathToFileURL(source).href);
      const load = mod.default ?? mod.apply;
      if (typeof load !== 'function') throw new Error('Invalid plugin: ' + entry.name);
      this.fibers.push(this.ctx.plugin((ctx: Context) => load(ctx, {
        registerTool: (tool: any) => ctx.effect(() => this.registerTool(entry.name + ':' + tool.name, tool))
      })));
    }
    await Promise.all(this.fibers.map((fiber) => fiber.inertia).filter(Boolean));
  }

  registerTool(id: string, tool: any) {
    if (this.tools.has(id)) throw new Error('Duplicate tool: ' + id);
    this.tools.set(id, tool);
    return () => this.tools.delete(id);
  }

  getTools({ child = false, id }: {child?:boolean; id?:string} = {}) {
    return [...this.tools.values()].filter((tool) => !child || tool.name !== 'delegate').map((tool) => {
      if (tool.name !== 'delegate') return tool;
      // Bind delegation to its owning session, never to global mutable request state.
      return { ...tool, execute: async (_callId, args, signal) => {
        if (!id) throw new Error('Delegate has no owning session');
        const record = this.runtime.registry.get(id);
        if (!record) throw new Error('Parent conversation not found');
        requireChildDepth(record.parentId ? 1 : 0);
        const parent = this.runtime.openSessions.get(id);
        if (!parent) throw new Error('Parent session not open');
        const chosen = selectChildModel(args, this.runtime.settings.subagents, this.runtime.modelInfo(parent.model));
        const result = await this.semaphore.run(() => this.runtime.runChild(id, args.task, chosen, signal), signal);
        return { content: [{ type: 'text', text: result.text }], details: { sessionId: result.id } };
      } };
    });
  }

  async close() {
    await Promise.all(this.fibers.splice(0).map((fiber) => fiber.dispose()));
    this.tools.clear();
  }
}
