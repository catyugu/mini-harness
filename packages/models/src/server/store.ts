import type { ModelStorePort } from './store-api.ts';
import { join } from 'node:path';
import {
  createProvider,
  getSupportedThinkingLevels,
  lazyApi,
  type Api,
  type Credential,
  type CredentialStore,
  type Model,
  type MutableModels,
  type ProviderStreams,
} from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { readJson, writeJson } from '@mini-harness/platform/json';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import { providerApiPattern, type ProviderModel } from '../shared/catalog.ts';

const apiLoaders: Record<string, () => Promise<ProviderStreams>> = {
  'openai-completions': () => import('@earendil-works/pi-ai/api/openai-completions'),
  'openai-responses': () => import('@earendil-works/pi-ai/api/openai-responses'),
  'anthropic-messages': () => import('@earendil-works/pi-ai/api/anthropic-messages'),
  'google-generative-ai': () => import('@earendil-works/pi-ai/api/google-generative-ai'),
};

/** One serialized, atomic store for all providers; SDKs never own our config files. */
class FileCredentials implements CredentialStore {
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string) {}
  private values(): Record<string, Credential> {
    const values = readJson<Record<string, Credential>>(this.file, {});
    if (!values || Array.isArray(values) || typeof values !== 'object')
      throw new Error('Invalid credential store');
    return values;
  }
  async read(id: string) {
    await this.writes;
    const values = this.values();
    return Object.hasOwn(values, id) ? structuredClone(values[id]) : undefined;
  }
  async list() {
    await this.writes;
    return Object.entries(this.values()).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.writes.then(work);
    this.writes = pending.catch(() => {});
    return pending;
  }
  modify(
    id: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: { signal?: AbortSignal },
  ) {
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
  async settle() {
    await this.writes;
  }
}

/** Owns provider definitions, credentials and the shared SDK provider registry. */
export class PiModelStore implements ModelStorePort {
  private initializedRuntime?: MutableModels;
  private get runtime(): MutableModels {
    if (!this.initializedRuntime) throw new Error('Model store is not initialized; refresh before use');
    return this.initializedRuntime;
  }
  private set runtime(value: MutableModels) {
    this.initializedRuntime = value;
  }
  private external = new Set<string>();
  private readonly credentials: FileCredentials;
  private status = new Map<string, { configured: boolean; source?: string }>();
  constructor(private readonly home: string) {
    this.credentials = new FileCredentials(join(home, 'auth.json'));
  }

