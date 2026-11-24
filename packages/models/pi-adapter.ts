import { join } from 'node:path';
import {
  createProvider, getSupportedThinkingLevels, lazyApi,
  type Api, type AssistantMessage, type Credential, type CredentialStore, type Message,
  type Model, type MutableModels, type ProviderStreams
} from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { readJson, writeJson } from '@mini-harness/platform/config';
import type { ModelChoice } from '@mini-harness/contracts/conversation';
import type { ModelCatalogPort, ProviderModel } from '@mini-harness/contracts/models';
import type { LlmEvent, LlmPort, LlmRequest, NativeAssistantMessage, NativeMessage } from '@mini-harness/contracts/llm';

const apiLoaders: Record<string, () => Promise<ProviderStreams>> = {
  'openai-completions': () => import('@earendil-works/pi-ai/api/openai-completions'),
  'openai-responses': () => import('@earendil-works/pi-ai/api/openai-responses'),
  'anthropic-messages': () => import('@earendil-works/pi-ai/api/anthropic-messages'),
  'google-generative-ai': () => import('@earendil-works/pi-ai/api/google-generative-ai')
};

/** One serialized, atomic store for all providers; SDKs never own our config files. */
class FileCredentials implements CredentialStore {
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string) {}
  private values(): Record<string, Credential> {
    const values = readJson<Record<string, Credential>>(this.file, {});
    if (!values || Array.isArray(values) || typeof values !== 'object') throw new Error('Invalid credential store');
    return values;
  }
  async read(id: string) {
    await this.writes;
    const values = this.values();
    return Object.hasOwn(values, id) ? structuredClone(values[id]) : undefined;
  }
  async list() {
    await this.writes;
    return Object.entries(this.values()).map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.writes.then(work);
    this.writes = pending.catch(() => {});
    return pending;
  }
  modify(id: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: { signal?: AbortSignal }) {
    return this.enqueue(async () => {
      options?.signal?.throwIfAborted();
      const values = this.values();
      const next = await fn(Object.hasOwn(values, id) ? structuredClone(values[id]) : undefined);
      options?.signal?.throwIfAborted();
      if (next !== undefined) {
        values[id] = structuredClone(next);
        writeJson(this.file, values);
      }
      return Object.hasOwn(values, id) ? structuredClone(values[id]) : undefined;
    });
  }
  delete(id: string, options?: { signal?: AbortSignal }) {
    return this.enqueue(async () => {
      options?.signal?.throwIfAborted();
      const values = this.values();
      delete values[id];
      writeJson(this.file, values);
    });
  }
  async settle() { await this.writes; }
}

/** Owns provider definitions, credentials and the shared SDK provider registry. */
export class PiModelStore implements ModelCatalogPort {
  private initializedRuntime?: MutableModels;
  private get runtime(): MutableModels {
    if (!this.initializedRuntime) throw new Error('Model store is not initialized; refresh before use');
    return this.initializedRuntime;
  }
  private set runtime(value: MutableModels) { this.initializedRuntime = value; }
  private readonly credentials: FileCredentials;
  private status = new Map<string, { configured: boolean; source?: string }>();
  constructor(private readonly home: string) {
    this.credentials = new FileCredentials(join(home, 'auth.json'));
  }

