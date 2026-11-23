import type { Context } from 'cordis';

/** Augment this interface in mini-harness/plugin to declare plugin-owned services. */
export interface ServiceMap extends Pick<Context,
  | 'harnessAgent' | 'harnessApprovals' | 'harnessChanges' | 'harnessConversationView' | 'harnessDelegation'
  | 'harnessFileAccess' | 'harnessLlm' | 'harnessModelAdmin' | 'harnessModels' | 'harnessMutations'
  | 'harnessPluginCatalog' | 'harnessProcess' | 'harnessPrompt' | 'harnessRegistry' | 'harnessRoutes'
  | 'harnessRuns' | 'harnessSandbox' | 'harnessScopes' | 'harnessSessions' | 'harnessSettings'
  | 'harnessSettingsStore' | 'harnessSkills' | 'harnessState' | 'harnessTools' | 'harnessUpdateSettings'
  | 'harnessWorkspaces'> {}

export type { PluginScope, ScopeSettings } from './capabilities.js';
export type { PluginApi, PluginDescriptor } from './plugins.js';
export type { AgentStage, AgentTransform, AgentWaterfalls, ModelFailure, ModelRetry, PromptContext, PromptSection, RecordProjection } from './extensions.js';
export type { CapabilityObservation, ToolDecision, ToolProjection } from './events.js';
export type { FileAccessPort, WorkspaceFileAccess } from './files.js';
export type { ProcessExecutionPort, SandboxPort } from './execution.js';
export type { ModelCatalogPort, ModelAdminPort } from './models.js';
export type { LlmPort, LlmRequest, LlmEvent, NativeMessage, NativeAssistantMessage, ToolCallPart } from './llm.js';
export type { ToolDefinition, ToolSchema, ToolResult, ToolContext } from './tools.js';
export { defineTool } from './tools.js';
export type { SkillPort, Skill } from './skills.js';
export type { AgentPort, RunPort, SessionStore } from './services.js';
export type { PromptPort, RunAgentPort, ThinkingLevel } from './agent.js';
export type { SessionLogPort, SessionEntry, SessionEvent, SessionProjection, InboxItem } from './session-log.js';
export type { BrowserPrimitives } from './browser.js';
