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
import { discover, protocolOptions } from './protocols.ts';
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
  private readonly status = new Map<string, { value: AuthStatus; checking: boolean }>();
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

  private enqueue<T>(work: () => T | Promise<T>) {
    const pending = this.writes.then(work);
    this.writes = pending.catch(() => {});
    return pending;
  }

  registerDefaults(providers: readonly CatalogProvider[]) {
    return this.enqueue(() => {
      const ids = providers.map(({ id }) => id);
      this.defaults.add(providers);
      this.publishCatalog(this.configuration, ids);
      return () =>
        this.enqueue(() => {
          this.defaults.delete(providers);
          this.publishCatalog(this.configuration, ids);
        });
    });
  }

  refresh() {
    return this.enqueue(() => this.publishCatalog(parseConfiguration(readJson(this.file, { providers: {} }))));
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

  private publishCatalog(
    configuration: ProviderConfiguration,
    ids?: Iterable<string>,
    providers = this.buildCatalog(configuration),
  ) {
    this.effective = new Map(providers.map((provider) => [provider.id, provider]));
    this.configuration = configuration;
    for (const id of this.status.keys()) {
      if (!this.effective.has(id)) this.status.delete(id);
    }
    for (const id of ids ?? this.effective.keys()) void this.refreshStatus(id, true);
    this.notify();
  }

  /** A check owns its result only until the next edit, removal or refresh of that provider. */
  private async refreshStatus(id: string, replace = false) {
    const provider = this.provider(id);
    const current = this.status.get(id);
    if (!provider || (!replace && current?.checking)) return;
    const entry = { value: current?.value ?? { configured: false }, checking: true };
    this.status.set(id, entry);
    let stored = false;
    let auth: boolean | string = false;
    try {
      const credential = await this.credentials.read(id);
      stored = Boolean(credential);
      auth = provider.authStatus ? await provider.authStatus() : Boolean(resolveKey(provider, credential));
    } catch (error) {
      if (this.status.get(id) === entry)
        this.report(new Error('Could not determine authentication status for ' + id, { cause: error }));
    }
    if (this.status.get(id) !== entry) return;
    entry.checking = false;
    const value: AuthStatus = {
      configured: Boolean(auth),
      source: stored ? 'stored' : auth ? (typeof auth === 'string' ? auth : 'configured') : undefined,
    };
    if (entry.value.configured !== value.configured || entry.value.source !== value.source) {
      entry.value = value;
      this.notify();
    }
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

  async available() {
    for (const id of this.effective.keys()) void this.refreshStatus(id);
    return this.list();
  }

  protocols() {
    return protocolOptions();
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
      const builtin = defaults.get(id);
      const override = builtin && Object.hasOwn(this.configuration.builtins, id)
        ? this.configuration.builtins[id]
        : undefined;
      const status = this.authStatus(id);
      return {
        id,
        name,
        configured: status.configured,
        storedCredential: status.source === 'stored',
        canSetKey,
        custom: !builtin,
        baseUrl,
        api,
        models: models.map((model) => {
          const templateId = builtin
            ? override?.models
              ? override.models.find(({ id }) => id === model.id)?.templateId
              : model.id
            : undefined;
          return { ...definition(model), ...(templateId === undefined ? {} : { templateId }) };
        }),
        defaultBaseUrl: builtin?.baseUrl ?? '',
        endpointCustomized: override?.baseUrl !== undefined,
        modelsCustomized: override?.models !== undefined,
      };
    });
  }

  defaultModels(id: string) {
    const builtin = this.defaultProviders().get(id);
    if (!builtin) throw new DomainError('not_found', 'Unknown built-in provider');
    return builtin.models.map((model) => ({ ...definition(model), templateId: model.id }));
  }

  authStatus(id: string) {
    return this.status.get(id)?.value ?? { configured: false };
  }

  private async commit(id: string, configuration: ProviderConfiguration, key?: string | null) {
    const providers = this.buildCatalog(configuration);
    writeJson(this.file, configuration);
    try {
      if (key === null) await this.credentials.delete(id);
      else if (key !== undefined) await this.credentials.modify(id, async () => ({ type: 'api_key', key }));
    } catch (error) {
      try {
        writeJson(this.file, this.configuration);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Could not restore provider configuration');
      }
      throw error;
    }
    if (key !== undefined)
      this.status.set(id, { value: { configured: false, source: key === null ? undefined : 'stored' }, checking: false });
    this.publishCatalog(configuration, [id], providers);
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
        const override = parseOverride(values);
        for (const model of override.models ?? []) {
          if (model.templateId && !builtin.models.some(({ id }) => id === model.templateId))
            throw invalid('Unknown native model template: ' + model.templateId);
          if (!model.templateId && !builtin.api)
            throw invalid('This built-in provider has no protocol for new models');
        }
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
      await this.commit(id, next, key || undefined);
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
      await this.commit(id, next, null);
      return id;
    });
  }

  async close() {
    await this.writes;
    this.status.clear();
    await this.credentials.settle();
  }

  async apiKey(provider: CatalogProvider) {
    return resolveKey(provider, await this.credentials.read(provider.id));
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

function definition({ id, name, input, contextWindow, maxTokens, reasoning }: CatalogModel) {
  return { id, name, input, contextWindow, maxTokens, reasoning };
}

function capabilities(model: CatalogModel) {
  return { ...definition(model), thinkingLevels: model.thinkingLevels };
}

function resolveKey(provider: CatalogProvider, stored: Credential | undefined) {
  return (
    ((stored?.type === 'api_key' ? stored.key : undefined) ??
      (provider.key ? (process.env[provider.key] ?? provider.key) : undefined)) ||
    undefined
  );
}
