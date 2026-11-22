import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { Context } from 'cordis';
import type { Paths, Settings } from './config.js';
import type { RouteHandler, RouteRegistry } from './http.js';
import type { SessionRegistry } from './registry.js';

export interface PluginMetadata {
  id: string;
  title: string;
  description: string;
  trustedCode?: boolean;
  web?: boolean;
  browser?: string;
  icon?: 'files' | 'skills' | 'delegate' | 'terminal' | 'copy' | 'edit';
  preferences?: { key: 'subagents' | 'sandbox'; schema: Record<string, unknown>; groups?: { title: string; fields: string[] }[] };
  requires?: string[];
  configSchema?: Record<string, any>;
}

export interface BuiltinPlugin extends PluginMetadata {
  inject: string[];
  setup?(ctx: Context): void;
}

export interface SessionRecords {
  list(): { id: string; timestamp: string; data: unknown }[];
  append(data: unknown): string;
}

export interface PluginApi {
  /** The value comes from settings.pluginConfig[pluginId]. */
  readonly config: Readonly<Record<string, unknown>>;
  defineConfig(defaults: Record<string, unknown>, validate?: (config: Readonly<Record<string, unknown>>) => void): Readonly<Record<string, unknown>>;
  registerTool(tool: ToolDefinition): () => Promise<void>;
  /** Mount an authenticated route under /api/extensions/<plugin-id>/. */
  registerRoute(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, handler: RouteHandler): () => Promise<void>;
  /** Read and append this plugin's JSON records on the active Pi session branch. */
  records: {
    list(sessionId: string): Promise<ReturnType<SessionRecords['list']>>;
    append(sessionId: string, data: unknown): Promise<string>;
  };
  onDispose(cleanup: () => void | Promise<void>): void;
}

type ListModels = () => { provider: string; id: string; name: string; configured: boolean; thinkingLevels: string[] }[];

declare module 'cordis' {
  interface Context {
    harnessModels: { list: ListModels };
    harnessSessions: Pick<SessionRegistry, 'get' | 'list'>;
    harnessSettings: () => Settings;
    harnessTools: ToolRegistry;
    harnessState: { paths: Paths };
    harnessRoutes: RouteRegistry;
    harnessSkills?: { paths(cwd: string): string[] };
    harnessWorkspace: { resolve(id: string): string };
    harnessSessionChanged: (id: string) => void;
    harnessRevision: { reviseAndStart(id: string, input: {
      sourceEntryId: string; expectedLeafId: string | null; message: string;
      attachments?: import('./input.js').Attachment[]; model?: import('./registry.js').ModelChoice;
      thinkingLevel?: import('./pi-sessions.js').ThinkingLevel;
    }): Promise<import('./protocol.js').RunInfo> };
  }
}

const reservedTools = new Set(['read', 'edit', 'write', 'grep', 'find', 'ls', 'bash', 'powershell', 'codemode', 'tool_search']);

export class ToolRegistry {
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
