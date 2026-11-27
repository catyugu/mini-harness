import type { ModelChoice, ThinkingLevel, ToolSchema } from './vocabulary.ts';

/** Harness-owned transcript. Provider details stay opaque outside the adapter. */
export interface TextPart {
  type: 'text';
  text: string;
  textSignature?: string;
}
export interface ImagePart {
  type: 'image';
  data: string;
  mimeType: string;
}
export interface ThinkingPart {
  type: 'thinking';
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}
export interface ToolCallPart {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
  namespace?: string;
  argumentsError?: string;
}
export type NativeContent = TextPart | ImagePart | ThinkingPart | ToolCallPart;
export interface NativeUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cacheWriteSupported?: true;
  cacheWrite1h?: number;
  reasoning?: number;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
    totalFromProvider?: boolean;
  };
}
export interface NativeUserMessage {
  role: 'user';
  content: string | (TextPart | ImagePart)[];
  timestamp: number;
}
export type ModelErrorKind = 'context-overflow' | 'image-limit' | 'transient' | 'permanent';

export interface InputTokenCounts {
  system: number;
  tools: number;
  messages: number;
}

/** Counts and usable input capacity for a prepared model request. */
export interface InputMeasurement extends InputTokenCounts {
  window: number;
  budget: number;
  estimated: boolean;
}

export interface ModelAttemptMetrics {
  elapsedMs: number;
  firstTokenMs?: number;
  usage?: NativeUsage;
}

export interface NativeAssistantMessage {
  role: 'assistant';
  content: (TextPart | ThinkingPart | ToolCallPart)[];
  timestamp: number;
  provider?: string;
  model?: string;
  usage?: NativeUsage;
  stopReason?: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted';
  errorMessage?: string;
  errorKind?: ModelErrorKind;
  /** JSON-only continuation/signature metadata interpreted exclusively by the LLM adapter. */
  providerData?: Record<string, unknown>;
}
export interface NativeToolMessage {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: (TextPart | ImagePart)[];
  timestamp: number;
  isError: boolean;
  /** Non-success disposition distinct from an execution failure. */
  outcome?: 'skipped' | 'denied' | 'cancelled';
  details?: Record<string, unknown>;
  /** Fields of details selected by the producing tool for its consumers' presentation. */
  detailKeys?: readonly string[];
  elapsedMs?: number;
}
export type NativeMessage = NativeUserMessage | NativeAssistantMessage | NativeToolMessage;
export interface LlmRequest {
  model: ModelChoice;
  systemPrompt: string;
  messages: NativeMessage[];
  tools?: ToolSchema[];
  thinkingLevel?: ThinkingLevel;
  signal: AbortSignal;
  maxTokens?: number;
  inputMeasurement?: InputMeasurement;
}
export type ModelRequestContent = Pick<
  LlmRequest,
  'messages' | 'systemPrompt' | 'thinkingLevel' | 'maxTokens'
>;

export type ModelRequestSnapshot = Omit<LlmRequest, 'signal' | 'messages'> & {
  messages?: NativeMessage[];
};

export function validateRequestSnapshot(request: ModelRequestSnapshot) {
  if (
    !request ||
    !request.model ||
    typeof request.model.provider !== 'string' ||
    !request.model.provider ||
    typeof request.model.id !== 'string' ||
    !request.model.id ||
    typeof request.systemPrompt !== 'string' ||
    (request.thinkingLevel !== undefined &&
      !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(request.thinkingLevel)) ||
    (request.maxTokens !== undefined && (!Number.isSafeInteger(request.maxTokens) || request.maxTokens < 1))
  )
    throw new Error('Invalid model request');
  if (
    request.tools !== undefined &&
    (!Array.isArray(request.tools) ||
      request.tools.some(
        (tool) =>
          !tool ||
          typeof tool.name !== 'string' ||
          typeof tool.description !== 'string' ||
          !tool.parameters ||
          typeof tool.parameters !== 'object' ||
          Array.isArray(tool.parameters),
      ))
  )
    throw new Error('Invalid advertised tools');
  if (request.messages === undefined) return;
  if (!Array.isArray(request.messages)) throw new Error('Invalid model request messages');
  const checker = new RequestMessages();
  checker.append(request.messages);
  return checker.complete();
}

