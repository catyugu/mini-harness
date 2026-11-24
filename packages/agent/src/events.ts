import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import type { InputSource, PreparedMessage } from '@mini-harness/input/message';
import type { NativeUserMessage, LlmRequest } from '@mini-harness/llm/api';

import type { ToolResult } from '@mini-harness/tools/api';

export interface StepContext {
  readonly sessionId: string;
  readonly cwd: string;
  readonly model: Readonly<ModelChoice>;
  readonly turn: number;
  readonly phase: 'turn' | 'compaction';
  readonly signal: AbortSignal;
}

export type ModelRequestContent = Pick<LlmRequest, 'messages' | 'systemPrompt' | 'thinkingLevel' | 'maxTokens'>;

type Transform<Value, Input> = (value: Value, context: Input) => Value | undefined | Promise<Value | undefined>;
export type ModelRequestTransform = Transform<ModelRequestContent, StepContext>;

export interface ModelFailure {
  readonly sessionId: string;
  readonly model: Readonly<ModelChoice>;
  readonly attempt: number;
  readonly error: string;
  readonly signal: AbortSignal;
}
export type ModelRetry = { delayMs?: number };
export type ModelRetryHandler = (failure: ModelFailure) => ModelRetry | undefined | Promise<ModelRetry | undefined>;

export interface InputContext {
  readonly sessionId: string;
  readonly cwd: string;
  readonly model: Readonly<ModelChoice>;
  readonly source: InputSource;
  readonly original: Readonly<PreparedMessage>;
  readonly signal: AbortSignal;
}

export type InputPreparation = (content: NativeUserMessage['content'], context: InputContext) =>
  NativeUserMessage['content'] | { reject: string } | undefined |
  Promise<NativeUserMessage['content'] | { reject: string } | undefined>;

export interface ToolResultContext extends StepContext {
  readonly callId: string;
  readonly tool: string;
}

export type ToolResultTransform = Transform<ToolResult['content'], ToolResultContext>;

declare module 'mini-harness/cordis' {
  interface Events {
    'agent/tool-result': ToolResultTransform;
    'agent/prepare-input': InputPreparation;
    'agent/model-request': ModelRequestTransform;
    'agent/model-retry': ModelRetryHandler;
  }
}

declare module '@mini-harness/plugin-api/observations' {
  interface CapabilityObservations {
    'step-started': { type: 'step-started'; sessionId: string; turn: number };
    'model-attempt-ended': { type: 'model-attempt-ended'; sessionId: string; attempt: number; failed: boolean };
    'tool-ended': { type: 'tool-ended'; sessionId: string; tool: string; callId: string; failed: boolean; elapsedMs?: number };
  }
}
