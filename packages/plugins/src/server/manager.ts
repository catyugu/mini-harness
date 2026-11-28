import { AsyncLocalStorage } from 'node:async_hooks';
import { mergeSettings } from '@mini-harness/plugin-api/selection';
import { DomainError } from '@mini-harness/platform/errors';
import { dirname, join } from 'node:path';
import { EntryTree, Service, ValidationError, Context } from 'mini-harness/cordis';
import { isDeepStrictEqual } from 'node:util';
import type { ProfileConfigurationPort, ProfileRuntime } from '@mini-harness/plugin-api/profile';
import type { ScopeAddress, ScopeSettings } from '@mini-harness/plugin-api/configuration';
import type { ScopeResolver, ProfileScopes } from '@mini-harness/plugin-api/configuration';
import { publishBrowser } from './browser-assets.ts';
import { waitFor } from '@mini-harness/platform/wait';
import { scopeAddresses, type ProfileConfiguration } from '@mini-harness/plugin-api/configuration';
import { pluginData, pluginSecrets, removeScopeData } from './data.ts';
import { pluginSettings } from './plugin-settings.ts';
import { entryFiber } from '@mini-harness/plugin-api/plugin-configuration';
import { entryAddress } from './entry-address.ts';
import { tagScope } from '@mini-harness/plugin-api/scopes';
import { changedSelection, PluginCatalog } from './catalog.ts';
import { isScopeEntry, lookupScope, scopeEntry, sourceName, type MountedScope } from './scope-composition.ts';

/** Empty scope configuration inherits the parent's composition. */
function hasComposition(scope: ScopeSettings | undefined): scope is ScopeSettings {
  return !!scope && (Object.keys(scope.entries ?? {}).length > 0 || !!scope.isolate?.length);
}

/** The descriptor and its resolved graph are the source of both server and browser mounts. */
export class PluginHost implements ProfileScopes, ProfileConfigurationPort {
  private readonly catalog: PluginCatalog;
  private readonly entries: EntryTree;
  private readonly ownsTree: boolean;
  private readonly scopes = new Map<ScopeAddress, MountedScope>();
  private readonly scopeFailures = new Map<ScopeAddress, unknown>();
  private applying?: Promise<void>;
  private readonly lifecycle = new AsyncLocalStorage<object>();
  private transaction?: object;
  private pending = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private closing = false;
  private graphReady = false;

  constructor(
    readonly ctx: Context,
    private readonly directory: string,
    private readonly profile: Pick<ProfileRuntime, 'locate' | 'source' | 'read' | 'commit'>,
    private readonly owner = ctx,
    entries?: EntryTree,
  ) {
    this.entries = entries ?? new EntryTree();
    this.ownsTree = entries === undefined;
    const directoryData = join(dirname(directory), 'plugin-data');
    const services = {
      harnessPluginSettings: pluginSettings(this.writePlugin.bind(this), this.subscribe.bind(this)),
      harnessPluginData: pluginData(directoryData),
      harnessPluginSecrets: pluginSecrets(directoryData),
      harnessPluginChanges: Service.track({
        invalidate() {
          const caller = Service.caller(this);
          caller.fiber.signal.throwIfAborted();
          const entry = entryFiber(caller)?.entry;
          if (entry) ctx.get('harnessChanges')?.invalidate('plugin:' + entryAddress(entry.options.id).id);
        },
      }),
    };
    for (const [name, value] of Object.entries(services)) this.owner.provide(name, value);
    this.catalog = new PluginCatalog(profile);
  }

  private browserState = publishBrowser([], () => false);
  private failures = new Map<string, string>();

  browser() {
    return structuredClone(this.browserState.entries);
  }

  async writeBrowserConfig(id: string, patch: unknown, signal: AbortSignal) {
    await this.writePlugin(
      id,
      undefined,
      patch,
      () => {
        if (!this.browserState.configurable.has(id))
          throw new DomainError('not_found', 'Plugin settings are unavailable');
      },
      signal,
    );
  }

  get settings() {
    return this.profile.read();
  }

