import { join } from 'node:path';
import { readJson, writeJson } from '@mini-harness/platform/json';
import { thinkingLevels, type ModelChoice } from '@mini-harness/llm/vocabulary';
import { providerApiPattern } from '../shared/catalog.ts';
import type { AuthStatus, CatalogModel, CatalogProvider, Credential, ModelStorePort } from './store-api.ts';

/** One serialized, atomic store for all providers; SDKs never own our config files. */
class FileCredentials {
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
    return Object.hasOwn(values, id) ? values[id] : undefined;
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
      const next = await fn(Object.hasOwn(values, id) ? values[id] : undefined);
      options?.signal?.throwIfAborted();
      if (next !== undefined) {
        values[id] = next;
        writeJson(this.file, values);
      }
      return Object.hasOwn(values, id) ? values[id] : undefined;
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

export class ModelStore implements ModelStorePort {
  readonly credentials: FileCredentials;
  private readonly defaults = new Set<readonly CatalogProvider[]>();
  private custom = new Map<string, CatalogProvider>();
  private status = new Map<string, AuthStatus>();

  constructor(private readonly home: string) {
    this.credentials = new FileCredentials(join(home, 'auth.json'));
  }

  async registerDefaults(providers: readonly CatalogProvider[]) {
    this.defaults.add(providers);
    try {
      this.status = await this.readStatus();
    } catch (error) {
      this.defaults.delete(providers);
      throw error;
    }
    return async () => {
      this.defaults.delete(providers);
      this.status = await this.readStatus();
    };
  }

  async refresh() {
    const { providers } =
      readJson<{ providers: Record<string, unknown> }>(join(this.home, 'models.json'), { providers: {} }) ??
      {};
    if (!providers || typeof providers !== 'object' || Array.isArray(providers))
      throw new Error('Invalid model provider configuration');
    const next = new Map(Object.entries(providers).map(([id, entry]) => [id, parseProvider(id, entry)]));
    this.status = await this.readStatus(next);
    this.custom = next;
  }

  private catalog(custom = this.custom) {
    return new Map(
      [...this.defaults]
        .flat()
        .map((provider) => [provider.id, provider] as const)
        .concat([...custom]),
    );
  }

  private async readStatus(custom = this.custom) {
    const stored = new Set((await this.credentials.list()).map(({ providerId }) => providerId));
    return new Map(
      await Promise.all(
        [...this.catalog(custom).values()].map(async (provider) => {
          const auth = provider.authStatus
            ? await provider.authStatus()
            : (await this.providerKey(provider)) !== undefined;
          return [
            provider.id,
            {
              configured: Boolean(auth),
              source: auth
                ? stored.has(provider.id)
                  ? 'stored'
                  : typeof auth === 'string'
                    ? auth
                    : 'configured'
                : undefined,
            },
          ] as const;
        }),
      ),
    );
  }

  list() {
    return [...this.catalog().values()].flatMap(({ id: provider, models }) =>
      models.map((model) => ({
        provider,
        id: model.id,
        name: model.name,
        input: model.input,
        configured: this.authStatus(provider).configured,
        thinkingLevels: model.thinkingLevels ?? [],
      })),
    );
  }

  async available() {
    this.status = await this.readStatus();
    return this.list();
  }

  configuredProvider(id: string) {
    return this.custom.get(id);
  }

  private provider(id: string) {
    return (
      this.custom.get(id) ??
      [...this.defaults]
        .reverse()
        .flat()
        .find((provider) => provider.id === id)
    );
  }

  private model(choice: ModelChoice) {
    const models = this.provider(choice.provider)?.models;
    return choice.id ? models?.find(({ id }) => id === choice.id) : models?.[0];
  }

  resolve(choice: ModelChoice) {
    const model = this.model(choice);
    return model && { provider: choice.provider, id: model.id };
  }

  capabilities(choice: ModelChoice) {
    const model = this.model(choice);
    return model && capabilities(model);
  }

  providers() {
    return [...this.catalog().values()].map(({ id, name, canSetKey, models }) => {
      const { configured, source } = this.authStatus(id);
      const custom = this.custom.has(id);
      return {
        id,
        name,
        configured,
        storedCredential: source === 'stored',
        canSetKey,
        custom,
        baseUrl: custom ? models[0].baseUrl : '',
        api: models[0]?.api ?? '',
        models: models.map(capabilities),
      };
    });
  }

  authStatus(id: string) {
    return this.status.get(id) ?? { configured: false };
  }

  hasProvider(id: string) {
    return Boolean(this.provider(id));
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

  private async providerKey(provider: CatalogProvider) {
    const stored = await this.credentials.read(provider.id);
    const key =
      (stored?.type === 'api_key' ? stored.key : undefined) ??
      (provider.key ? (process.env[provider.key] ?? provider.key) : undefined);
    return key || undefined;
  }

  async apiKey(choice: ModelChoice) {
    const provider = this.provider(choice.provider);
    if (provider && this.model(choice))
      return provider.apiKey ? provider.apiKey(choice) : this.providerKey(provider);
  }
}

function capabilities({
  id,
  name,
  input,
  contextWindow,
  maxTokens,
  reasoning,
  thinkingLevels,
}: CatalogModel) {
  return { id, name, input, contextWindow, maxTokens, reasoning, thinkingLevels };
}

export function parseProvider(id: string, entry: any): CatalogProvider {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || !entry || typeof entry !== 'object' || Array.isArray(entry))
    throw new Error('Invalid provider configuration: ' + id);
  if (typeof entry.api !== 'string' || !providerApiPattern.test(entry.api))
    throw new Error('Invalid API type for provider: ' + id);
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
  const models: CatalogModel[] = entry.models.map((item: any) => {
    if (!item || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 160 || seen.has(item.id))
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
      baseUrl: endpoint.href.replace(/\/$/, ''),
      reasoning: Boolean(item.reasoning),
      input: item.input ?? ['text'],
      contextWindow,
      maxTokens,
      thinkingLevels: item.reasoning
        ? thinkingLevels.filter((level) => {
            const mapped = item.thinkingLevelMap?.[level];
            return mapped !== null && (mapped !== undefined || (level !== 'xhigh' && level !== 'max'));
          })
        : ['off'],
    };
  });
  return {
    id,
    name: typeof entry.name === 'string' ? entry.name : id,
    canSetKey: true,
    models,
    key: entry.apiKey,
    headers: entry.headers,
  };
}
