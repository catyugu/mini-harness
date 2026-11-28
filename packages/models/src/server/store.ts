import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { getSupportedThinkingLevels, type Credential, type CredentialStore } from '@earendil-works/pi-ai';
import { DomainError } from '@mini-harness/platform/errors';
import { readJson, writeJson } from '@mini-harness/platform/json';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import type { ProviderInfo, ProviderModelDefinition } from '../shared/pi-provider.ts';
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
import type { CatalogModel, CatalogProvider, ModelStorePort } from './store-api.ts';

export class ModelStore implements ModelStorePort {
  private readonly file: string;
  private readonly authFile: string;
  private storedCredentials?: Record<string, Credential>;
  private defaults = new Set<readonly CatalogProvider[]>();
  private configuration: ProviderConfiguration = { providers: {}, builtins: {} };
  private readonly status = new Map<string, boolean>();
  private readonly checks = new Map<string, { controller: AbortController; work: Promise<void> }>();
  private readonly lifetime = new AbortController();
  private effective = new Map<string, CatalogProvider>();
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    home: string,
    private readonly changed: (kind: 'catalog' | 'auth') => void = () => {},
    private readonly report: (error: unknown) => void = console.warn,
  ) {
    this.file = join(home, 'models.json');
    this.authFile = join(home, 'auth.json');
  }

  private credentialValues() {
    if (!this.storedCredentials) {
      const values = readJson<Record<string, Credential>>(this.authFile, {});
      if (!values || Array.isArray(values) || typeof values !== 'object')
        throw new Error('Invalid credential store');
      this.storedCredentials = values;
    }
    return this.storedCredentials;
  }

  private storedCredential(id: string) {
    const values = this.credentialValues();
    return Object.hasOwn(values, id) ? structuredClone(values[id]) : undefined;
  }

  private writeCredential(id: string, credential: Credential | null) {
    const values = { ...this.credentialValues() };
    if (credential === null) delete values[id];
    else values[id] = credential;
    writeJson(this.authFile, values);
    this.storedCredentials = values;
  }

  readonly credentials: CredentialStore = {
    read: async (id) => {
      await this.writes;
      return this.storedCredential(id);
    },
    list: async () => {
      await this.writes;
      return Object.entries(this.credentialValues()).map(([providerId, { type }]) => ({ providerId, type }));
    },
    modify: (id, modify, options) =>
      this.enqueue(async () => {
        options?.signal?.throwIfAborted();
        const current = this.storedCredential(id);
        const next = await modify(current);
        options?.signal?.throwIfAborted();
        if (next === undefined) return current;
        this.writeCredential(id, next);
        return structuredClone(next);
      }),
    delete: (id, options) =>
      this.enqueue(() => {
        options?.signal?.throwIfAborted();
        this.writeCredential(id, null);
      }),
  };

  private enqueue<T>(work: () => T | Promise<T>) {
    const pending = this.writes.then(work);
    this.writes = pending.catch(() => {});
    return pending;
  }

  registerDefaults(providers: readonly CatalogProvider[]) {
    return this.enqueue(() => {
      const ids = providers.map(({ id }) => id);
      this.replaceDefaults(new Set([...this.defaults, providers]), ids);
      return async () => {
        const retired = await this.enqueue(() => {
          const checks = ids.map((id) => this.checks.get(id)?.work);
          const next = new Set(this.defaults);
          next.delete(providers);
          this.replaceDefaults(next, ids);
          return checks;
        });
        await Promise.all(retired);
      };
    });
  }

  refresh() {
    return this.enqueue(() => {
      const configuration = parseConfiguration(readJson(this.file, { providers: {} }));
      const providers = this.buildCatalog(configuration);
      this.storedCredentials = undefined;
      this.publishCatalog(configuration, undefined, providers);
    });
  }

  private replaceDefaults(next: typeof this.defaults, ids: string[]) {
    const providers = this.buildCatalog(this.configuration, this.defaultProviders(next));
    this.defaults = next;
    this.publishCatalog(this.configuration, ids, providers);
  }

  private defaultProviders(sources = this.defaults) {
    return new Map([...sources].flat().map((provider) => [provider.id, provider] as const));
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
    const connection = { id, api, baseUrl };
    return {
      ...connection,
      name,
      canSetKey: true,
      headers,
      key,
      models: models.map((model) => resolveModel(model, connection)),
    };
  }

  private buildCatalog(configuration: ProviderConfiguration, defaults = this.defaultProviders()) {
    return [
      ...[...defaults.values()].map((provider) => this.builtin(provider, configuration)),
      ...Object.entries(configuration.providers)
        .filter(([id]) => !defaults.has(id))
        .map(([id, config]) => this.custom(id, config)),
    ];
  }

  private publishCatalog(
    configuration: ProviderConfiguration,
    ids?: Iterable<string>,
    providers = this.buildCatalog(configuration),
  ) {
    this.effective = new Map(providers.map((provider) => [provider.id, provider]));
    this.configuration = configuration;
    for (const id of this.status.keys()) {
      if (!this.effective.has(id)) {
        this.checks.get(id)?.controller.abort();
        this.status.delete(id);
      }
    }
    this.refreshStatuses(ids ?? this.effective.keys());
    this.notify('catalog');
  }

  private refreshStatuses(ids: Iterable<string>) {
    if (this.lifetime.signal.aborted) return;
    const providers = [...ids].flatMap((id) => {
      const provider = this.effective.get(id);
      return provider ? [provider] : [];
    });
    if (!providers.length) return;
    let credentials: Readonly<Record<string, Credential>>;
    try {
      credentials = this.credentialValues();
    } catch (error) {
      this.report(new Error('Could not read authentication configuration', { cause: error }));
      for (const { id } of providers) {
        this.checks.get(id)?.controller.abort();
        this.status.set(id, false);
      }
      return;
    }
    for (const provider of providers)
      this.refreshStatus(
        provider,
        Object.hasOwn(credentials, provider.id) ? credentials[provider.id] : undefined,
      );
  }

  /** Only state changes start checks. Replacements drain their cancelled predecessor. */
  private refreshStatus(provider: CatalogProvider, credential: Credential | undefined) {
    const { id } = provider;
    const previous = this.checks.get(id);
    previous?.controller.abort();
    const check = provider.authStatus;
    if (!check) {
      this.status.set(id, Boolean(resolveKey(provider, credential)));
      return;
    }
    this.status.set(id, false);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
    const work = Promise.resolve()
      .then(async () => {
        await previous?.work;
        if (signal.aborted) return;
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
        let configured = false;
        try {
          const result = await check.call(provider, deadline);
          deadline.throwIfAborted();
          configured = result;
        } catch (error) {
          if (!signal.aborted)
            this.report(
              new Error(
                (deadline.aborted
                  ? 'Authentication check timed out for '
                  : 'Could not determine authentication status for ') + id,
                { cause: error },
              ),
            );
        }
        if (!signal.aborted) {
          const previous = this.status.get(id);
          this.status.set(id, configured);
          if (previous !== configured) this.notify('auth');
        }
      })
      .finally(() => {
        if (this.checks.get(id)?.controller === controller) this.checks.delete(id);
      });
    this.checks.set(id, { controller, work });
  }

  private notify(kind: 'catalog' | 'auth') {
    try {
      this.changed(kind);
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
        configured: this.status.get(provider) ?? false,
        thinkingLevels: getSupportedThinkingLevels(model),
      })),
    );
  }

  async available() {
    while (!this.lifetime.signal.aborted) {
      const pending = [...this.effective.keys()].flatMap((id) => {
        const check = this.checks.get(id);
        return check && !check.controller.signal.aborted ? [check.work] : [];
      });
      if (!pending.length) break;
      await Promise.all(pending);
    }
    return this.list();
  }

  protocols() {
    return protocolOptions();
  }

  requestModel(choice: ModelChoice) {
    const provider = this.effective.get(choice.provider);
    if (!provider) return;
    const model = provider.models.find(({ id }) => id === choice.id);
    if (model) return { provider, model };
  }

  resolve(choice: ModelChoice) {
    const selected = this.requestModel(choice);
    return (
      selected && {
        model: { provider: choice.provider, id: selected.model.id },
        capabilities: capabilities(selected.model),
      }
    );
  }

  providers(): ProviderInfo[] {
    const defaults = this.defaultProviders();
    return [...this.effective.values()].map(({ id, name, canSetKey, models, baseUrl, api }) => {
      const builtin = defaults.get(id);
      const override =
        builtin && Object.hasOwn(this.configuration.builtins, id)
          ? this.configuration.builtins[id]
          : undefined;
      return {
        id,
        name,
        configured: this.status.get(id) ?? false,
        storedCredential: Object.hasOwn(this.storedCredentials ?? {}, id),
        canSetKey,
        custom: !builtin,
        baseUrl,
        api,
        models: structuredClone(
          builtin
            ? (override?.models ?? models.map((model) => ({ ...definition(model), templateId: model.id })))
            : this.configuration.providers[id].models,
        ),
        defaultBaseUrl: builtin?.baseUrl ?? '',
        endpointCustomized: override?.baseUrl !== undefined,
        modelsCustomized: override?.models !== undefined,
      };
    });
  }

  defaultModels(id: string): ProviderModelDefinition[] {
    const builtin = this.defaultProviders().get(id);
    if (!builtin) throw new DomainError('not_found', 'Unknown built-in provider');
    return builtin.models.map((model) => ({ ...definition(model), templateId: model.id }));
  }

  private commit(id: string, configuration: ProviderConfiguration, key?: string | null) {
    const structural = !isDeepStrictEqual(configuration, this.configuration);
    const providers = structural ? this.buildCatalog(configuration) : undefined;
    if (structural) writeJson(this.file, configuration);
    try {
      if (key !== undefined) this.writeCredential(id, key === null ? null : { type: 'api_key', key });
    } catch (error) {
      try {
        if (structural) writeJson(this.file, this.configuration);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Could not restore provider configuration');
      }
      throw error;
    }
    if (providers) this.publishCatalog(configuration, [id], providers);
    else if (key !== undefined) {
      this.refreshStatuses([id]);
      this.notify('auth');
    }
  }

  saveProvider(input: unknown) {
    return this.enqueue(() => {
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
        if (override.baseUrl !== undefined || override.models !== undefined) next.builtins[id] = override;
        else delete next.builtins[id];
      } else {
        const previous = Object.hasOwn(next.providers, id) ? next.providers[id] : undefined;
        if (values.create && previous)
          throw new DomainError('conflict', 'A provider with this ID already exists');
        if (!values.create && !previous) throw new DomainError('not_found', 'Unknown provider');
        next.providers[id] = parseCustom(id, {
          ...values,
          apiKey: previous?.apiKey,
          headers: previous?.headers,
        });
      }
      this.commit(id, next, key || undefined);
      return id;
    });
  }

  removeProvider(input: unknown) {
    return this.enqueue(() => {
      const id = providerId(record(input)?.id);
      if (!this.effective.get(id)) throw new DomainError('not_found', 'Unknown provider');
      const next = structuredClone(this.configuration);
      delete next.providers[id];
      delete next.builtins[id];
      this.commit(id, next, null);
      return id;
    });
  }

  async close() {
    this.lifetime.abort();
    await this.writes;
    await Promise.all([...this.checks.values()].map(({ work }) => work));
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
    const provider = id ? this.effective.get(id) : undefined;
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
  return { ...definition(model), thinkingLevels: getSupportedThinkingLevels(model) };
}

function resolveKey(provider: CatalogProvider, stored: Credential | undefined) {
  return (
    ((stored?.type === 'api_key' ? stored.key : undefined) ??
      (provider.key ? (process.env[provider.key] ?? provider.key) : undefined)) ||
    undefined
  );
}