/** Incremental tool-call validation for a single linear request context. */
export class RequestMessages {
  private readonly pending = new Map<string, string>();
  private readonly identities = new Set<string>();

  append(messages: Iterable<NativeMessage>) {
    for (const message of messages) {
      validateNativeMessage(message);
      if (message.role === 'toolResult') {
        if (this.pending.get(message.toolCallId) !== message.toolName)
          throw new Error('Unmatched model request tool result');
        this.pending.delete(message.toolCallId);
        continue;
      }
      this.complete();
      if (message.role !== 'assistant') continue;
      for (const part of message.content)
        if (part.type === 'toolCall') {
          if (!part.id || part.id.length > 256 || !part.name || this.identities.has(part.id))
            throw new Error('Duplicate or invalid model request tool call');
          this.identities.add(part.id);
          this.pending.set(part.id, part.name);
        }
    }
  }

  complete() {
    if (this.pending.size) throw new Error('Model request contains unfinished tool calls');
    return this.identities as ReadonlySet<string>;
  }
}

export type LlmEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'thinking-delta'; text: string }
  | { type: 'tool-call'; call: ToolCallPart }
  | { type: 'done'; message: NativeAssistantMessage };
export interface LlmAdapter {
  /** Pure predicate on the model choice; do not re-enter aggregate catalog or adapter selection. */
  accepts(model: Readonly<ModelChoice>): boolean;
  stream(request: LlmRequest): AsyncIterable<LlmEvent>;
  /** Optional counters for the provider's actual request representation. */
  countInputTokens?(request: LlmRequest): InputTokenCounts | Promise<InputTokenCounts>;
  classifyError?(error: unknown): ModelErrorKind | undefined;
}

export interface LlmPort {
  /** Select the nearest matching scope, then highest priority. A tie is ambiguous. */
  register(adapter: LlmAdapter, priority?: number): () => void;
  /** Returns the selected adapter, null for an ambiguous match, or undefined for no match. */
  select(model: ModelChoice): LlmAdapter | null | undefined;
  stream(request: LlmRequest): AsyncIterable<LlmEvent>;
}

export function validateNativeMessage(message: NativeMessage) {
  if (
    !message ||
    !['user', 'assistant', 'toolResult'].includes(message.role) ||
    !Number.isFinite(message.timestamp)
  )
    throw new Error('Invalid session message');
  if (message.role === 'user' && typeof message.content === 'string') return;
  if (!Array.isArray(message.content)) throw new Error('Invalid session message content');
  for (const block of message.content) {
    if (!block || typeof block !== 'object') throw new Error('Invalid session message content');
    switch (block.type) {
      case 'text':
        if (typeof block.text !== 'string') throw new Error('Invalid text content');
        break;
      case 'image':
        if (
          message.role === 'assistant' ||
          typeof block.data !== 'string' ||
          typeof block.mimeType !== 'string'
        )
          throw new Error('Invalid image content');
        break;
      case 'thinking':
        if (message.role !== 'assistant' || typeof block.thinking !== 'string')
          throw new Error('Invalid reasoning content');
        break;
      case 'toolCall':
        if (
          message.role !== 'assistant' ||
          typeof block.id !== 'string' ||
          typeof block.name !== 'string' ||
          !block.arguments ||
          typeof block.arguments !== 'object' ||
          Array.isArray(block.arguments)
        )
          throw new Error('Invalid tool call');
        break;
      default:
        throw new Error('Unknown session content type');
    }
  }
  if (
    message.role === 'toolResult' &&
    (typeof message.toolCallId !== 'string' ||
      typeof message.toolName !== 'string' ||
      typeof message.isError !== 'boolean' ||
      (message.detailKeys !== undefined &&
        (!Array.isArray(message.detailKeys) ||
          !message.detailKeys.every((key) => typeof key === 'string'))) ||
      (message.outcome !== undefined &&
        (!message.isError ||
          (message.outcome !== 'skipped' &&
            message.outcome !== 'denied' &&
            message.outcome !== 'cancelled'))))
  )
    throw new Error('Invalid tool result');
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessLlm: LlmPort;
  }
  interface Events {
    'llm/adapters-changed'(): void | Promise<void>;
  }
}
