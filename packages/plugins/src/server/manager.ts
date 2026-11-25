import { assertOutsideMountTransaction, withMountTransaction } from '@mini-harness/plugin-api/mutation-api';
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
import { localPluginIdPattern, isScopeAddress } from '@mini-harness/plugin-api/selection';
import { isDeepStrictEqual } from 'node:util';
import type { ProfileRuntime } from '@mini-harness/plugin-api/profile';
import type { ScopeAddress, ScopeSettings } from '@mini-harness/plugin-api/configuration';
import type { ScopeBinding, ProfileScopes } from '@mini-harness/plugin-api/configuration';
import { planBrowser, publishBrowser } from './browser-assets.ts';
import { addAbortListener } from 'node:events';
import type { UpgradeHandler } from '@mini-harness/transport/routes';
import { scopeAddresses, type ProfileConfiguration } from '@mini-harness/plugin-api/configuration';
import { pluginData, pluginSecrets, removeScopeData } from './data.ts';
import { PluginRouteRegistry, scopeOperation } from './routes.ts';
import { pluginSettings } from './plugin-settings.ts';
import { pluginInstance } from '@mini-harness/plugin-api/instance';
import { scopeOf, tagScope } from '@mini-harness/plugin-api/scopes';
import { changedSelection, PluginCatalog } from './catalog.ts';

/** Empty scope configuration inherits the parent's composition. */
function hasComposition(scope: ScopeSettings | undefined): scope is ScopeSettings {
  return !!scope && (Object.keys(scope.entries ?? {}).length > 0 || !!scope.isolate?.length);
}

/** The descriptor and its resolved graph are the source of both server and browser mounts. */
export class PluginHost implements ProfileScopes {
  private readonly catalog: PluginCatalog;
  private readonly entries: EntryTree;
  private readonly ownsTree: boolean;
  private readonly pluginRoutes: PluginRouteRegistry;
  private scopes = new Map<ScopeAddress, EntryGroup>();
  private started = false;
  private readonly scopeSources = new Map<
    string,
    { resolve: (id: string) => ScopeBinding | undefined; eager: boolean }
  >();
  private applying?: Promise<void>;
  private closing = false;

  constructor(
    readonly ctx: Context,
    private readonly directory: string,
    profile: Pick<ProfileRuntime, 'builtin' | 'source'>,
    private readonly settings: () => ProfileConfiguration,
    upgrade?: (path: string, handler: UpgradeHandler) => () => Promise<void>,
    private readonly writePlugin?: (
      id: string,
      key: ScopeAddress | undefined,
      patch: unknown,
      check: () => void,
    ) => Promise<void>,
    private readonly owner = ctx,
    entries?: EntryTree,
  ) {
    this.entries = entries ?? new EntryTree();
    this.ownsTree = entries === undefined;
    this.pluginRoutes = new PluginRouteRegistry(ctx, upgrade);
    const directoryData = join(dirname(directory), 'plugin-data');
    const services = {
      harnessPluginRoutes: this.pluginRoutes.service(),
      harnessPluginSettings: pluginSettings(ctx, writePlugin),
      harnessPluginData: pluginData(directoryData),
      harnessPluginSecrets: pluginSecrets(directoryData),
      harnessPluginChanges: Service.track({
        invalidate() {
          const caller = Service.caller(this);
          caller.fiber.signal.throwIfAborted();
          ctx.harnessChanges.invalidate('plugin:' + pluginInstance(caller).pluginId);
        },
      }),
    };
    for (const [name, value] of Object.entries(services)) this.owner.provide(name, value);
    this.catalog = new PluginCatalog(profile);
  }

  private browserState = publishBrowser([], [], () => false);
  private failures = new Map<string, string>();

  browser() {
    return structuredClone(this.browserState.entries);
  }

  async writeBrowserConfig(id: string, patch: unknown, signal: AbortSignal) {
    if (!this.writePlugin) throw new DomainError('unavailable', 'Plugin settings are unavailable');
    await this.writePlugin(id, undefined, patch, () => {
      signal.throwIfAborted();
      if (!this.browserState.configurable.has(id))
        throw new DomainError('not_found', 'Plugin settings are unavailable');
    });
  }

