import type { Context } from 'cordis';

/** Augment this interface in mini-harness/plugin to declare plugin-owned services. */
export interface ServiceMap extends Pick<Context,
  | 'harnessFileAccess' | 'harnessLlm' | 'harnessModels' | 'harnessNetwork'
  | 'harnessProcess' | 'harnessPrompt' | 'harnessSandbox' | 'harnessSessions' | 'harnessTools'> {}

export type { PluginScope, ScopeSettings } from './capabilities.js';
export type { PluginApi, PluginDescriptor, ConfigValidationContext } from './plugins.js';
export type { InputContext, InputPreparation, ModelFailure, ModelRequestContent, ModelRequestTransform, ModelRetry, StepContext } from './agent-extensions.js';
export type { PromptContext, PromptSection } from './prompt-extensions.js';
export type { ToolDecision, ToolProjection, ToolResultContext, ToolResultTransform } from './tool-extensions.js';
export type { CapabilityObservation } from './events.js';
export type { FileAccessPort, WorkspaceFileAccess } from './files.js';
export type { ProcessExecutionPort, SandboxPort } from './execution.js';
export type { ModelCatalogPort, ModelSummary, ProviderModel } from './models.js';
export type { LlmPort, LlmRequest, LlmEvent, NativeMessage, NativeAssistantMessage, ToolCallPart } from './llm.js';
export type { ToolDefinition, ToolSchema, ToolResult, ToolContext, ToolRegistrationOptions } from './tools.js';
export { defineTool } from './tools.js';
export type { PromptPort, ThinkingLevel } from './agent.js';

export { HttpError, HttpReply } from './routes.js';
export type { GatewayRequest, NetworkPort, RouteRequest, UpgradeHandler } from './routes.js';
export type { PluginConfiguration } from './config.js';

export { agentExtensions } from './agent-extensions.js';
export type { InputSource, PreparedMessage } from './input.js';
export { promptExtensions } from './prompt-extensions.js';
export { toolExtensions } from './tool-extensions.js';
export { sessionExtensions } from './session-records.js';
export type { RecordProjection, SessionRecords } from './session-records.js';
export { extension } from './contributions.js';
export type { Extension } from './contributions.js';
