import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ToolPort } from '../../src/contracts/plugins.js';

const reservedTools = new Set(['read', 'edit', 'write', 'grep', 'find', 'ls', 'bash', 'powershell', 'codemode', 'tool_search']);

export class ToolRegistry implements ToolPort {
  private tools = new Map<string, { bind: (id: string) => ToolDefinition; visible: (id: string) => boolean }>();

  register(name: string, bind: (id: string) => ToolDefinition, visible = (_id: string) => true, builtin = false) {
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
