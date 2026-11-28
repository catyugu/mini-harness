import type { Context } from 'mini-harness/cordis';
import { scopeTarget } from '@mini-harness/plugin-api/scopes';
import type { AgentEvent, ModelFailure, ModelRetry } from './api.ts';
import type { RecordPresentation, RecordPublisher } from '@mini-harness/sessions/display-record';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import type { InputSource, PreparedMessage } from '@mini-harness/input/message';
import type {
  NativeUserMessage,
  NativeMessage,
  LlmRequest,
  ModelRequestContent,
} from '@mini-harness/llm/api';

import type { ToolTurn } from '@mini-harness/tools/execution';
import type { ToolResult } from '@mini-harness/tools/api';

export interface StepContext extends ToolTurn {
  readonly sessionId: string;
  readonly cwd?: string;
}

type Transform<Value, Input> = (
  value: Value,
  context: Input,
) => Value | undefined | Promise<Value | undefined>;
export type ModelRequestTransform = Transform<ModelRequestContent, StepContext>;

export interface RequestPreparation extends StepContext {
  readonly runId: string;
  readonly context: Context;
  rebuild(messages: NativeMessage[], signal: AbortSignal): Promise<LlmRequest>;
}

export interface RequestRecovery extends RequestPreparation {
  readonly failure: ModelFailure;
}

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
    /** Configure capabilities before the first step. Cleanup is owned by both the Run and contributor. */
    'agent/setup'(
      target: Context,
      sessionId: string,
      signal: AbortSignal,
    ): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
    /** Synchronous observer; presentations belong to the committed assistant message. */
    'agent/records'(event: AgentEvent, sink: RecordPublisher): readonly RecordPresentation[] | void;
    'agent/tool-result': ToolResultTransform;
    'agent/prepare-input': InputPreparation;
    'agent/model-request': ModelRequestTransform;
    /** Prepare the final model-visible request before execution. */
    'agent/prepare-request': Transform<LlmRequest, RequestPreparation>;
    /** Return a replacement request to accept recovery, or undefined to decline it. */
    'agent/recover-request': Transform<LlmRequest, RequestRecovery>;
    'agent/model-retry': ModelRetryHandler;
  }
}

/** Dispatch the same scoped retry policy for every model execution. */
export function modelRetry(ctx: Context, sessionId: string) {
  return async (failure: ModelFailure) => {
    const { signal, ...input } = failure;
    for (const { context, callback } of ctx.events.listeners('agent/model-retry', scopeTarget(ctx))) {
      const retry = await context.fiber.run((signal) => callback({ ...input, sessionId, signal }), signal);
      if (retry !== undefined) return retry;
    }
  };
}
