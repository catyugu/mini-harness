import { AsyncLocalStorage } from 'node:async_hooks';
import { mergeSettings } from '@mini-harness/plugin-api/selection';
import { DomainError } from '@mini-harness/platform/errors';
import { dirname, join } from 'node:path';
import {
  EntryGroup,
  EntryTree,
  Service,
  ValidationError,
  type Context,
  type EntryOptions,
} from 'mini-harness/cordis';
import { isDeepStrictEqual } from 'node:util';
import type { ProfileConfigurationPort, ProfileRuntime } from '@mini-harness/plugin-api/profile';
import type { ScopeAddress, ScopeSettings } from '@mini-harness/plugin-api/configuration';
import type { ScopeBinding, ProfileScopes } from '@mini-harness/plugin-api/configuration';
import { publishBrowser } from './browser-assets.ts';
import { waitFor } from '@mini-harness/platform/wait';
import { scopeAddresses, type ProfileConfiguration } from '@mini-harness/plugin-api/configuration';
import { pluginData, pluginSecrets, removeScopeData } from './data.ts';
import { pluginSettings } from './plugin-settings.ts';
import { entryFiber } from '@mini-harness/plugin-api/plugin-configuration';
import { entryAddress } from './entry-address.ts';
import { scopeOf, tagScope } from '@mini-harness/plugin-api/scopes';
import { changedSelection, PluginCatalog } from './catalog.ts';

/** Empty scope configuration inherits the parent's composition. */
function hasComposition(scope: ScopeSettings | undefined): scope is ScopeSettings {
  return !!scope && (Object.keys(scope.entries ?? {}).length > 0 || !!scope.isolate?.length);
}