  async refresh() {
    const next = builtinModels({
      credentials: this.credentials,
      identity: { userAgent: { custom: 'mini-harness' } },
    });
    const config = readJson<any>(join(this.home, 'models.json'), { providers: {} });
    if (
      !config ||
      typeof config !== 'object' ||
      !config.providers ||
      typeof config.providers !== 'object' ||
      Array.isArray(config.providers)
    )
      throw new Error('Invalid model provider configuration');
    const external = new Set<string>();
    for (const [id, entry] of Object.entries<any>(config.providers)) {
      if (
        !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) ||
        !entry ||
        typeof entry !== 'object' ||
        Array.isArray(entry)
      )
        throw new Error('Invalid provider configuration: ' + id);
      if (typeof entry.api !== 'string' || !providerApiPattern.test(entry.api))
        throw new Error('Invalid API type for provider: ' + id);
      const load = Object.hasOwn(apiLoaders, entry.api) ? apiLoaders[entry.api] : undefined;
      if (!load) external.add(id);
      let endpoint: URL;
      try {
        endpoint = new URL(entry.baseUrl);
      } catch {
        throw new Error('Invalid API endpoint for provider: ' + id);
      }
      if (
        !['https:', 'http:'].includes(endpoint.protocol) ||
        endpoint.username ||
        endpoint.password ||
        endpoint.hash
      )
        throw new Error('Invalid API endpoint for provider: ' + id);
      if (entry.apiKey !== undefined && (typeof entry.apiKey !== 'string' || entry.apiKey.startsWith('!')))
        throw new Error('Provider API keys must be literal values or environment variable names: ' + id);
      if (!Array.isArray(entry.models) || !entry.models.length)
        throw new Error('Provider needs at least one model: ' + id);
      const seen = new Set<string>();
      const models: Model<Api>[] = entry.models.map((item: any) => {
        if (
          !item ||
          typeof item.id !== 'string' ||
          !item.id.trim() ||
          item.id.length > 160 ||
          seen.has(item.id)
        )
          throw new Error('Invalid or duplicate model for provider: ' + id);
        seen.add(item.id);
        const contextWindow = item.contextWindow ?? 128000;
        const maxTokens = item.maxTokens ?? 8192;
        if (
          ![contextWindow, maxTokens].every(
            (value) => Number.isSafeInteger(value) && value > 0 && value <= 10000000,
          )
        )
          throw new Error('Invalid model token limits: ' + id + '/' + item.id);
        if (
          item.input !== undefined &&
          (!Array.isArray(item.input) ||
            item.input.some((value: unknown) => !['text', 'image'].includes(String(value))))
        )
          throw new Error('Invalid model input modalities: ' + id + '/' + item.id);
        return {
          ...item,
          id: item.id,
          name: String(item.name ?? item.id),
          api: entry.api,
          provider: id,
          baseUrl: endpoint.href.replace(/\/$/, ''),
          reasoning: Boolean(item.reasoning),
          input: item.input ?? ['text'],
          contextWindow,
          maxTokens,
          cost: item.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        };
      });
      const configuredKey = entry.apiKey as string | undefined;
      const resolveKey = () => (configuredKey ? (process.env[configuredKey] ?? configuredKey) : undefined);
      next.setProvider(
        createProvider({
          id,
          name: typeof entry.name === 'string' ? entry.name : id,
          baseUrl: endpoint.href.replace(/\/$/, ''),
          models,
          headers: entry.headers,
          // The SDK keeps these declarations in its catalog. Streaming belongs to the registered adapter.
          api: lazyApi(
            load ??
              (async () => {
                throw new Error('No Pi stream for ' + entry.api);
              }),
          ),
          auth: {
            apiKey: {
              name: id + ' API key',
              async login(interaction) {
                return {
                  type: 'api_key',
                  key: await interaction.prompt({ type: 'secret', message: 'API key' }),
                };
              },
              async resolve({ credential }) {
                const key = credential?.key ?? resolveKey();
                return key
                  ? { auth: { apiKey: key }, source: credential?.key ? 'stored' : 'configured' }
                  : undefined;
              },
            },
          },
        }),
      );
    }
    const status = await this.readStatus(next);
    this.runtime = next;
    this.external = external;
    this.status = status;
  }

  private async readStatus(runtime = this.runtime) {
    const stored = new Set((await this.credentials.list()).map(({ providerId }) => providerId));
    return new Map(
      await Promise.all(
        runtime.getProviders().map(async ({ id }) => {
          const auth = await runtime.checkAuth(id);
          return [
            id,
            {
              configured: Boolean(auth),
              source: auth ? (stored.has(id) ? 'stored' : auth.source) : undefined,
            },
          ] as const;
        }),
      ),
    );
  }
  list() {
    return this.runtime.getModels().map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name || model.id,
      configured: this.authStatus(model.provider).configured,
      input: [...model.input],
      thinkingLevels: getSupportedThinkingLevels(model),
    }));
  }
  async available() {
    this.status = await this.readStatus();
    return this.list();
  }
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
    return (
      model && {
        id: model.id,
        name: model.name,
        input: [...model.input],
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        reasoning: model.reasoning,
        thinkingLevels: getSupportedThinkingLevels(model),
      }
    );
  }
  providers() {
    return this.runtime.getProviders().map((provider) => ({
      id: provider.id,
      name: provider.name,
      canSetKey: Boolean(provider.auth.apiKey?.login),
      models: this.runtime.getModels(provider.id).flatMap((model) => {
        const capabilities = this.capabilities({ provider: model.provider, id: model.id });
        return capabilities ? [capabilities] : [];
      }),
    }));
  }
  authStatus(id: string) {
    return { ...(this.status.get(id) ?? { configured: false }) };
  }
  hasProvider(id: string) {
    return Boolean(this.runtime.getProvider(id));
  }
  /** Credential persistence and authentication status must change together. */
  private async changeCredential(id: string, next?: Credential) {
    const previous = await this.credentials.read(id);
    const previousStatus = this.status;
    const write = (value: Credential | undefined): Promise<unknown> =>
      value === undefined ? this.credentials.delete(id) : this.credentials.modify(id, async () => value);
    try {
      await write(next);
      this.status = await this.readStatus();
    } catch (error) {
      try {
        await write(previous);
        this.status = previousStatus;
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Could not restore model credentials after a failed update',
        );
      }
      throw error;
    }
  }
  async storeCredential(id: string, key: string) {
    if (!this.hasProvider(id)) throw new Error('Unknown provider');
    if (typeof key !== 'string' || !key.trim() || key.length > 65536) throw new Error('Invalid credential');
    await this.changeCredential(id, { type: 'api_key', key: key.trim() });
  }
  async removeCredential(id: string) {
    await this.changeCredential(id);
  }
  async close() {
    await this.credentials.settle();
  }

  connection(choice: ModelChoice) {
    const model = this.model(choice);
    return model && { api: model.api, baseUrl: model.baseUrl };
  }

  async apiKey(choice: ModelChoice) {
    const model = this.model(choice);
    return model && (await this.runtime.getAuth(model))?.auth.apiKey;
  }

  piConnection(choice: ModelChoice) {
    if (this.external.has(choice.provider)) return;
    const model = this.model(choice);
    if (model) return { model, runtime: this.runtime };
  }
}
