import type { ThinkingLevel } from './agent.js';
import type { ModelChoice } from './conversation.js';
import type { NativeMessage, TextPart, ImagePart } from './llm.js';
import type { ToolDefinition } from './tools.js';
import type { SessionRecords } from './plugins.js';

export interface PromptContext {
  sessionId: string;
  cwd: string;
  signal: AbortSignal;
  tools: readonly Omit<ToolDefinition, 'execute' | 'isConcurrencySafe'>[];
}
export interface PromptSection {
  id: string;
  order?: number;
  render(context: PromptContext): string | undefined | Promise<string | undefined>;
}

export interface StepContext {
  readonly sessionId: string;
  readonly cwd: string;
  readonly model: Readonly<ModelChoice>;
  readonly turn: number;
  readonly phase: 'turn' | 'compaction';
  readonly signal: AbortSignal;
}

export interface ModelRequestDraft {
  messages: NativeMessage[];
  systemPrompt: string;
  thinkingLevel?: ThinkingLevel;
  maxTokens?: number;
}

export interface ToolResultContext extends StepContext {
  readonly callId: string;
  readonly tool: string;
}

export type AgentTransform<Value, Context extends StepContext> = (
  value: Value, context: Context
) => Value | undefined | Promise<Value | undefined>;

export type ModelRequestTransform = AgentTransform<ModelRequestDraft, StepContext>;
export type ToolResultTransform = AgentTransform<(TextPart | ImagePart)[], ToolResultContext>;

export interface ModelFailure {
  readonly sessionId: string;
  readonly model: Readonly<ModelChoice>;
  readonly attempt: number;
  readonly error: string;
  readonly signal: AbortSignal;
}
export type ModelRetry = { delayMs?: number };

export interface RecordProjection<State> {
  initial(): State;
  reduce(state: State, record: ReturnType<SessionRecords['list']>[number]): State;
}
