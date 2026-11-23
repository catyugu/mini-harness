import type {} from 'cordis';
import type { ModelChoice } from './conversation.js';
import type { ThinkingLevel } from './agent.js';
import type { ToolSchema } from './tools.js';

/** Harness-owned transcript. Provider details stay opaque outside the adapter. */
export interface TextPart { type: 'text'; text: string; textSignature?: string }
export interface ImagePart { type: 'image'; data: string; mimeType: string }
export interface ThinkingPart { type: 'thinking'; thinking: string; thinkingSignature?: string; redacted?: boolean }
export interface ToolCallPart {
  type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown>;
  thoughtSignature?: string; namespace?: string; argumentsError?: string;
}
export type NativeContent = TextPart | ImagePart | ThinkingPart | ToolCallPart;
export interface NativeUsage {
  input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
  cacheWrite1h?: number; reasoning?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; totalFromProvider?: boolean };
}
export interface NativeUserMessage { role: 'user'; content: string | (TextPart | ImagePart)[]; timestamp: number }
export interface NativeAssistantMessage {
  role: 'assistant'; content: (TextPart | ThinkingPart | ToolCallPart)[]; timestamp: number;
  provider?: string; model?: string; usage?: NativeUsage;
  stopReason?: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted';
  errorMessage?: string;
  /** JSON-only continuation/signature metadata interpreted exclusively by the LLM adapter. */
  providerData?: Record<string, unknown>;
}
export interface NativeToolMessage {
  role: 'toolResult'; toolCallId: string; toolName: string;
  content: (TextPart | ImagePart)[]; timestamp: number; isError: boolean;
  details?: Record<string, unknown>; elapsedMs?: number;
}
export type NativeMessage = NativeUserMessage | NativeAssistantMessage | NativeToolMessage;
export interface LlmRequest {
  model: ModelChoice;
  systemPrompt: string;
  messages: NativeMessage[];
  tools?: ToolSchema[];
  thinkingLevel?: ThinkingLevel;
  signal: AbortSignal;
  sessionId?: string;
  maxTokens?: number;
}
export type LlmEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'thinking-delta'; text: string }
  | { type: 'tool-call'; call: ToolCallPart }
  | { type: 'done'; message: NativeAssistantMessage };
export interface LlmPort { stream(request: LlmRequest): AsyncIterable<LlmEvent> }

declare module 'cordis' {
  interface Context { harnessLlm: LlmPort }
}
