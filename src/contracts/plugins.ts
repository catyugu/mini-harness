import type { ToolDefinition, AgentSession } from '@earendil-works/pi-coding-agent';
import type { Context } from 'cordis';
import type { Paths, Settings } from '../config.js';
import type { RouteHandler, RoutePort } from './routes.js';
import type { Conversation } from './conversation.js';
import type { RunInfo } from './transport.js';
import type { DelegationPort } from './delegation.js';

/** Host-owned capability; features consume this interface without importing a concrete registry. */
export interface ToolPort {
  register(name: string, bind: (id: string) => ToolDefinition, visible?: (id: string) => boolean, builtin?: boolean): () => void;
  forSession(id: string): ToolDefinition[];
  resources(id: string): { bind: (id: string) => ToolDefinition; visible: (id: string) => boolean }[];
}

export interface PluginMetadata {
  id: string;
  title: string;
  description: string;
  trustedCode?: boolean;
  /** False for UI-only/route-only plugins that never mutate active Pi tools or Skills. */
  agentResources?: boolean;
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
    harnessSessions: { get(id: string): Conversation | undefined; list(workspaceId?: string): Conversation[] };
    harnessSettings: () => Settings;
    harnessTools: ToolPort;
    harnessState: { paths: Paths };
    harnessRoutes: RoutePort;
    harnessSkills?: { paths(cwd: string): string[] };
    harnessWorkspace: { resolve(id: string): string };
    harnessSessionChanged: (id: string) => void;
    harnessRevision: { reviseAndStart(id: string, input: {
      sourceEntryId: string; expectedLeafId: string | null; message: string;
      attachments?: import('./input.js').Attachment[]; model?: import('./conversation.js').ModelChoice;
      thinkingLevel?: AgentSession['thinkingLevel'];
    }): Promise<RunInfo> };
    harnessDelegation: DelegationPort;
    harnessApprovals?: { has(sessionId: string): boolean };
  }
}

