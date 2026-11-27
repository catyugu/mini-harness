import { join } from 'node:path';
import { DomainError } from '@mini-harness/platform/errors';
import { readJson, writeJson } from '@mini-harness/platform/json';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import {
  resolveModel,
  credential,
  endpoint,
  invalid,
  parseConfiguration,
  parseCustom,
  parseOverride,
  protocol,
  providerId,
  record,
  type ProviderConfiguration,
} from './provider-settings.ts';
import { discover } from './protocols.ts';
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
  private readonly file: string;
  private readonly defaults = new Set<readonly CatalogProvider[]>();
  private configuration: ProviderConfiguration = { providers: {}, builtins: {} };
  private status = new Map<string, AuthStatus>();
  private effective = new Map<string, CatalogProvider>();
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    home: string,
    private readonly changed = () => {},
    private readonly report: (error: unknown) => void = console.warn,
  ) {
    this.file = join(home, 'models.json');
    this.credentials = new FileCredentials(join(home, 'auth.json'));
  }

  private enqueue<T>(work: () => Promise<T>) {
    const pending = this.writes.then(work);
    this.writes = pending.catch(() => {});
    return pending;
  }

  registerDefaults(providers: readonly CatalogProvider[]) {
    return this.enqueue(async () => {
      const ids = providers.map(({ id }) => id);
      this.defaults.add(providers);
      this.publishCatalog(this.configuration);
      await this.refreshStatus(ids);
      this.notify();
      return () =>
        this.enqueue(async () => {
          this.defaults.delete(providers);
          this.publishCatalog(this.configuration);
          await this.refreshStatus(ids);
          this.notify();
        });
    });
  }

  refresh() {
    return this.enqueue(async () => {
      this.publishCatalog(parseConfiguration(readJson(this.file, { providers: {} })));
      await this.refreshStatus(this.effective.keys());
      this.notify();
    });
  }

  private defaultProviders() {
    return new Map([...this.defaults].flat().map((provider) => [provider.id, provider] as const));
  }

  private builtin(provider: CatalogProvider, configuration: ProviderConfiguration): CatalogProvider {
    const override = Object.hasOwn(configuration.builtins, provider.id)
      ? configuration.builtins[provider.id]
      : undefined;
    if (!override) return provider;
    const baseUrl = override.baseUrl ?? provider.baseUrl;
    const baseline = new Map(provider.models.map((model) => [model.id, model]));
    const models =
      override.models?.flatMap(({ templateId, ...model }) => {
        const template = templateId ? baseline.get(templateId) : undefined;
        // A native template removed by an adapter update cannot be resolved as an independent model.
        if (templateId ? !template : !provider.api) return [];
        return resolveModel(model, provider, template);
      }) ?? provider.models;
    return {
      ...provider,
      baseUrl,
      models: override.baseUrl ? models.map((model) => ({ ...model, baseUrl })) : models,
      endpointOverride: override.baseUrl,
    };
  }

  private custom(
    id: string,
    { api, baseUrl, name, headers, apiKey: key, models }: ProviderConfiguration['providers'][string],
  ): CatalogProvider {
    const connection = { api, baseUrl };
    return {
      id,
      name,
      canSetKey: true,
      ...connection,
      headers,
      key,
      models: models.map((model) => resolveModel(model, connection)),
    };
  }

  private buildCatalog(configuration: ProviderConfiguration) {
    const defaults = this.defaultProviders();
    return [
      ...[...defaults.values()].map((provider) => this.builtin(provider, configuration)),
      ...Object.entries(configuration.providers)
        .filter(([id]) => !defaults.has(id))
        .map(([id, config]) => this.custom(id, config)),
    ];
  }

  private provider(id: string) {
    return this.effective.get(id);
  }

  private publishCatalog(configuration: ProviderConfiguration, providers = this.buildCatalog(configuration)) {
    this.effective = new Map(providers.map((provider) => [provider.id, provider]));
    this.configuration = configuration;
    for (const id of this.status.keys()) {
      if (!this.effective.has(id)) this.status.delete(id);
    }
  }

  private async refreshStatus(ids: Iterable<string>) {
    await Promise.all([...ids].map(async (id) => {
      const provider = this.provider(id);
      if (!provider) return;
      try {
        const stored = await this.credentials.read(id);
        const auth = provider.authStatus
          ? await provider.authStatus()
          : Boolean(await this.apiKey(provider));
        this.status.set(id, {
          configured: Boolean(auth),
          source: auth ? (stored ? 'stored' : typeof auth === 'string' ? auth : 'configured') : undefined,
        });
      } catch (error) {
        this.status.set(id, { configured: false });
        this.report(new Error('Could not determine authentication status for ' + id, { cause: error }));
      }
    }));
  }

  private notify() {
    try {
      this.changed();
    } catch (error) {
      this.report(error);
    }
  }

  list() {
    return [...this.effective.values()].flatMap(({ id: provider, models }) =>
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

  available() {
    return this.enqueue(async () => {
      await this.refreshStatus(this.effective.keys());
      return this.list();
    });
  }

  requestModel(choice: ModelChoice) {
    const provider = this.provider(choice.provider);
    if (!provider) return;
    const model = choice.id ? provider.models.find(({ id }) => id === choice.id) : provider.models[0];
    if (model) return { provider, model };
  }

  resolve(choice: ModelChoice) {
    const selected = this.requestModel(choice);
    return selected && { provider: choice.provider, id: selected.model.id };
  }

  capabilities(choice: ModelChoice) {
    const selected = this.requestModel(choice);
    return selected && capabilities(selected.model);
  }

  providers() {
    const defaults = this.defaultProviders();
    return [...this.effective.values()].map(({ id, name, canSetKey, models, baseUrl, api }) => {
      const override = Object.hasOwn(this.configuration.builtins, id)
        ? this.configuration.builtins[id]
        : undefined;
      return {
        id,
        name,
        configured: this.authStatus(id).configured,
        storedCredential: this.authStatus(id).source === 'stored',
        canSetKey,
        custom: !defaults.has(id),
        baseUrl,
        api,
        models: models.map((model) => ({
          ...capabilities(model),
          templateId: defaults.has(id)
            ? override?.models
              ? override.models.find(({ id }) => id === model.id)?.templateId
              : model.id
            : undefined,
        })),
        defaultBaseUrl: defaults.get(id)?.baseUrl ?? '',
        endpointCustomized: override?.baseUrl !== undefined,
        modelsCustomized: override?.models !== undefined,
      };
    });
  }

  defaultModels(id: string) {
    const builtin = this.defaultProviders().get(id);
    if (!builtin) throw new DomainError('not_found', 'Unknown built-in provider');
    return builtin.models.map((model) => ({ ...capabilities(model), templateId: model.id }));
  }

  authStatus(id: string) {
    return this.status.get(id) ?? { configured: false };
  }

  private async commit(id: string, configuration: ProviderConfiguration, keyChange?: { value?: Credential }) {
    const providers = this.buildCatalog(configuration);
    const previous = keyChange ? await this.credentials.read(id) : undefined;
    const writeKey = (value: Credential | undefined) =>
      value ? this.credentials.modify(id, async () => value) : this.credentials.delete(id);
    const changed = configuration !== this.configuration;
    if (changed) writeJson(this.file, configuration);
    try {
      if (keyChange) await writeKey(keyChange.value);
    } catch (error) {
      try {
        if (changed) writeJson(this.file, this.configuration);
        if (keyChange) await writeKey(previous);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Could not restore provider configuration');
      }
      throw error;
    }
    this.publishCatalog(configuration, providers);
    await this.refreshStatus([id]);
    this.notify();
  }

  saveProvider(input: unknown) {
    return this.enqueue(async () => {
      const values = record(input);
      if (!values) throw invalid('Invalid provider configuration');
      const id = providerId(values.id);
      const builtin = this.defaultProviders().get(id);
      const key = credential(values.key);
      const next = structuredClone(this.configuration);
      if (builtin) {
        if (values.create) throw new DomainError('conflict', 'A provider with this ID already exists');
        if (key && !builtin.canSetKey) throw invalid('This provider does not accept an API key');
        const override = parseOverride(values, builtin);
        if (override.baseUrl !== undefined || override.models !== undefined)
          next.builtins = { ...next.builtins, [id]: override };
        else delete next.builtins[id];
      } else {
        const previous = Object.hasOwn(next.providers, id) ? next.providers[id] : undefined;
        if (values.create && previous)
          throw new DomainError('conflict', 'A provider with this ID already exists');
        if (!values.create && !previous) throw new DomainError('not_found', 'Unknown provider');
        next.providers = {
          ...next.providers,
          [id]: parseCustom(id, {
            ...values,
            apiKey: previous?.apiKey,
            headers: previous?.headers,
          }),
        };
      }
      await this.commit(id, next, key ? { value: { type: 'api_key', key } } : undefined);
      return id;
    });
  }

  removeProvider(input: unknown) {
    return this.enqueue(async () => {
      const id = providerId(record(input)?.id);
      if (!this.provider(id)) throw new DomainError('not_found', 'Unknown provider');
      const next = structuredClone(this.configuration);
      delete next.providers[id];
      delete next.builtins[id];
      await this.commit(id, next, {});
      return id;
    });
  }

  storeCredential(id: string, key: string) {
    return this.enqueue(async () => {
      if (!this.provider(id)) throw invalid('Unknown provider');
      const value = credential(key);
      if (!value) throw invalid('Invalid credential');
      await this.commit(id, this.configuration, { value: { type: 'api_key', key: value } });
    });
  }

  removeCredential(id: string) {
    return this.enqueue(() => this.commit(id, this.configuration, {}));
  }

  async close() {
    await this.writes;
    await this.credentials.settle();
  }

  async apiKey(provider: CatalogProvider) {
    const stored = await this.credentials.read(provider.id);
    const key =
      (stored?.type === 'api_key' ? stored.key : undefined) ??
      (provider.key ? (process.env[provider.key] ?? provider.key) : undefined);
    return key || undefined;
  }

  async discoverModels(input: unknown, signal: AbortSignal) {
    const values = record(input);
    if (!values) throw invalid('Invalid model discovery configuration');
    const id = values.id ? providerId(values.id) : undefined;
    const api = protocol(values.api);
    const baseUrl = endpoint(values.baseUrl);
    let key = credential(values.key);
    const provider = id ? this.provider(id) : undefined;
    // A draft endpoint only receives credentials typed into the draft.
    if (!key && provider?.baseUrl === baseUrl && provider.api === api)
      key =
        (provider.discoveryKey
          ? await provider.discoveryKey(await this.credentials.read(provider.id), signal)
          : await this.apiKey(provider)) ?? '';
    return discover({ api, baseUrl }, key, signal);
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
