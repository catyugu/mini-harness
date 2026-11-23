import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ToolPort } from '../contracts/plugins.js';

const reservedTools = new Set(['read', 'edit', 'write', 'grep', 'find', 'ls', 'bash', 'powershell', 'codemode', 'tool_search']);

export class ToolRegistry implements ToolPort {
  private readonly tools = new Map<string, { bind: (id: string) => ToolDefinition; visible: (id: string) => boolean }>();

  register(name: string, bind: (id: string) => ToolDefinition, visible = (_id: string) => true, builtin = false) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error('Invalid tool name: ' + name);
    if ((!builtin && reservedTools.has(name)) || this.tools.has(name)) throw new Error('Duplicate or reserved tool: ' + name);
    const lifetime = new AbortController();
    const active = new Set<Promise<unknown>>();
    const bound = new WeakMap<ToolDefinition, ToolDefinition>();
    this.tools.set(name, { visible, bind(id) {
      const tool = bind(id);
      const existing = bound.get(tool);
      if (existing) return existing;
      const leased: ToolDefinition = {
        ...tool,
        async execute(call, args, signal, update, context) {
          lifetime.signal.throwIfAborted();
          const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
          const work = Promise.resolve(tool.execute(call, args, combined, update, context));
          active.add(work);
          try { return await work; }
          finally { active.delete(work); }
        }
      };
      bound.set(tool, leased);
      return leased;
    } });
    return async () => {
      this.tools.delete(name);
      lifetime.abort(new Error('Tool is no longer available: ' + name));
      await Promise.allSettled(active);
    };
  }

  forSession(id: string) { return this.resources(id).map((tool) => tool.bind(id)); }

  resources(id: string) { return [...this.tools.values()].filter((tool) => tool.visible(id)); }
}