  diagnostics() {
    return [...this.entries.values()].flatMap(({ active, options, fiber }) => {
      if (!active || !fiber) return [];
      const identity = pluginInstance(fiber.ctx);
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
          scope: identity.scopeAddress?.split(':')[0] ?? 'application',
          source: this.catalog.reserved(identity.pluginId) ? 'built-in' : 'local',
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
      this.settings(),
      this.failures,
      (id) =>
        this.entries.get(id)?.active === true || this.browserState.entries.some((entry) => entry.id === id),
    );
  }
  register(kind: string, resolve: (id: string) => ScopeBinding | undefined, eager = false) {
    if (this.scopeSources.has(kind)) throw new Error('Scope source already registered: ' + kind);
    this.scopeSources.set(kind, { resolve, eager });
    return () => {
      this.scopeSources.delete(kind);
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
    const settings = this.settings();
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

  require<Name extends keyof Context & string>(
    key: ScopeAddress | null | undefined,
    service: Name,
  ): NonNullable<Context[Name]> {
    const value = this.context(key).get(service);
    if (value == null) {
      for (const ancestor of key ? [...this.address(key)].reverse() : []) {
        if (!this.scopes.get(ancestor)?.isolated.includes(service)) continue;
        const failure = [...this.failures].find(([instance]) => instance.startsWith(ancestor + '/'));
        if (failure) throw new DomainError('unavailable', failure[1]);
        break;
      }
      throw new Error('Required service is unavailable: ' + service + (key ? ' in ' + key : ''));
    }
    return value;
  }

  async prepare(key: ScopeAddress, signal?: AbortSignal) {
    assertOutsideMountTransaction();
    if (this.closing) throw new Error('Plugin host is closing');
    signal?.throwIfAborted();
    while (this.applying) {
      const current = this.applying.catch(() => {});
      if (!signal) {
        await current;
        continue;
      }
      let listener: ReturnType<typeof addAbortListener> | undefined;
      try {
        await Promise.race([
          current,
          new Promise<never>((_, reject) => {
            listener = addAbortListener(signal, () => reject(signal.reason));
          }),
        ]);
      } finally {
        listener?.[Symbol.dispose]();
      }
    }
    signal?.throwIfAborted();
    if (this.closing) throw new Error('Plugin host is closing');
    const ancestry = this.ancestry(key);
    if (!ancestry.length) throw new DomainError('not_found', 'Plugin scope not found: ' + key);
    if (!this.started) return;
    const settings = this.settings();
    if (!ancestry.some((item) => hasComposition(settings.scopes[item]) && !this.scopes.has(item))) return;
    await this.apply(settings, () => {}, false, key);
    signal?.throwIfAborted();
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
    const instances = new Map<string, { key: ScopeAddress; plugin: string }>();
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
      const plans = this.catalog.plans(settings, descriptors, key, (id, error) =>
        unavailable(id, error, key),
      );
      const isolates = [...new Set(overrides.isolate)].sort();
      const existing = this.scopes.get(key);
      const group = existing?.matches(parent, isolates) ? existing : new EntryGroup(parent, isolates);
      if (group !== existing) tagScope(group.context, address.key);
      const { context } = group;
      if (active.has(key)) {
        contexts.set(key, group);
        for (const plan of plans) {
          if (!plan.descriptor.plugin) continue;
          const id = key + '/' + plan.id;
          entries.push(this.catalog.entry(plan, context, id));
          instances.set(id, { key, plugin: plan.id });
        }
      }
      planned.set(key, context);
      return context;
    };
    for (const key of new Set([...scopeAddresses(settings), ...active])) {
      this.ancestry(key); // validate domain ancestry before evaluating scope selections
      visit(key);
    }
    return { contexts, entries, instances };
  }

  async requestScope(plugin: string, key: string, operation: string, input: unknown, signal: AbortSignal) {
    if (!isScopeAddress(key) || !localPluginIdPattern.test(plugin) || !scopeOperation.test(operation))
      throw new DomainError('invalid_input', 'Invalid scoped plugin request');
    if (!this.lookup(key)) throw new DomainError('not_found', 'Plugin scope not found');
    await this.prepare(key, signal);
    const instance = key + '/' + plugin;
    const handler = this.pluginRoutes.get(instance, operation);
    if (!this.lookup(key) || !this.entries.get(instance)?.active || !handler) {
      const failure = this.failures.get(instance);
      if (failure) throw new DomainError('unavailable', failure);
      throw new DomainError('not_found', 'Scoped plugin request is unavailable');
    }
    return handler(input, signal);
  }

  browserAsset(url: string) {
    return this.browserState.assets.get(url);
  }

  async start(settings: ProfileConfiguration) {
    await this.apply({ ...settings, scopes: {} }, () => {}, true);
    await this.ctx.parallel('harness/ready');
    await this.apply(this.settings(), () => {}, true);
  }

  async configure(settings: ProfileConfiguration, commit = () => {}, released?: ReadonlySet<ScopeAddress>) {
    assertOutsideMountTransaction();
    while (this.applying) await this.applying.catch(() => {});
    if (this.closing) throw new Error('Plugin host is closing');
    await this.apply(settings, commit, false, undefined, released);
    if (released?.size) removeScopeData(join(dirname(this.directory), 'plugin-data'), released);
  }

  private apply(
    settings: ProfileConfiguration,
    commit: () => void,
    starting: boolean,
    preparing?: ScopeAddress,
    released?: ReadonlySet<ScopeAddress>,
  ) {
    const work = withMountTransaction(() =>
      Promise.resolve().then(() => this.configureGraph(settings, commit, starting, preparing, released)),
    );
    this.applying = work;
    return work.finally(() => {
      if (this.applying === work) this.applying = undefined;
    });
  }

  private async configureGraph(
    settings: ProfileConfiguration,
    commit: () => void,
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
    const previous = this.settings();
    const descriptors = await this.catalog.runtimeDescriptors(settings);
    const updating = !starting && !preparing && !released;
    if (updating) this.catalog.validateDisabled(descriptors, previous, settings);
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
    const plans = this.catalog.plans(settings, descriptors, undefined, unavailable);
    const changedScopes = updating
      ? scopeAddresses(settings).filter((key) =>
          Object.entries(settings.scopes[key]?.entries ?? {}).some(
            ([id, entry]) => entry.disabled !== true && changedSelection(id, previous, settings, key),
          ),
        )
      : [];
    const scoped = this.scopedEntries(settings, descriptors, unavailable, preparing, released, changedScopes);
    const mounts = [
      ...plans
        .filter(({ id, descriptor }) => descriptor.plugin && !failures.has(id))
        .map((plan) => this.catalog.entry(plan, this.ctx)),
      ...scoped.entries,
    ];
    const nextEntries = new Map(mounts.map((entry) => [entry.id, entry]));
    const scopeChanges = new Set(
      [...scopeAddresses(previous), ...scopeAddresses(settings)].filter(
        (key) => !isDeepStrictEqual(previous.scopes[key]?.isolate, settings.scopes[key]?.isolate),
      ),
    );
    let appChanged = false;
    for (const id of new Set([...previousEntries.map(({ id }) => id), ...nextEntries.keys()])) {
      const before = this.entries.get(id);
      const after = nextEntries.get(id);
      if (
        before &&
        after &&
        before.matches(after) &&
        (after.live || isDeepStrictEqual(before.options.config, after.config))
      )
        continue;
      const slash = id.indexOf('/');
      if (slash < 0) appChanged = true;
      else scopeChanges.add(id.slice(0, slash) as ScopeAddress);
    }
    const release =
      !starting && !preparing && !released && (appChanged || scopeChanges.size)
        ? this.ctx.get('harnessMutations')?.protect(appChanged ? undefined : scopeChanges)
        : undefined;
    try {
      // An Entry cannot dispose the Fiber whose active configuration transaction
      // is awaiting that disposal. The actual control-plane dependencies require restart.
      if (updating) {
        const visited = new Set<Context['fiber']>();
        const check = (fiber: Context['fiber']) => {
          if (visited.has(fiber)) return;
          visited.add(fiber);
          const entry = fiber.entry && this.entries.get(fiber.entry.options.id);
          if (entry) {
            const next = mounts.find(({ id }) => id === entry.options.id);
            if (!next || !entry.matches(next) || !isDeepStrictEqual(next.config, entry.options.config))
              throw new DomainError(
                'conflict',
                'Changing ' + entry.options.id + ' requires a Profile restart',
              );
          }
          for (const provision of Object.values(fiber.committed ?? {}))
            if (provision) check(provision.ctx.fiber);
        };
        check(this.owner.fiber);
      }
      const activationErrors = await this.entries.update(mounts);
      for (const mounted of mounts) {
        if (!activationErrors.has(mounted.id)) continue;
        const scope = scoped.instances.get(mounted.id);
        const error = activationErrors.get(mounted.id);
        if (!(scope ? unavailable(scope.plugin, error, scope.key) : unavailable(mounted.id, error)))
          throw error;
      }
      {
        const browserState = publishBrowser(
          planBrowser(plans, (id) => this.entries.get(id)?.fiber?.effectiveConfig),
          plans,
          (id) => !failures.has(id),
        );
        commit();
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
        for (const id of previousActive) {
          const restored = this.entries.get(id);
          if (!restored?.active || restored.error)
            throw new Error('Could not reactivate plugin ' + id, { cause: restored?.error });
        }
      } catch (restore) {
        throw new AggregateError([error, restore], 'Could not restore plugin configuration');
      }
      throw error;
    } finally {
      release?.();
    }
  }

  async close() {
    this.closing = true;
    await this.applying?.catch(() => {});
    try {
      if (this.ownsTree) await withMountTransaction(() => this.entries.close());
    } finally {
      this.scopes.clear();
    }
  }
}
