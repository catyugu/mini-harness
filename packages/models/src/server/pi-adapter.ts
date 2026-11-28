import {
  createModels,
  createProvider,
  defaultProviderAuthContext,
  isContextOverflow,
  lazyApi,
  type Api,
  type AssistantMessage,
  type Message,
  type Model,
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

import { protocols } from './protocols.ts';

// Providers with multiple native protocols need a default for newly registered IDs.
const preferredProtocols: Readonly<Record<string, string>> = {
  azure: 'azure-openai-responses',
  'cloudflare-ai-gateway': 'openai-completions',
  fireworks: 'openai-completions',
  'github-copilot': 'openai-completions',
  opencode: 'openai-completions',
  'opencode-go': 'openai-completions',
  openrouter: 'openai-completions',
};

/** Publishes Pi defaults and translates supported requests at the adapter boundary. */
export class PiLlm implements LlmAdapter {
  private readonly builtin;
  constructor(private readonly store: ModelStorePort) {
    this.builtin = builtinModels({ credentials: store.credentials });
  }

  registerModels() {
    const runtime = this.builtin;
    const authContext = defaultProviderAuthContext();
    return this.store.registerDefaults(
      runtime.getProviders().map((provider) => {
        const models = runtime.getModels(provider.id);
        const protocols = new Set(models.map(({ api }) => api));
        const api =
          (Object.hasOwn(preferredProtocols, provider.id) ? preferredProtocols[provider.id] : undefined) ??
          (protocols.size === 1 ? [...protocols][0] : '');
        return {
          id: provider.id,
          name: provider.name,
          api,
          baseUrl: provider.baseUrl ?? '',
          canSetKey: Boolean(provider.auth.apiKey?.login),
          models,
          async authStatus(signal: AbortSignal) {
            const auth = await runtime.checkAuth(provider.id, { signal });
            return auth?.source || Boolean(auth);
          },
          async discoveryKey(credential, signal) {
            if (credential?.type === 'oauth') return;
            const result = await provider.auth.apiKey?.resolve({ ctx: authContext, credential, signal });
            return result?.auth.apiKey;
          },
        };
      }),
    );
  }

  accepts(choice: ModelChoice) {
    const selected = this.store.requestModel(choice);
    return Boolean(
      selected &&
        (this.builtin.getProvider(choice.provider) ? selected.model.api : protocols.has(selected.model.api)),
    );
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
    const store = this.store;
    const selected = store.requestModel(request.model);
    if (!selected) throw new Error('Model is unavailable through the Pi adapter');
    const { provider } = selected;
    const { model } = selected;
    const native = this.builtin.getProvider(provider.id);
    let runtime = this.builtin;
    if (native && provider.endpointOverride) {
      const baseUrl = provider.endpointOverride;
      runtime = createModels({ credentials: store.credentials });
      runtime.setProvider({
        ...native,
        baseUrl,
        streamSimple: (model, context, options) =>
          native.streamSimple({ ...model, baseUrl }, context, options),
      });
    } else if (!native) {
      const load = protocols.get(model.api)?.load;
      if (!load) throw new Error('Model is unavailable through the Pi adapter');
      runtime = createModels();
      runtime.setProvider(
        createProvider({
          id: provider.id,
          name: provider.name,
          baseUrl: model.baseUrl,
          headers: provider.headers,
          models: [model],
          api: lazyApi(load),
          auth: {
            apiKey: {
              name: provider.id + ' API key',
              async resolve() {
                const key = await store.apiKey(provider);
                return key ? { auth: { apiKey: key } } : undefined;
              },
            },
          },
        }),
      );
    }
    if (
      request.messages.some((message) => message.content.some((part) => part.type === 'image')) &&
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
        if (message.stopReason === 'error')
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
  if (message.role === 'toolResult') {
    const { role, toolCallId, toolName, content, timestamp, state } = structuredClone(message);
    return { role, toolCallId, toolName, content, timestamp, isError: state !== 'finished' };
  }
  if (message.role === 'user') return structuredClone(message);
  const { providerData, ...native } = structuredClone(message);
  return {
    ...providerData,
    ...native,
    api: String(providerData?.api ?? selected.api),
    provider: native.provider ?? selected.provider,
    model: native.model ?? selected.id,
    usage: { ...emptyUsage(), ...native.usage, cost: native.usage?.cost ?? emptyUsage().cost },
  } as AssistantMessage;
}

function fromProviderMessage(message: AssistantMessage): NativeAssistantMessage {
  const { role, content, timestamp, provider, model, usage, stopReason, errorMessage, ...providerData } =
    structuredClone(message);
  const reason = stopReason === 'deferred' ? 'error' : stopReason;
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
    stopReason: reason,
    errorMessage:
      stopReason === 'deferred'
        ? 'Deferred responses are not supported by this agent'
        : reason === 'error' || reason === 'aborted'
          ? errorMessage
          : undefined,
    providerData,
  };
}