/** The descriptor and its resolved graph are the source of both server and browser mounts. */
export class PluginHost implements ProfileScopes, ProfileConfigurationPort {
  private readonly catalog: PluginCatalog;
  private readonly entries: EntryTree;
  private readonly ownsTree: boolean;
  private scopes = new Map<ScopeAddress, EntryGroup>();
  private started = false;
  private scopeGeneration = 0;
  private readonly scopeSources = new Map<
    string,
    { resolve: (id: string) => ScopeBinding | undefined; eager: boolean }
  >();
  private applying?: Promise<void>;
  private readonly lifecycle = new AsyncLocalStorage<object>();
  private transaction?: object;
  private pending = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private closing = false;

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
      this.publish();
      return this.settings;
    }, signal);
  }

  forgetScopes(keys: ScopeAddress[]) {
    return this.enqueue(async () => {
      const released = new Set(keys);
      const scopes = { ...this.settings.scopes };
      for (const key of keys) delete scopes[key];
      const next = { ...this.settings, scopes };
      const changed = !isDeepStrictEqual(next, this.settings);
      await this.apply(next, false, undefined, released);
      if (released.size) removeScopeData(join(dirname(this.directory), 'plugin-data'), released);
      if (changed) this.publish();
    });
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
      this.publish();
    }, signal);
  }

  diagnostics() {
    return [...this.entries.values()].flatMap(({ active, options, fiber }) => {
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

  private configurationContext(key?: ScopeAddress, scopes = this.scopes) {
    if (!key) return this.ctx;
    const keys = this.ancestry(key);
    return (
      keys
        .reverse()
        .map((item) => scopes.get(item))
        .find(Boolean)?.context ?? this.ctx
    );
  }

  metadata() {
    return this.catalog.metadata(
      this.failures,
      (id) =>
        this.entries.get(id)?.active === true || this.browserState.entries.some((entry) => entry.id === id),
    );
  }
  register(kind: string, resolve: (id: string) => ScopeBinding | undefined, eager = false) {
    if (this.scopeSources.has(kind)) throw new Error('Scope source already registered: ' + kind);
    this.scopeSources.set(kind, { resolve, eager });
    this.scopeGeneration++;
    return () => {
      if (this.scopeSources.delete(kind)) this.scopeGeneration++;
    };
  }

  private scopeSource(key: ScopeAddress) {
    return this.scopeSources.get(key.slice(0, key.indexOf(':')));
  }

  private lookup(key: ScopeAddress) {
    const source = this.scopeSource(key);
    return source?.resolve(key.slice(key.indexOf(':') + 1));
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
    const context = this.configurationContext(key);
    const scope = this.lookup(key)!.key;
    return scopeOf(context) === scope ? context : tagScope(context.extend(), scope);
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
    if (!this.started) return;
    if (!ancestry.some((item) => hasComposition(this.settings.scopes[item]) && !this.scopes.has(item)))
      return;
    await waitFor(this.apply(this.settings, false, key), signal);
  }

  private scopedEntries(
    settings: ProfileConfiguration,
    descriptors: ReturnType<PluginCatalog['descriptors']>,
    unavailable: (id: string, error: unknown, key?: ScopeAddress) => boolean,
    preparing?: ScopeAddress,
    released: ReadonlySet<ScopeAddress> = new Set(),
    validating: readonly ScopeAddress[] = [],
  ) {
    const contexts = new Map<ScopeAddress, EntryGroup>();
    const entries: EntryOptions[] = [];
    const active = new Set([
      ...scopeAddresses(settings).filter((key) => this.scopeSource(key)?.eager),
      ...this.scopes.keys(),
      ...validating,
      ...(preparing ? this.ancestry(preparing) : []),
    ]);
    for (const key of active)
      for (const ancestor of this.ancestry(key)) if (!released.has(ancestor)) active.add(ancestor);
    const planned = new Map<ScopeAddress, Context>();
    const root = this.ctx;

    const visit = (key: ScopeAddress): typeof root => {
      const cached = planned.get(key);
      if (cached) return cached;
      const address = this.lookup(key);
      const overrides = settings.scopes[key];
      if (released.has(key)) return root;
      if (!address) {
        // A disabled domain retains its scoped configuration without mounting it.
        if (!this.scopeSource(key)) return root;
        for (const plugin of new Set([
          ...Object.entries(overrides?.entries ?? {})
            .filter(([, entry]) => entry.disabled !== true)
            .map(([id]) => id),
        ])) {
          const error = new Error('Configured scope does not exist: ' + key);
          if (!unavailable(plugin, error, key)) throw error;
        }
        return root;
      }
      const parent = address.parent ? visit(address.parent) : root;
      if (!hasComposition(overrides)) return parent;
      const plans = this.catalog.plans(descriptors, key, (id, error) => unavailable(id, error, key));
      const isolates = [...new Set(overrides.isolate)].sort();
      const existing = this.scopes.get(key);
      const group =
        existing?.matches(parent, isolates) && scopeOf(existing.context) === address.key
          ? existing
          : new EntryGroup(parent, isolates);
      if (group !== existing) tagScope(group.context, address.key);
      const { context } = group;
      if (active.has(key)) {
        contexts.set(key, group);
        for (const plan of plans) {
          if (!plan.descriptor.native?.plugin) continue;
          entries.push(this.catalog.entry(plan, context, key + '/' + plan.id));
        }
      }
      planned.set(key, context);
      return context;
    };
    for (const key of new Set([...scopeAddresses(settings), ...active])) {
      this.ancestry(key); // validate domain ancestry before evaluating scope selections
      visit(key);
    }
    return { contexts, entries };
  }

  browserAsset(url: string) {
    return this.browserState.assets.get(url);
  }

  async start() {
    await this.apply({ ...this.settings, scopes: {} }, true);
    await this.ctx.parallel('harness/ready');
    await this.apply(this.settings, true);
  }

  private apply(
    settings: ProfileConfiguration,
    starting: boolean,
    preparing?: ScopeAddress,
    released?: ReadonlySet<ScopeAddress>,
  ) {
    const transaction = (this.transaction = {});
    const work = this.lifecycle.run(transaction, () =>
      Promise.resolve().then(() => this.configureGraph(settings, starting, preparing, released)),
    );
    this.applying = work;
    return work.finally(() => {
      if (this.applying === work) {
        this.applying = undefined;
        this.transaction = undefined;
      }
    });
  }

  private async configureGraph(
    settings: ProfileConfiguration,
    starting: boolean,
    preparing?: ScopeAddress,
    released?: ReadonlySet<ScopeAddress>,
  ) {
    const oldEntries = [...this.entries.values()];
    const previousActive = new Set(
      oldEntries.filter((entry) => entry.active).map(({ options }) => options.id),
    );
    const previousEntries = oldEntries.map(({ options }) => options);
    const failures = new Map<string, string>();
    const previous = this.settings;
    const descriptors = await this.catalog.runtimeDescriptors(settings);
    const updating = !starting && !preparing && !released;
    const unavailable = (id: string, error: unknown, key?: ScopeAddress) => {
      const instance = key ? key + '/' + id : id;
      const message =
        error instanceof ValidationError
          ? 'Invalid configuration for plugin: ' + id + ': ' + error.message
          : error instanceof Error
            ? error.message
            : String(error);
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
    const changedScopes = updating
      ? scopeAddresses(settings).filter((key) =>
          Object.entries(settings.scopes[key]?.entries ?? {}).some(
            ([id, entry]) => entry.disabled !== true && changedSelection(id, previous, settings, key),
          ),
        )
      : [];
    const application = plans
      .filter(({ id, descriptor }) => descriptor.native?.plugin && !failures.has(id))
      .map((plan) => this.catalog.entry(plan, this.ctx));
    const planScopes = () =>
      this.scopedEntries(settings, descriptors, unavailable, preparing, released, changedScopes);
    let scoped = planScopes();
    let mounts = [...application, ...scoped.entries];
    const owner = this.owner.fiber.entry;
    if (updating && owner) {
      const entry = this.entries.get(owner.options.id);
      const next = mounts.find(({ id }) => id === owner.options.id);
      if (entry && (!next || !entry.matches(next) || !isDeepStrictEqual(entry.options.config, next.config)))
        throw new DomainError('conflict', 'Changing ' + owner.options.id + ' requires a Profile restart');
    }
    const generation = this.scopeGeneration;
    try {
      let activationErrors = await this.entries.update(mounts);
      // Domain providers may register or remove scope resolvers during graph activation.
      // Reconcile their dependent groups against the settled bindings before publishing.
      if (generation !== this.scopeGeneration && !starting) {
        for (const mounted of application) {
          const error = activationErrors.get(mounted.id);
          if (error !== undefined && !unavailable(mounted.id, error)) throw error;
        }
        scoped = planScopes();
        mounts = [...application, ...scoped.entries];
        activationErrors = await this.entries.update(mounts);
      }
      for (const mounted of mounts) {
        if (!activationErrors.has(mounted.id)) continue;
        const error = activationErrors.get(mounted.id);
        const { id, scope } = entryAddress(mounted.id);
        if (!unavailable(id, error, scope)) throw error;
      }
      {
        const browserState = publishBrowser(
          plans,
          (id) => !failures.has(id),
          (id) => this.entries.get(id)?.fiber?.effectiveConfig,
        );
        if (!starting && !preparing && !isDeepStrictEqual(settings, previous)) this.profile.commit(settings);
        this.started = true;
        this.catalog.commit(descriptors);
        this.scopes = scoped.contexts;
        this.failures = failures;
        this.browserState = browserState;
        this.ctx.get('harnessChanges')?.invalidate('plugins');
      }
    } catch (error) {
      try {
        await this.entries.update(previousEntries);
        if (generation !== this.scopeGeneration && !starting) {
          const restored = this.scopedEntries(
            previous,
            this.catalog.descriptors(),
            (id, _error, key) => !previousActive.has(key ? key + '/' + id : id),
          );
          await this.entries.update([
            ...previousEntries.filter(({ id }) => !entryAddress(id).scope),
            ...restored.entries,
          ]);
          this.scopes = restored.contexts;
        }
        for (const id of previousActive) {
          const restored = this.entries.get(id);
          if (!restored?.active || restored.error)
            throw new Error('Could not reactivate plugin ' + id, { cause: restored?.error });
        }
      } catch (restore) {
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