  async refresh() {
    const next = builtinModels({ credentials: this.credentials, identity: { userAgent: { custom: 'mini-harness' } } });
    const config = readJson<any>(join(this.home, 'models.json'), { providers: {} });
    if (!config || typeof config !== 'object' || !config.providers || typeof config.providers !== 'object' || Array.isArray(config.providers))
      throw new Error('Invalid model provider configuration');
    for (const [id, entry] of Object.entries<any>(config.providers)) {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || !entry || typeof entry !== 'object' || Array.isArray(entry))
        throw new Error('Invalid provider configuration: ' + id);
      if (!Object.hasOwn(apiLoaders, entry.api)) throw new Error('Unsupported API type for provider: ' + id);
      let endpoint: URL;
      try { endpoint = new URL(entry.baseUrl); } catch { throw new Error('Invalid API endpoint for provider: ' + id); }
      if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash)
        throw new Error('Invalid API endpoint for provider: ' + id);
      if (entry.apiKey !== undefined && (typeof entry.apiKey !== 'string' || entry.apiKey.startsWith('!')))
        throw new Error('Provider API keys must be literal values or environment variable names: ' + id);
      if (!Array.isArray(entry.models) || !entry.models.length) throw new Error('Provider needs at least one model: ' + id);
      const seen = new Set<string>();
      const models: Model<Api>[] = entry.models.map((item: any) => {
        if (!item || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 160 || seen.has(item.id))
          throw new Error('Invalid or duplicate model for provider: ' + id);
        seen.add(item.id);
        const contextWindow = item.contextWindow ?? 128000;
        const maxTokens = item.maxTokens ?? 8192;
        if (![contextWindow, maxTokens].every((value) => Number.isSafeInteger(value) && value > 0 && value <= 10000000))
          throw new Error('Invalid model token limits: ' + id + '/' + item.id);
        if (item.input !== undefined && (!Array.isArray(item.input) || item.input.some((value: unknown) => !['text', 'image'].includes(String(value)))))
          throw new Error('Invalid model input modalities: ' + id + '/' + item.id);
        return {
          ...item, id: item.id, name: String(item.name ?? item.id), api: entry.api, provider: id,
          baseUrl: endpoint.href.replace(/\/$/, ''), reasoning: Boolean(item.reasoning),
          input: item.input ?? ['text'], contextWindow, maxTokens,
          cost: item.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        };
      });
      const configuredKey = entry.apiKey as string | undefined;
      const resolveKey = () => configuredKey ? process.env[configuredKey] ?? configuredKey : undefined;
      next.setProvider(createProvider({
        id, name: typeof entry.name === 'string' ? entry.name : id,
        baseUrl: endpoint.href.replace(/\/$/, ''), models, headers: entry.headers,
        api: lazyApi(apiLoaders[entry.api]),
        auth: { apiKey: {
          name: id + ' API key',
          async login(interaction) { return { type: 'api_key', key: await interaction.prompt({ type: 'secret', message: 'API key' }) }; },
          async resolve({ credential }) {
            const key = credential?.key ?? resolveKey();
            return key ? { auth: { apiKey: key }, source: credential?.key ? 'stored' : 'configured' } : undefined;
          }
        } }
      }));
    }
    const status = await this.readStatus(next);
    this.runtime = next;
    this.status = status;
  }

  private async readStatus(runtime = this.runtime) {
    const stored = new Set((await this.credentials.list()).map(({ providerId }) => providerId));
    return new Map(await Promise.all(runtime.getProviders().map(async ({ id }) => {
      const auth = await runtime.checkAuth(id);
      return [id, { configured: Boolean(auth), source: auth ? stored.has(id) ? 'stored' : auth.source : undefined }] as const;
    })));
  }
  list() {
    return this.runtime.getModels().map((model) => ({
      provider: model.provider, id: model.id, name: model.name || model.id,
      configured: this.authStatus(model.provider).configured, input: [...model.input], thinkingLevels: getSupportedThinkingLevels(model)
    }));
  }
  async available() { this.status = await this.readStatus(); return this.list(); }
  private model(choice: ModelChoice) {
    if (!choice?.provider) return undefined;
    const id = choice.id || this.runtime.getModels(choice.provider)[0]?.id;
    return id ? this.runtime.getModel(choice.provider, id) : undefined;
  }
  resolve(choice: ModelChoice) {
    const model = this.model(choice);
    return model ? { provider: model.provider, id: model.id } : undefined;
  }
  capabilities(choice: ModelChoice): ProviderModel | undefined {
    const model = this.model(choice);
    return model && { id: model.id, name: model.name, input: [...model.input], contextWindow: model.contextWindow,
      maxTokens: model.maxTokens, reasoning: model.reasoning, thinkingLevels: getSupportedThinkingLevels(model) };
  }
  providers() {
    return this.runtime.getProviders().map((provider) => ({
      id: provider.id, name: provider.name, canSetKey: Boolean(provider.auth.apiKey?.login),
      models: this.runtime.getModels(provider.id).flatMap((model) => {
        const capabilities = this.capabilities({ provider: model.provider, id: model.id });
        return capabilities ? [capabilities] : [];
      })
    }));
  }
  authStatus(id: string) { return { ...(this.status.get(id) ?? { configured: false }) }; }
  hasProvider(id: string) { return Boolean(this.runtime.getProvider(id)); }
  /** Credential persistence and authentication status must change together. */
  private async changeCredential(id: string, next?: Credential) {
    const previous = await this.credentials.read(id);
    const previousStatus = this.status;
    const write = (value: Credential | undefined): Promise<unknown> => value === undefined
      ? this.credentials.delete(id)
      : this.credentials.modify(id, async () => value);
    try {
      await write(next);
      this.status = await this.readStatus();
    } catch (error) {
      try {
        await write(previous);
        this.status = previousStatus;
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Could not restore model credentials after a failed update');
      }
      throw error;
    }
  }
  async storeCredential(id: string, key: string) {
    if (!this.hasProvider(id)) throw new Error('Unknown provider');
    if (typeof key !== 'string' || !key.trim() || key.length > 65536) throw new Error('Invalid credential');
    await this.changeCredential(id, { type: 'api_key', key: key.trim() });
  }
  async removeCredential(id: string) { await this.changeCredential(id); }
  async close() { await this.credentials.settle(); }

  connection(choice: ModelChoice) {
    const model = this.model(choice);
    if (!model) throw new Error('Choose a model in Settings before sending a message');
    return { model, runtime: this.runtime };
  }
}

