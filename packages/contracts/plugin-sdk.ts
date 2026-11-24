import type { Context } from 'cordis';

/** Augment this interface in mini-harness/plugin to declare plugin-owned services. */
export interface ServiceMap extends Pick<Context,
  | 'harnessFileAccess' | 'harnessLlm' | 'harnessModels' | 'harnessNetwork'
  | 'harnessRegistry' | 'harnessPrompt' | 'harnessSessions' | 'harnessTools'> {}

export type { PluginScope, ScopeSettings } from './capabilities.js';
export type { PluginApi, PluginDescriptor } from './plugins.js';
export type { ModelFailure, ModelRequestContent, ModelRequestTransform, ModelRetry, PromptContext, PromptSection, StepContext, ToolResultContext, ToolResultTransform } from './extensions.js';
export type { CapabilityObservation, ToolDecision, ToolProjection } from './events.js';
export type { FileAccessPort, WorkspaceFileAccess } from './files.js';
export type { ProcessExecutionPort, SandboxPort } from './execution.js';
export type { ModelCatalogPort, ModelAdminPort } from './models.js';
export type { LlmPort, LlmRequest, LlmEvent, NativeMessage, NativeAssistantMessage, ToolCallPart } from './llm.js';
export type { ToolDefinition, ToolSchema, ToolResult, ToolContext } from './tools.js';
export { defineTool } from './tools.js';
export type { AgentPort, RunPort, SessionStore } from './services.js';
export type { PromptPort, RunAgentPort, ThinkingLevel } from './agent.js';
export type { SessionLogPort, SessionEntry, SessionEvent, SessionProjection, InboxItem } from './session-log.js';
export type { BrowserPrimitives } from './browser.js';

export { HttpError, HttpReply } from './routes.js';
export type { GatewayRequest, NetworkPort, RouteRequest, UpgradeHandler } from './routes.js';
export type { PluginConfiguration } from './config.js';

export { agentExtensions } from './agent-extensions.js';
export type { InputContext, InputPreparation } from './agent-extensions.js';
export type { InputSource, PreparedMessage } from './input.js';
export { promptExtensions } from './prompt-extensions.js';
export { toolExtensions } from './tool-extensions.js';
export { sessionExtensions } from './session-records.js';
export type { RecordProjection } from './session-records.js';
export { extension } from './contributions.js';
export type { Extension } from './contributions.js';
