import type {} from 'cordis';
import type { RunInfo } from './transport.js';
import type { MessageContent } from './message.js';
import type { ModelFailure, ModelRequestTransform, ModelRetry, PromptSection, ToolResultTransform } from './extensions.js';

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

export interface OrderedHook<Transform> {
  pluginId: string;
  order: number;
  transform: Transform;
}

declare module 'cordis' {
  interface Events {
    'harness/prompt-sections'(sessionId: string, sections: ScopedPromptSection[]): void;
    'harness/model-request'(sessionId: string, handlers: OrderedHook<ModelRequestTransform>[]): void;
    'harness/tool-result'(sessionId: string, handlers: OrderedHook<ToolResultTransform>[]): void;
    'harness/model-retry'(failure: ModelFailure): ModelRetry | undefined | Promise<ModelRetry | undefined>;
    'harness/observe'(event: CapabilityObservation): void;
    'harness/tool-decision'(request: ToolDecision): 'deny' | undefined | Promise<'deny' | undefined>;
    'harness/tool-projection'(request: ToolProjection, next: () => MessageContent): MessageContent;
  }
}
