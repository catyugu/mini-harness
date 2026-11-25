import type { Context } from 'mini-harness/cordis';
import type {
  LlmRequest,
  NativeAssistantMessage,
  NativeMessage,
  NativeToolMessage,
} from '@mini-harness/llm/api';
import type {
  ModelFailure,
  ModelRetry,
  ModelRequestContent,
  StepContext,
  ToolResultContext,
} from './events.ts';
import type { ToolSchema } from '@mini-harness/llm/vocabulary';
import type { ToolCallPart } from '@mini-harness/llm/api';
import type { ToolDefinition, ToolResult } from '@mini-harness/tools/api';

export interface AgentTurn {
  request: Omit<LlmRequest, 'signal'>;
  executor: ToolExecutorPort;
  tools: ReadonlyMap<string, ToolDefinition>;
  context?: Pick<StepContext, 'sessionId' | 'cwd'>;
  /** The untransformed transcript, when a consumer overrides the messages sent to the model. */
  history?: readonly NativeMessage[];
  execution?: Partial<Omit<ToolExecution, 'signal' | 'cwd' | 'deliver'>>;
  /** Persist or transform a model-facing tool result. */
  deliver?(result: NativeToolMessage, signal: AbortSignal, call: ToolCallPart): Promise<NativeToolMessage>;
}

export interface AgentRun {
  signal: AbortSignal;
  messages?: readonly NativeMessage[];
  prepare(turn: number, messages: readonly NativeMessage[]): AgentTurn | Promise<AgentTurn>;
  assistantStart?(): void;
  delta?(text: string): void;
  attemptEnded?(attempt: number, failed: boolean): void;
  retry?(failure: Omit<ModelFailure, 'sessionId'>): Promise<ModelRetry | undefined>;
  assistant?(
    message: NativeAssistantMessage,
    diagnostic?: {
      code: 'executor-response' | 'invalid-tool-calls';
      message: NativeAssistantMessage;
    },
  ): void;
  afterTurn?(
    calls: readonly ToolCallPart[],
  ): 'continue' | 'restart' | void | Promise<'continue' | 'restart' | void>;
}

export interface AgentPort {
  run(ctx: Context, input: AgentRun): Promise<NativeAssistantMessage>;
}

export interface ToolExecution {
  readonly cwd?: string;
  readonly signal: AbortSignal;
  /** Reports a started call and returns the reason to skip it, if any. */
  start(call: ToolCallPart): string | undefined;
  phase(call: ToolCallPart, state: 'approval' | 'running'): void;
  update(call: ToolCallPart, result: ToolResult): void;
  deliver(result: NativeToolMessage, signal: AbortSignal): Promise<void>;
}

export interface ToolExecutorPort {
  present(
    content: ModelRequestContent,
    tools: readonly ToolSchema[],
    context: StepContext,
  ): ModelRequestContent & { tools?: ToolSchema[] };
  interpret(message: NativeAssistantMessage, context: StepContext): NativeAssistantMessage;
  /** Interpret, execute and deliver a result for each call. */
  execute(
    calls: readonly ToolCallPart[],
    tools: ReadonlyMap<string, ToolDefinition>,
    execution: ToolExecution,
  ): Promise<void>;
  result?(
    result: NativeToolMessage,
    context: ToolResultContext,
  ): NativeToolMessage['content'] | Promise<NativeToolMessage['content']>;
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
