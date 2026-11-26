import {
  createModels,
  createProvider,
  getSupportedThinkingLevels,
  isContextOverflow,
  lazyApi,
  type Api,
  type AssistantMessage,
  type Message,
  type Model,
  type ProviderStreams,
} from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import type {
  LlmEvent,
  LlmAdapter,
  LlmRequest,
  ModelErrorKind,
  NativeAssistantMessage,
  NativeMessage,
} from '@mini-harness/llm/api';
import type { ModelStorePort } from './store-api.ts';

const apiLoaders: Record<string, () => Promise<ProviderStreams>> = {
  'openai-completions': () => import('@earendil-works/pi-ai/api/openai-completions'),
  'openai-responses': () => import('@earendil-works/pi-ai/api/openai-responses'),
  'anthropic-messages': () => import('@earendil-works/pi-ai/api/anthropic-messages'),
  'google-generative-ai': () => import('@earendil-works/pi-ai/api/google-generative-ai'),
};

/** Publishes Pi defaults and translates supported requests at the adapter boundary. */
export class PiLlm implements LlmAdapter {
  private readonly builtin;
  constructor(private readonly store: ModelStorePort) {
    this.builtin = builtinModels({ credentials: store.credentials });
  }

  registerModels() {
    const runtime = this.builtin;
    return this.store.registerDefaults(
      runtime.getProviders().map((provider) => ({
        id: provider.id,
        name: provider.name,
        canSetKey: Boolean(provider.auth.apiKey?.login),
        models: runtime.getModels(provider.id).map((model) => ({
          id: model.id,
          name: model.name,
          api: model.api,
          baseUrl: model.baseUrl,
          input: model.input,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          reasoning: model.reasoning,
          thinkingLevels: getSupportedThinkingLevels(model),
        })),
        async authStatus() {
          const auth = await runtime.checkAuth(provider.id);
          return auth?.source || Boolean(auth);
        },
        async apiKey(choice) {
          const model = runtime.getModel(choice.provider, choice.id);
          return model && (await runtime.getAuth(model))?.auth.apiKey;
        },
      })),
    );
  }

  accepts(choice: ModelChoice) {
    if (!this.store.configuredProvider(choice.provider))
      return Boolean(this.builtin.getModel(choice.provider, choice.id));
    const connection = this.store.connection(choice);
    return connection !== undefined && Object.hasOwn(apiLoaders, connection.api);
  }

  classifyError(error: unknown): ModelErrorKind | undefined {
    const value = error as { status?: number; code?: string; message?: string };
    const message = String(value?.message ?? error);
    if (
      /too many images|(?:image|media|vision).{0,60}(?:limit exceeded|maximum|too large)|(?:maximum|limit).{0,40}(?:images|image size)/i.test(
        message,
      )
    )
      return 'image-limit';
    if (
      value?.code === 'context_length_exceeded' ||
      isContextOverflow({
        role: 'assistant',
        stopReason: 'error',
        errorMessage: message,
        usage: emptyUsage(),
      } as AssistantMessage)
    )
      return 'context-overflow';
    if (
      value?.status === 408 ||
      value?.status === 429 ||
      (value?.status ?? 0) >= 500 ||
      /\b(?:408|429|50[0234]|529|ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b|fetch failed|rate limit|overloaded|connection (?:reset|terminated)/i.test(
        message,
      )
    )
      return 'transient';
    return 'permanent';
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmEvent> {
    request.signal.throwIfAborted();
    const { provider, id } = request.model;
    const store = this.store;
    const configured = store.configuredProvider(provider);
    let runtime = this.builtin;
    if (configured) {
      const selected = configured.models.find((model) => model.id === id);
      const load = selected && Object.hasOwn(apiLoaders, selected.api) && apiLoaders[selected.api];
      if (!selected || !load) throw new Error('Model is unavailable through the Pi adapter');
      runtime = createModels();
      runtime.setProvider(
        createProvider({
          id: provider,
          name: configured.name,
          baseUrl: selected.baseUrl,
          headers: configured.headers,
          models: [
            {
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              ...selected,
              input: [...selected.input],
              provider,
            },
          ],
          api: lazyApi(load),
          auth: {
            apiKey: {
              name: provider + ' API key',
              async resolve() {
                const key = await store.apiKey(request.model);
                return key ? { auth: { apiKey: key } } : undefined;
              },
            },
          },
        }),
      );
    }
    const model = runtime.getModel(provider, id);
    if (!model) throw new Error('Model is unavailable through the Pi adapter');
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
        const result = event.type === 'done' ? event.message : event.error;
        const message = fromProviderMessage(result);
        if (event.type === 'error')
          message.errorKind = isContextOverflow(result, model.contextWindow)
            ? 'context-overflow'
            : this.classifyError(result.errorMessage);
        yield { type: 'done', message };
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
    usage: {
      ...usage,
      cacheWriteSupported:
        usage.cacheWrite > 0 ||
        message.api === 'anthropic-messages' ||
        message.api === 'bedrock-converse-stream'
          ? true
          : undefined,
    },
    stopReason: ['stop', 'length', 'toolUse', 'error', 'aborted'].includes(stopReason)
      ? (stopReason as NativeAssistantMessage['stopReason'])
      : 'error',
    errorMessage:
      stopReason === 'deferred' ? 'Deferred responses are not supported by this agent' : errorMessage,
    providerData,
  };
}