/** Converts between native messages and the model provider protocol. */
export class PiLlm implements LlmPort {
  constructor(private readonly store: PiModelStore) {}

  async *stream(request: LlmRequest): AsyncIterable<LlmEvent> {
    request.signal.throwIfAborted();
    const { model, runtime } = this.store.connection(request.model);
    if (request.messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === 'image')) && !model.input.includes('image'))
      throw new Error('The selected model does not support image input. Choose an image-capable model and retry.');
    const stream = runtime.streamSimple(model, {
      systemPrompt: request.systemPrompt,
      messages: request.messages.map((message) => toProviderMessage(message, model)),
      tools: request.tools?.map(({ name, description, parameters }) => ({ name, description, parameters }))
    }, {
      signal: request.signal, sessionId: request.sessionId,
      reasoning: request.thinkingLevel && request.thinkingLevel !== 'off' ? request.thinkingLevel : undefined,
      maxTokens: request.maxTokens, maxRetries: 0,
      identity: { userAgent: { custom: 'mini-harness' } }
    });
    let finished = false;
    for await (const event of stream) {
      if (event.type === 'text_delta') yield { type: 'text-delta', text: event.delta };
      else if (event.type === 'thinking_delta') yield { type: 'thinking-delta', text: event.delta };
      else if (event.type === 'toolcall_end') yield { type: 'tool-call', call: structuredClone(event.toolCall) };
      else if (event.type === 'done' || event.type === 'error') {
        finished = true;
        yield { type: 'done', message: fromProviderMessage(event.type === 'done' ? event.message : event.error) };
      }
    }
    if (!finished) throw new Error('Model stream ended without a final response');
  }
}

const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

function toProviderMessage(message: NativeMessage, selected: Model<Api>): Message {
  if (message.role !== 'assistant') return structuredClone(message) as Message;
  const { providerData, ...native } = structuredClone(message);
  return { ...providerData, ...native, api: String(providerData?.api ?? selected.api),
    provider: native.provider ?? selected.provider, model: native.model ?? selected.id,
    usage: { ...emptyUsage(), ...native.usage, cost: native.usage?.cost ?? emptyUsage().cost },
    stopReason: native.stopReason ?? 'stop' } as AssistantMessage;
}

function fromProviderMessage(message: AssistantMessage): NativeAssistantMessage {
  const { role, content, timestamp, provider, model, usage, stopReason, errorMessage, ...providerData } = structuredClone(message);
  return { role, content, timestamp, provider, model, usage,
    stopReason: ['stop', 'length', 'toolUse', 'error', 'aborted'].includes(stopReason)
      ? stopReason as NativeAssistantMessage['stopReason'] : 'error',
    errorMessage: stopReason === 'deferred' ? 'Deferred responses are not supported by this agent' : errorMessage,
    providerData };
}
