import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { DomainError } from '@mini-harness/platform/errors';
import { readJson, writeJson } from '@mini-harness/platform/json';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import type { ProviderInfo, ProviderModelDefinition } from '../shared/catalog.ts';
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
  snapshot(id: string) {
    const values = this.values();
    return Object.hasOwn(values, id) ? values[id] : undefined;
  }
  async read(id: string) {
    await this.writes;
    return this.snapshot(id);
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
  private defaults = new Set<readonly CatalogProvider[]>();
  private configuration: ProviderConfiguration = { providers: {}, builtins: {} };
  private readonly status = new Map<string, AuthStatus>();
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
    return this.enqueue(() =>
      this.publishCatalog(parseConfiguration(readJson(this.file, { providers: {} }))),
    );
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
    for (const id of ids ?? this.effective.keys()) this.refreshStatus(id, true);
    this.notify('catalog');
  }

  private setStatus(id: string, value: AuthStatus, publish: boolean) {
    const previous = this.status.get(id);
    this.status.set(id, value);
    if (publish && (previous?.configured !== value.configured || previous?.source !== value.source))
      this.notify('auth');
  }

  /** Join existing checks; replacements abort and drain their predecessor before starting. */
  private refreshStatus(id: string, replace = false) {
    const provider = this.effective.get(id);
    if (!provider || this.lifetime.signal.aborted) return;
    const previous = this.checks.get(id);
    if (previous && !replace && !previous.controller.signal.aborted) return;
    previous?.controller.abort();
    let credential: Credential | undefined;
    try {
      credential = this.credentials.snapshot(id);
    } catch (error) {
      this.report(new Error('Could not read authentication configuration for ' + id, { cause: error }));
      this.setStatus(id, { configured: false }, !replace);
      return;
    }
    const stored = credential ? 'stored' : undefined;
    const check = provider.authStatus;
    if (!check) {
      const configured = Boolean(resolveKey(provider, credential));
      this.setStatus(id, { configured, source: stored ?? (configured ? 'configured' : undefined) }, !replace);
      return;
    }
    if (replace || !this.status.has(id)) this.setStatus(id, { configured: false, source: stored }, false);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
    const work = Promise.resolve()
      .then(async () => {
        await previous?.work;
        if (signal.aborted) return;
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
        let auth: boolean | string = false;
        try {
          const result = await check.call(provider, deadline);
          deadline.throwIfAborted();
          auth = result;
        } catch (error) {
          if (!signal.aborted)
            this.report(
              new Error(
                (deadline.aborted ? 'Authentication check timed out for ' : 'Could not determine authentication status for ') + id,
                { cause: error },
              ),
            );
        }
        if (!signal.aborted)
          this.setStatus(
            id,
            {
              configured: Boolean(auth),
              source: stored ?? (auth ? (typeof auth === 'string' ? auth : 'configured') : undefined),
            },
            true,
          );
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
        configured: this.authStatus(provider).configured,
        thinkingLevels: getSupportedThinkingLevels(model),
      })),
    );
  }

  async available() {
    for (const id of this.effective.keys()) this.refreshStatus(id);
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

  providers(): ProviderInfo[] {
    const defaults = this.defaultProviders();
    return [...this.effective.values()].map(({ id, name, canSetKey, models, baseUrl, api }) => {
      const builtin = defaults.get(id);
      const override =
        builtin && Object.hasOwn(this.configuration.builtins, id)
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

  authStatus(id: string) {
    return this.status.get(id) ?? { configured: false };
  }

  private async commit(id: string, configuration: ProviderConfiguration, key?: string | null) {
    const structural = !isDeepStrictEqual(configuration, this.configuration);
    const providers = structural ? this.buildCatalog(configuration) : undefined;
    if (structural) writeJson(this.file, configuration);
    try {
      if (key === null) await this.credentials.delete(id);
      else if (key !== undefined) await this.credentials.modify(id, async () => ({ type: 'api_key', key }));
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
      this.refreshStatus(id, true);
      this.notify('auth');
    }
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
      await this.commit(id, next, key || undefined);
      return id;
    });
  }

  removeProvider(input: unknown) {
    return this.enqueue(async () => {
      const id = providerId(record(input)?.id);
      if (!this.effective.get(id)) throw new DomainError('not_found', 'Unknown provider');
      const next = structuredClone(this.configuration);
      delete next.providers[id];
      delete next.builtins[id];
      await this.commit(id, next, null);
      return id;
    });
  }

  async close() {
    this.lifetime.abort();
    await this.writes;
    await Promise.all([...this.checks.values()].map(({ work }) => work));
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
