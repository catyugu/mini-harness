import type { Api, AssistantMessage, Message, Model } from '@earendil-works/pi-ai';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import type {
  LlmEvent,
  LlmAdapter,
  LlmRequest,
  NativeAssistantMessage,
  NativeMessage,
} from '@mini-harness/llm/api';
import type { ModelStorePort } from './store-api.ts';

/** Converts between native messages and the model provider protocol. */
export class PiLlm implements LlmAdapter {
  constructor(private readonly store: ModelStorePort) {}

  accepts(choice: ModelChoice) {
    return !!this.store.piConnection(choice);
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmEvent> {
    request.signal.throwIfAborted();
    const selected = this.store.piConnection(request.model);
    if (!selected) throw new Error('Model is unavailable through the Pi adapter');
    const { model, runtime } = selected;
    if (
      request.messages.some(
        (message) => Array.isArray(message.content) && message.content.some((part) => part.type === 'image'),
      ) &&
      !model.input.includes('image')
    )
      throw new Error(
        'The selected model does not support image input. Choose an image-capable model and retry.',
      );
    const stream = runtime.streamSimple(
      model,
      {
        systemPrompt: request.systemPrompt,
        messages: request.messages.map((message) => toProviderMessage(message, model)),
        tools: request.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })),
      },
      {
        signal: request.signal,
        reasoning:
          request.thinkingLevel && request.thinkingLevel !== 'off' ? request.thinkingLevel : undefined,
        maxTokens: request.maxTokens,
        maxRetries: 0,
        identity: { userAgent: { custom: 'mini-harness' } },
      },
    );
    let finished = false;
    for await (const event of stream) {
      if (event.type === 'text_delta') yield { type: 'text-delta', text: event.delta };
      else if (event.type === 'thinking_delta') yield { type: 'thinking-delta', text: event.delta };
      else if (event.type === 'toolcall_end')
        yield { type: 'tool-call', call: structuredClone(event.toolCall) };
      else if (event.type === 'done' || event.type === 'error') {
        finished = true;
        yield {
          type: 'done',
          message: fromProviderMessage(event.type === 'done' ? event.message : event.error),
        };
      }
    }
    if (!finished) throw new Error('Model stream ended without a final response');
  }
}

const emptyUsage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function toProviderMessage(message: NativeMessage, selected: Model<Api>): Message {
  if (message.role !== 'assistant') return structuredClone(message) as Message;
  const { providerData, ...native } = structuredClone(message);
  return {
    ...providerData,
    ...native,
    api: String(providerData?.api ?? selected.api),
    provider: native.provider ?? selected.provider,
    model: native.model ?? selected.id,
    usage: { ...emptyUsage(), ...native.usage, cost: native.usage?.cost ?? emptyUsage().cost },
    stopReason: native.stopReason ?? 'stop',
  } as AssistantMessage;
}

function fromProviderMessage(message: AssistantMessage): NativeAssistantMessage {
  const { role, content, timestamp, provider, model, usage, stopReason, errorMessage, ...providerData } =
    structuredClone(message);
  return {
    role,
    content,
    timestamp,
    provider,
    model,
    usage,
    stopReason: ['stop', 'length', 'toolUse', 'error', 'aborted'].includes(stopReason)
      ? (stopReason as NativeAssistantMessage['stopReason'])
      : 'error',
    errorMessage:
      stopReason === 'deferred' ? 'Deferred responses are not supported by this agent' : errorMessage,
    providerData,
  };
}
