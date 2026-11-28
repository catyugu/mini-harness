import type { Context } from 'mini-harness/cordis';
import type {
  LlmRequest,
  ModelAttemptMetrics,
  ModelErrorKind,
  ToolCallPart,
  NativeAssistantMessage,
  NativeToolMessage,
} from '@mini-harness/llm/api';
import type { ResolvedTool } from '@mini-harness/tools/api';
import type { ToolExecution, ToolExecutorPort } from '@mini-harness/tools/execution';

type Request = Omit<LlmRequest, 'signal'>;

export interface ModelFailure {
  readonly model: Readonly<LlmRequest['model']>;
  readonly attempt: number;
  readonly error: string;
  readonly kind?: ModelErrorKind;
  readonly signal: AbortSignal;
}
export type ModelRetry = { delayMs?: number };

export interface AgentTurn {
  request: Request;
  executor: ToolExecutorPort;
  tools: ReadonlyMap<string, ResolvedTool>;
  execution?: Omit<ToolExecution, 'signal' | 'deliver'>;
  /** Repair the actual failed request within this turn, or decline recovery. */
  recover?(
    request: LlmRequest,
    failure: ModelFailure,
  ): LlmRequest | undefined | Promise<LlmRequest | undefined>;
  deliver?(result: NativeToolMessage, signal: AbortSignal, call: ToolCallPart): Promise<void>;
}

export type AgentEvent =
  | { type: 'phase'; phase: 'model' | 'tools'; turn: number }
  | { type: 'request'; request: Request }
  | { type: 'model-attempt'; metrics: ModelAttemptMetrics }
  | { type: 'assistant-start' }
  | { type: 'delta'; text: string }
  | { type: 'thinking'; text: string }
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
  /** The caller owns the context and supplies a complete turn. */
  prepare(turn: number): AgentTurn | Promise<AgentTurn>;
  afterTurn?(
    calls: readonly ToolCallPart[],
  ): 'continue' | 'restart' | void | Promise<'continue' | 'restart' | void>;
};

export interface AgentPort {
  run(ctx: Context, input: AgentRun): Promise<NativeAssistantMessage>;
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessAgent: AgentPort;
  }
}
