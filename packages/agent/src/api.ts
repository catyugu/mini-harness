import type { Context } from 'mini-harness/cordis';
import type {
  LlmRequest,
  ModelAttemptMetrics,
  ModelErrorKind,
  NativeAssistantMessage,
  NativeToolMessage,
} from '@mini-harness/llm/api';
import type { ModelFailure, ModelRetry } from './events.ts';
import type { ToolCallPart } from '@mini-harness/llm/api';
import type { ToolDefinition } from '@mini-harness/tools/api';
import type { ToolExecution, ToolExecutorPort } from '@mini-harness/tools/execution';

type Request = Omit<LlmRequest, 'signal'>;

export interface AgentTurn {
  request: Request;
  executor: ToolExecutorPort;
  tools: ReadonlyMap<string, ToolDefinition>;
  execution?: Partial<Omit<ToolExecution, 'signal' | 'deliver'>>;
  deliver?(result: NativeToolMessage, signal: AbortSignal, call: ToolCallPart): Promise<void>;
}

export type AgentEvent =
  | { type: 'phase'; phase: 'model' | 'tools'; turn: number }
  | { type: 'request'; request: Request }
  | { type: 'model-attempt'; metrics: ModelAttemptMetrics }
  | { type: 'assistant-start' }
  | { type: 'delta'; text: string }
  | {
      type: 'assistant';
      message: NativeAssistantMessage;
      diagnostic?: {
        code: 'executor-response' | 'invalid-tool-calls';
        message: NativeAssistantMessage;
      };
    };

export type AgentRun = {
  signal: AbortSignal;
  onEvent?(event: AgentEvent): void;
  retry?(failure: ModelFailure): ModelRetry | undefined | Promise<ModelRetry | undefined>;
} & (
  | { request: Request; tools?: readonly ToolDefinition[] }
  | {
      prepare(turn: number): AgentTurn | Promise<AgentTurn>;
      recover?(
        turn: number,
        error: Extract<ModelErrorKind, 'context-overflow' | 'image-limit'>,
        message: string,
      ): AgentTurn | undefined | Promise<AgentTurn | undefined>;
      afterTurn?(
        calls: readonly ToolCallPart[],
      ): 'continue' | 'restart' | void | Promise<'continue' | 'restart' | void>;
    }
);

export interface AgentPort {
  run(ctx: Context, input: AgentRun): Promise<NativeAssistantMessage>;
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessAgent: AgentPort;
  }
}
