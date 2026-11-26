import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import type { InputSource, PreparedMessage } from '@mini-harness/input/message';
import type {
  NativeUserMessage,
  NativeMessage,
  LlmRequest,
  ModelAttemptMetrics,
  ModelRequestContent,
  ModelErrorKind,
} from '@mini-harness/llm/api';

import type { ToolTurn } from '@mini-harness/tools/execution';
import type { ToolResult } from '@mini-harness/tools/api';

export interface StepContext extends ToolTurn {
  readonly sessionId: string;
  readonly cwd?: string;
  readonly phase: 'turn' | 'compaction';
}

type Transform<Value, Input> = (
  value: Value,
  context: Input,
) => Value | undefined | Promise<Value | undefined>;
export type ModelRequestTransform = Transform<ModelRequestContent, StepContext>;

export type RequestRecovery = {
  kind: Extract<ModelErrorKind, 'context-overflow' | 'image-limit'>;
  message: string;
  attempt: number;
};
export interface RequestPreparation extends StepContext {
  readonly runId: string;
  readonly recovery?: RequestRecovery;
  rebuild(messages: NativeMessage[]): Promise<LlmRequest>;
}

export interface ModelFailure {
  readonly model: Readonly<ModelChoice>;
  readonly attempt: number;
  readonly error: string;
  readonly kind?: ModelErrorKind;
  readonly signal: AbortSignal;
}
export type ModelRetry = { delayMs?: number };
export type ModelRetryHandler = (
  failure: ModelFailure & { readonly sessionId: string },
) => ModelRetry | undefined | Promise<ModelRetry | undefined>;

export interface InputContext {
  readonly sessionId: string;
  readonly cwd?: string;
  readonly model: Readonly<ModelChoice>;
  readonly source: InputSource;
  readonly original: Readonly<PreparedMessage>;
  readonly signal: AbortSignal;
}

export type InputPreparation = Transform<NativeUserMessage['content'], InputContext>;

export interface ToolResultContext extends StepContext {
  readonly callId: string;
  readonly tool: string;
}

export type ToolResultTransform = Transform<ToolResult['content'], ToolResultContext>;

declare module 'mini-harness/cordis' {
  interface Events {
    /** Configure capabilities owned by a single Agent run before its first step. */
    'agent/setup'(ctx: Context, sessionId: string, signal: AbortSignal): void | Promise<void>;
    'agent/tool-result': ToolResultTransform;
    'agent/prepare-input': InputPreparation;
    'agent/model-request': ModelRequestTransform;
    /** Prepare or recover the final model-visible request before execution. */
    'agent/prepare-request': Transform<LlmRequest, RequestPreparation>;
    'agent/request-attempt'(sessionId: string, requestId: string, metrics: ModelAttemptMetrics): void;
    'agent/model-retry': ModelRetryHandler;
  }
}
