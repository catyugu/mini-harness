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

interface StepContext {
  readonly sessionId: string;
  readonly cwd: string;
  readonly model: Readonly<ModelChoice>;
  readonly turn: number;
  readonly signal: AbortSignal;
}

export interface AgentWaterfalls {
  beforeStep: { context: StepContext; value: NativeMessage[] };
  modelRequest: {
    context: StepContext;
    value: { messages: NativeMessage[]; systemPrompt: string; thinkingLevel?: ThinkingLevel; maxTokens?: number };
  };
  toolResult: {
    context: StepContext & { readonly callId: string; readonly tool: string };
    value: (TextPart | ImagePart)[];
  };
}
export type AgentStage = keyof AgentWaterfalls;
export type AgentTransform<Stage extends AgentStage> = (
  value: AgentWaterfalls[Stage]['value'], context: AgentWaterfalls[Stage]['context']
) => AgentWaterfalls[Stage]['value'] | undefined | Promise<AgentWaterfalls[Stage]['value'] | undefined>;

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
