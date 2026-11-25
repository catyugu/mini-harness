import type { Context } from 'mini-harness/cordis';
import type {
  LlmRequest,
  NativeAssistantMessage,
  NativeMessage,
  NativeToolMessage,
} from '@mini-harness/llm/api';
import type { ModelFailure, ModelRetry, ModelRequestContent } from './events.ts';
import type { ToolSchema } from '@mini-harness/llm/vocabulary';
import type { ToolCallPart } from '@mini-harness/llm/api';
import type { ToolDefinition, ToolUpdate } from '@mini-harness/tools/api';

type Request = Omit<LlmRequest, 'signal'>;

export interface AgentTurn {
  request: Request;
  executor: ToolExecutorPort;
  tools: ReadonlyMap<string, ToolDefinition>;
  execution?: Partial<Omit<ToolExecution, 'signal' | 'deliver'>>;
  deliver?(result: NativeToolMessage, signal: AbortSignal, call: ToolCallPart): Promise<void>;
}

export type AgentEvent =
  | { type: 'request'; request: Request }
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
      afterTurn?(
        calls: readonly ToolCallPart[],
      ): 'continue' | 'restart' | void | Promise<'continue' | 'restart' | void>;
    }
);

export interface ToolTurn {
  readonly model: LlmRequest['model'];
  readonly turn: number;
  readonly signal: AbortSignal;
}

export interface AgentPort {
  run(ctx: Context, input: AgentRun): Promise<NativeAssistantMessage>;
}

export interface ToolExecution {
  readonly signal: AbortSignal;
  /** Reports a started call and returns the reason to skip it, if any. */
  start?(call: ToolCallPart): string | undefined;
  update?(call: ToolCallPart, result: ToolUpdate): void;
  deliver(result: NativeToolMessage, signal: AbortSignal): Promise<void>;
}

export interface ToolExecutorPort {
  present(
    content: ModelRequestContent,
    tools: readonly ToolSchema[],
    context: ToolTurn,
  ): ModelRequestContent & { tools?: ToolSchema[] };
  interpret(message: NativeAssistantMessage, context: ToolTurn): NativeAssistantMessage;
  /** Interpret, execute and deliver a result for each call. */
  execute(
    calls: readonly ToolCallPart[],
    tools: ReadonlyMap<string, ToolDefinition>,
    execution: ToolExecution,
  ): Promise<void>;
}

export interface CompactionInput {
  messages: NativeMessage[];
  /** The first message is a prior summary when this is true. */
  summarized?: boolean;
  automatic: boolean;
  signal: AbortSignal;
  request(content: ModelRequestContent): Promise<NativeAssistantMessage>;
}

export interface CompactionResult {
  summary: string;
  keepFromIndex: number;
  tokensBefore?: number;
}

export interface CompactionPort {
  shouldCompact(messages: NativeMessage[], budget: number): boolean;
  compact(input: CompactionInput): Promise<CompactionResult | undefined>;
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessAgent: AgentPort;
    harnessToolExecutor: ToolExecutorPort;
    harnessCompaction: CompactionPort;
  }
}
