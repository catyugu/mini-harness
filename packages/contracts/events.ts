import type {} from 'cordis';
import type { RunInfo } from './transport.js';
import type { MessageContent } from './message.js';
import type { AgentStage, AgentTransform, ModelFailure, ModelRetry, PromptSection } from './extensions.js';

export type CapabilityObservation =
  | { type: 'session-created'; sessionId: string }
  | { type: 'session-deleted'; sessionId: string; scopeKeys: readonly string[] }
  | { type: 'run-started' | 'run-ended'; sessionId: string; run: RunInfo }
  | { type: 'step-started'; sessionId: string; turn: number }
  | { type: 'model-attempt-ended'; sessionId: string; attempt: number; failed: boolean }
  | { type: 'tool-ended'; sessionId: string; tool: string; callId: string; failed: boolean; elapsedMs?: number };

export interface ToolDecision {
  sessionId: string;
  tool: string;
  callId: string;
  arguments: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
}

export interface ToolProjection {
  sessionId: string;
  tool: string;
  content: MessageContent;
}

export interface ScopedPromptSection extends PromptSection {
  depth: number;
  pluginId: string;
}

export interface WaterfallHandler<Stage extends AgentStage> {
  pluginId: string;
  order: number;
  transform: AgentTransform<Stage>;
}

declare module 'cordis' {
  interface Events {
    'harness/prompt-sections'(sessionId: string, sections: ScopedPromptSection[]): void;
    'harness/agent-waterfall'<Stage extends AgentStage>(sessionId: string, stage: Stage, handlers: WaterfallHandler<Stage>[]): void;
    'harness/model-retry'(failure: ModelFailure): ModelRetry | undefined | Promise<ModelRetry | undefined>;
    'harness/observe'(event: CapabilityObservation): void;
    'harness/tool-decision'(request: ToolDecision): 'deny' | undefined | Promise<'deny' | undefined>;
    'harness/tool-projection'(request: ToolProjection, next: () => MessageContent): MessageContent;
  }
}