  get stable() {
    return this.graphReady && !this.applying && !this.closing;
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publish() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        this.ctx.logger.error(error);
      }
    }
  }

  private async enqueue<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.assertCanWait();
    if (this.closing) throw new DomainError('unavailable', 'Profile configuration is closing');
    signal?.throwIfAborted();
    const work = this.pending.then(async () => {
      while (this.applying)
        await waitFor(
          this.applying.catch(() => {}),
          signal,
        );
      signal?.throwIfAborted();
      return operation();
    });
    this.pending = work.then(
      () => {},
      () => {},
    );
    return waitFor(work, signal);
  }

  update(patch: unknown, signal?: AbortSignal) {
    return this.enqueue(async () => {
      const next = mergeSettings(this.settings, patch);
      await this.apply(next, false);
      return this.settings;
    }, signal);
  }

  forgetScopes(keys: ScopeAddress[], signal?: AbortSignal) {
    return this.enqueue(async () => {
      const released = new Set(keys);
      const scopes = { ...this.settings.scopes };
      for (const key of keys) delete scopes[key];
      const next = { ...this.settings, scopes };
      await this.apply(next, false, released);
      if (released.size) removeScopeData(join(dirname(this.directory), 'plugin-data'), released);
    }, signal);
  }

  private writePlugin(
    id: string,
    key: ScopeAddress | undefined,
    patch: unknown,
    check: () => void,
    signal?: AbortSignal,
  ) {
    return this.enqueue(async () => {
      check();
      const values = configurationPatch(patch);
      const entries = key ? this.settings.scopes[key]?.entries : this.settings.entries;
      const entry = entries?.[id];
      const config = { ...entry?.config, ...values };
      const next = mergeSettings(
        this.settings,
        key
          ? {
              scopes: {
                ...this.settings.scopes,
                [key]: {
                  ...this.settings.scopes[key],
                  entries: { ...entries, [id]: { ...entry, config } },
                },
              },
            }
          : { entries: { [id]: { config } } },
      );
      if (isDeepStrictEqual(next, this.settings)) return;
      await this.apply(next, false);
    }, signal);
  }

  private *mountedEntries() {
    for (const entry of this.entries.values()) if (!isScopeEntry(entry.options)) yield entry;
    for (const { tree } of this.scopes.values()) yield* tree.values();
  }

  private entry(id: string) {
    const { scope } = entryAddress(id);
    return scope ? this.scopes.get(scope)?.tree.get(id) : this.entries.get(id);
  }

  diagnostics() {
    return [...this.mountedEntries()].flatMap(({ active, options, fiber }) => {
      if (!active || !fiber) return [];
      const { scope } = entryAddress(options.id);
      const inject = Object.keys(fiber.inject);
      const services = Object.fromEntries(
        inject.flatMap((name) => {
          const provider = fiber.committed?.[name]?.ctx.fiber;
          return provider ? [[name, provider.entry?.options.id ?? 'application']] : [];
        }),
      );
      return [
        {
          id: options.id,
          services,
          provides: [...fiber.provisions].map(({ name }) => name),
          scope: scope?.split(':')[0] ?? 'application',
          source: this.catalog.origin(options.id),
        },
      ];
    });
  }

  metadata() {
    const failures = new Map(this.failures);
    for (const { id, scopeAddress } of this.catalog.descriptors()) {
      if (!scopeAddress) continue;
      const instance = scopeAddress + '/' + id;
      const error = this.entry(instance)?.error ?? this.scopeFailures.get(scopeAddress);
      if (error !== undefined) failures.set(instance, failureMessage(id, error));
      else if (this.entry(instance)?.active) failures.delete(instance);
    }
    return this.catalog.metadata(
      failures,
      (id) => this.entry(id)?.active === true || this.browserState.entries.some((entry) => entry.id === id),
    );
  }

  register(owner: Context, namespace: string, resolve: ScopeResolver) {
    return owner.provide(sourceName(namespace), resolve);
  }

  changed(address: ScopeAddress) {
    return this.ctx.parallel('profile/scope-changed', address);
  }

  private lookup(key: ScopeAddress) {
    return lookupScope(this.ctx, key);
  }

  private ancestry(key: ScopeAddress) {
    const ancestors = new Set<ScopeAddress>();
    for (let current: ScopeAddress | undefined = key; current; ) {
      const address = this.lookup(current);
      if (!address) break;
      if (ancestors.has(current)) throw new Error('Cyclic scope ancestry: ' + current);
      ancestors.add(current);
      current = address.parent;
    }
    return [...ancestors].reverse();
  }

  context(key?: ScopeAddress | null) {
    if (!key) return this.ctx;
    const ancestry = this.ancestry(key);
    if (!ancestry.length) throw new DomainError('not_found', 'Plugin scope not found: ' + key);
    const settings = this.settings;
    for (const ancestor of ancestry)
      if (hasComposition(settings.scopes[ancestor]) && !this.scopes.has(ancestor))
        throw new DomainError('unavailable', 'Plugin scope is not prepared: ' + ancestor);
    const context =
      ancestry
        .reverse()
        .map((item) => this.scopes.get(item)?.context)
        .find(Boolean) ?? this.ctx;
    const scope = this.lookup(key)!.key;
    return tagScope(this.ctx.extend({ [Context.isolate]: context[Context.isolate] }), scope);
  }

  address(key: ScopeAddress) {
    return this.ancestry(key);
  }

  private assertCanWait() {
    if (this.transaction && this.lifecycle.getStore() === this.transaction)
      throw new DomainError('conflict', 'A plugin lifecycle callback cannot wait for its own Profile update');
  }

  async prepare(key: ScopeAddress, signal?: AbortSignal) {
    while (this.applying) {
      this.assertCanWait();
      await waitFor(
        this.applying.catch(() => {}),
        signal,
      );
    }
    signal?.throwIfAborted();
    if (this.closing) throw new DomainError('unavailable', 'Profile configuration is closing');
    const ancestry = this.ancestry(key);
    if (!ancestry.length) throw new DomainError('not_found', 'Plugin scope not found: ' + key);
    const entries = ancestry.filter((address) => hasComposition(this.settings.scopes[address]));
    if (entries.length)
      await waitFor(this.entries.settle(entries.map((address) => '@scope/' + address)), signal);
  }

  private scopedEntries(
    settings: ProfileConfiguration,
    descriptors: ReturnType<PluginCatalog['descriptors']>,
    unavailable: (id: string, error: unknown, key?: ScopeAddress) => boolean,
  ) {
    const configured = new Set(
      scopeAddresses(settings).filter((key) => hasComposition(settings.scopes[key])),
    );
    return [...configured].map((key) => {
      const scope = settings.scopes[key]!;
      const plans = this.catalog.plans(descriptors, key, (id, error) => unavailable(id, error, key));
      return scopeEntry(
        this.ctx,
        key,
        configured,
        this.ancestry(key).filter((item) => item !== key),
        [...new Set(scope.isolate)].sort(),
        (context) => this.catalog.entries(plans, context, key),
        this.scopes,
        this.scopeFailures,
      );
    });
  }

  browserAsset(url: string) {
    return this.browserState.assets.get(url);
  }

  async start() {
    await this.apply({ ...this.settings, scopes: {} }, true);
    await this.ctx.parallel('harness/ready');
    await this.apply(this.settings, true);
    this.graphReady = true;
    this.publish();
    this.graphSettled();
  }

  private graphSettled() {
    if (this.stable)
      void this.ctx.parallel('profile/graph-settled').catch((error) => this.ctx.logger.error(error));
  }

  private async apply(
    settings: ProfileConfiguration,
    starting: boolean,
    released?: ReadonlySet<ScopeAddress>,
  ) {
    const changed = !starting && !isDeepStrictEqual(settings, this.settings);
    const transaction = (this.transaction = {});
    const work = this.lifecycle.run(transaction, () =>
      Promise.resolve().then(() => this.configureGraph(settings, starting, released)),
    );
    this.applying = work;
    try {
      await work;
      if (!starting) {
        this.graphReady = true;
        if (changed) this.publish();
      }
      try {
        this.ctx.get('harnessChanges')?.invalidate('plugins');
      } catch (error) {
        this.ctx.logger.error(error);
      }
    } finally {
      if (this.applying === work) {
        this.applying = undefined;
        this.transaction = undefined;
        this.graphSettled();
      }
    }
  }

  private async configureGraph(
    settings: ProfileConfiguration,
    starting: boolean,
    released?: ReadonlySet<ScopeAddress>,
  ) {
    const oldEntries = [...this.entries.values()];
    const previousActive = new Set(
      [...this.mountedEntries()].filter((entry) => entry.active).map(({ options }) => options.id),
    );
    const previousEntries = oldEntries.map(({ options }) => options);
    const failures = new Map<string, string>();
    const previous = this.settings;
    const descriptors = await this.catalog.runtimeDescriptors(settings);
    const updating = !starting && !released;
    const unavailable = (id: string, error: unknown, key?: ScopeAddress) => {
      const instance = key ? key + '/' + id : id;
      const message = failureMessage(id, error);
      if (updating && changedSelection(id, previous, settings, key))
        throw new DomainError(
          error instanceof DomainError ? error.code : 'invalid_input',
          'Plugin ' + instance + ': ' + message,
          { cause: error },
        );
      if (previousActive.has(instance)) return false;
      failures.set(instance, message);
      return true;
    };
    const plans = this.catalog.plans(descriptors, undefined, unavailable);
    const mounts = [
      ...this.catalog.entries(plans, this.ctx),
      ...this.scopedEntries(settings, descriptors, unavailable),
    ];
    const owner = this.owner.fiber.entry;
    if (updating && owner) {
      const entry = this.entries.get(owner.options.id);
      const next = mounts.find(({ id }) => id === owner.options.id);
      if (entry && (!next || !entry.matches(next) || !isDeepStrictEqual(entry.options.config, next.config)))
        throw new DomainError('conflict', 'Changing ' + owner.options.id + ' requires a Profile restart');
    }
    try {
      const activationErrors = await this.entries.update(mounts);
      for (const entry of this.mountedEntries()) {
        if (entry.error === undefined) continue;
        const { id, scope } = entryAddress(entry.options.id);
        if (!unavailable(id, entry.error, scope)) throw entry.error;
      }
      for (const mount of mounts) {
        if (!isScopeEntry(mount)) continue;
        const error = this.scopeFailures.get(mount.scope) ?? activationErrors.get(mount.id);
        if (error === undefined) continue;
        for (const [id, entry] of Object.entries(settings.scopes[mount.scope]?.entries ?? {})) {
          if (!entry.disabled && !unavailable(id, error, mount.scope)) throw error;
        }
      }
      {
        const browserState = publishBrowser(
          plans,
          (id) => !failures.has(id),
          (id) => this.entries.get(id)?.fiber?.effectiveConfig,
        );
        if (!starting && !isDeepStrictEqual(settings, previous)) this.profile.commit(settings);
        this.catalog.commit(descriptors);
        this.failures = failures;
        this.browserState = browserState;
      }
    } catch (error) {
      try {
        await this.entries.update(previousEntries);
        for (const id of previousActive) {
          const restored = this.entry(id);
          if (!restored?.active || restored.error)
            throw new Error('Could not reactivate plugin ' + id, { cause: restored?.error });
        }
      } catch (restore) {
        this.graphReady = false;
        throw new AggregateError([error, restore], 'Could not restore plugin configuration');
      }
      throw error;
    }
  }

  drain() {
    this.closing = true;
    return this.pending;
  }

  async close() {
    await this.drain();
    await this.applying?.catch(() => {});
    try {
      if (this.ownsTree) await this.entries.close();
    } finally {
      this.scopes.clear();
      this.scopeFailures.clear();
    }
  }
}

function configurationPatch(patch: unknown): Record<string, unknown> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch))
    throw new DomainError('invalid_input', 'Expected a plugin configuration object');
  try {
    return JSON.parse(
      JSON.stringify(patch, (_key, value: unknown) => {
        if (
          (typeof value === 'number' && !Number.isFinite(value)) ||
          ['undefined', 'function', 'symbol', 'bigint'].includes(typeof value)
        )
          throw new Error('Invalid JSON value');
        return value;
      }),
    );
  } catch {
    throw new DomainError('invalid_input', 'Plugin settings must be JSON values');
  }
}

function failureMessage(id: string, error: unknown) {
  if (error instanceof ValidationError)
    return 'Invalid configuration for plugin: ' + id + ': ' + error.message;
  return error instanceof Error ? error.message : String(error);
}
