import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ToolDecision } from '../contracts/events.js';
import type { ToolPort } from '../contracts/plugins.js';

const reservedTools = new Set(['read', 'edit', 'write', 'grep', 'find', 'ls', 'bash', 'powershell', 'codemode', 'tool_search']);

interface ToolRegistration {
  name: string;
  scope?: string;
  bind(id: string): ToolDefinition;
  visible(id: string): boolean;
}

export class ToolRegistry implements ToolPort {
  private readonly tools = new Map<string, ToolRegistration>();

  constructor(private readonly address: (id: string) => readonly string[] = () => [],
    private readonly decide?: (request: ToolDecision) => Promise<'deny' | undefined>,
    private readonly allowed: (id: string, tool: string) => boolean = () => true) {}

  register(name: string, bind: (id: string) => ToolDefinition, visible = (_id: string) => true, builtin = false, scope?: string) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error('Invalid tool name: ' + name);
    const key = (scope ?? '') + '/' + name;
    if ((!builtin && reservedTools.has(name)) || this.tools.has(key)) throw new Error('Duplicate or reserved tool: ' + name);
    const lifetime = new AbortController();
    const active = new Set<Promise<unknown>>();
    const decide = this.decide;
    const allowed = this.allowed;
    const entry = { name, scope, visible, bind(id: string) {
      const tool = bind(id);
      const leased: ToolDefinition = {
        ...tool,
        async execute(call, args, signal, update, context) {
          lifetime.signal.throwIfAborted();
          const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
          const work = Promise.resolve().then(async () => {
            if (!allowed(id, name) || await decide?.({ sessionId: id, tool: name, signal: combined }) === 'deny')
              throw new Error('Tool denied by plugin policy: ' + name);
            combined.throwIfAborted();
            return tool.execute(call, args, combined, update, context);
          });
          active.add(work);
          try { return await work; }
          finally { active.delete(work); }
        }
      };
      return leased;
    } };
    this.tools.set(key, entry);
    return async () => {
      if (this.tools.get(key) === entry) this.tools.delete(key);
      lifetime.abort(new Error('Tool is no longer available: ' + name));
      await Promise.allSettled(active);
    };
  }

  forSession(id: string) { return this.resources(id).map((tool) => tool.bind(id)); }

  resources(id: string) {
    const ancestry = this.address(id);
    const visible = new Map<string, ToolRegistration>();
    const level = (scope?: string) => scope === undefined ? 0 : ancestry.indexOf(scope) + 1;
    for (const tool of this.tools.values()) {
      if (tool.scope && !ancestry.includes(tool.scope) || !tool.visible(id) || !this.allowed(id, tool.name)) continue;
      const current = visible.get(tool.name);
      if (!current || level(tool.scope) > level(current.scope)) visible.set(tool.name, tool);
    }
    return [...visible.values()];
  }
}
