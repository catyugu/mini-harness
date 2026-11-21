import { Context } from 'cordis';
import { Type } from 'typebox';
import { runShell } from './sandbox.js';
import { requireChildDepth, selectChildModel, Semaphore } from './subagents.js';

export const BUILTINS = Object.freeze([
  { id: 'skills', title: 'Skills', description: 'Discover Agent Skills from global and project directories.' },
  { id: 'subagents', title: 'Subagents', description: 'Manage isolated, non-recursive child conversations.' },
  { id: 'shell', title: 'Shell', description: 'Execute commands inside the configured sandbox or explicitly trusted host.' }
]);

export class PluginHost {
  constructor(runtime) {
    this.runtime = runtime;
    this.ctx = new Context();
    this.fibers = [];
    this.tools = new Map();
    this.semaphore = new Semaphore(runtime.settings.subagents.maxParallel);
  }

  // Cordis owns each optional feature's registration and cleanup.
  async activate() {
    const register = (id, setup) => {
      if (!this.runtime.settings.plugins[id]) return;
      this.fibers.push(this.ctx.plugin((ctx) => {
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
    // Cordis performs plugin initialization asynchronously.
    await Promise.all(this.fibers.map((fiber) => fiber.ready).filter(Boolean));
  }

  registerTool(id, tool) {
    if (this.tools.has(id)) throw new Error('Duplicate tool: ' + id);
    this.tools.set(id, tool);
    return () => this.tools.delete(id);
  }

  getTools({ child = false } = {}) {
    return [...this.tools.values()].filter((tool) => !child || tool.name !== 'delegate');
  }

  async close() {
    await Promise.all(this.fibers.splice(0).map((fiber) => fiber.dispose()));
    this.tools.clear();
  }
}
