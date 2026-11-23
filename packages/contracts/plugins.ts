import type { ToolDefinition } from './tools.js';
import type { SkillPort } from './skills.js';
import type { Context } from 'cordis';
import type { Paths, Settings } from './config.js';
import type { RouteHandler, RoutePort } from './routes.js';
import type { SessionRecord } from './conversation.js';
import type { CapabilityObservation, ToolDecision, ToolProjection } from './events.js';
import type { MessageContent } from './message.js';
import type { PluginScope } from './capabilities.js';
import type { DelegationPort } from './delegation.js';
import type { ServiceMap } from './plugin-sdk.js';
import type { ModelFailure, ModelRequestTransform, ModelRetry, PromptSection, RecordProjection, ToolResultTransform } from './extensions.js';

/** Host-owned capability; features consume this interface without importing a concrete registry. */
export interface ToolPort {
  register(name: string, bind: (id: string) => ToolDefinition, visible?: (id: string) => boolean, scope?: string): () => void | Promise<void>;
  forSession(id: string): ToolDefinition[];
}

/** A symbolic icon name or an inline SVG path for plugin-defined artwork. */
export type PluginIcon = string | { path: string; viewBox?: string };

export interface PluginMetadata {
  id: string;
  scope?: PluginScope['kind'];
  title: string;
  description: string;
  trustedCode?: boolean;
  package?: { name: string; version: string };
  /** An installed but unusable plugin must never prevent the host from starting. */
  error?: string;
  state?: 'discovered' | 'ready' | 'draining' | 'failed';
  defaultEnabled?: boolean;
  web?: boolean;
  browser?: string;
  icon?: PluginIcon;
  configGroups?: { title: string; fields: string[] }[];
  configHint?: string;
  requires?: string[];
  configSchema?: Record<string, any>;
}

export interface PluginDescriptor extends PluginMetadata {
  scope: PluginScope['kind'];
  required?: boolean;
  /** Keep an existing scheduler while it consumes committed policy for new work. */
  configChanges?: 'read-on-use';
  provides?: string[];
  inject?: string[];
  optional?: string[];
  browserRequires?: string[];
  browserInject?: string[];
  browserProvides?: string[];
  setup?(ctx: Context, api: PluginApi): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}

export interface SessionRecords {
  list(): { id: string; timestamp: string; data: unknown }[];
  append(data: unknown): Promise<string>;
}

export interface PluginApi {
  /** The value comes from settings.pluginConfig[pluginId]. */
  readonly config: Readonly<Record<string, unknown>>;
  readonly scope: PluginScope;
  readonly signal: AbortSignal;
  provide<Name extends keyof ServiceMap & string>(name: Name, service: ServiceMap[Name]): void;
  service<Name extends keyof ServiceMap & string>(name: Name): NonNullable<ServiceMap[Name]>;
  optionalService<Name extends keyof ServiceMap & string>(name: Name): ServiceMap[Name] | undefined;
  observe(handler: (event: CapabilityObservation) => void | Promise<void>): () => void;
  decideTool(handler: (request: ToolDecision) => 'deny' | undefined | Promise<'deny' | undefined>): () => void;
  promptSection(section: PromptSection): () => void;
  modelRequest(handler: ModelRequestTransform, order?: number): () => void;
  toolResult(handler: ToolResultTransform, order?: number): () => void;
  retryModel(handler: (failure: ModelFailure) => ModelRetry | undefined | Promise<ModelRetry | undefined>): () => void;
  registerProjection<State>(projection: RecordProjection<State>): {
    read(sessionId: string): Promise<State>;
    dispose(): void;
  };
  transformTool(handler: (projection: ToolProjection) => MessageContent): () => void;
  registerTool(tool: ToolDefinition): () => Promise<void>;
  /** Mount an authenticated route under /api/extensions/<plugin-id>/. */
  registerRoute(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, handler: RouteHandler): () => Promise<void>;
  /** Read and append this plugin's JSON records on the active session branch. */
  records: {
    list(sessionId: string): Promise<ReturnType<SessionRecords['list']>>;
    append(sessionId: string, data: unknown): Promise<string>;
  };
  onDispose(cleanup: () => void | Promise<void>): () => Promise<void>;
}

declare module 'cordis' {
  interface Context {
    harnessSessions: { get(id: string): SessionRecord | undefined; list(workspaceId?: string): SessionRecord[] };
    harnessSettings: () => Settings;
    harnessTools: ToolPort;
    harnessState: { paths: Paths };
    harnessRoutes: RoutePort;
    harnessSkills?: SkillPort;
    harnessDelegation?: DelegationPort;

  }
}

