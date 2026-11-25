import type {} from '@mini-harness/transport/projection-api';
import type {} from '@mini-harness/settings/api';
import { assertOutsideMountTransaction, withMountTransaction } from '@mini-harness/plugin-api/mutation-api';
import { DomainError } from '@mini-harness/platform/errors';
import { dirname, join } from 'node:path';
import { EntryGroup, EntryTree, Service, type Context, type EntryOptions } from 'mini-harness/cordis';
import { localPluginIdPattern, isScopeKey } from '@mini-harness/plugin-api/selection';
import { isDeepStrictEqual } from 'node:util';
import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import type {
  HostServices,
  PluginScope,
  ScopeAddress,
  ScopeKey,
  ScopePort,
  ScopeSettings,
} from '@mini-harness/plugin-api/scopes';
import { planBrowser, publishBrowser } from './browser-assets.js';
import { addAbortListener } from 'node:events';
import type { UpgradeHandler } from '@mini-harness/transport/routes';
import { scopeKeys, type PluginSettings } from '@mini-harness/plugin-api/configuration';
import { ProtectedProviderError } from './providers.js';
import { bindPluginImports } from './module-resolution.js';
import { pluginData, pluginSecrets, removeScopeData } from './data.js';
import { PluginRouteRegistry, scopeOperation } from './routes.js';
import { pluginSettings } from './plugin-settings.js';
import type {} from '@mini-harness/plugin-api/services';
import { bindInstance, pluginInstance } from '@mini-harness/plugin-api/instance';
import { changedSelection, PluginCatalog, type ConfiguredPlugin } from './catalog.js';

const appScope: PluginScope = { kind: 'application' };

/** Permission-only settings do not require a separate plugin context. */
function hasComposition(scope: ScopeSettings | undefined): scope is ScopeSettings {
  return !!scope && [scope.plugins, scope.providers, scope.pluginConfig].some((map) => Object.keys(map ?? {}).length > 0);
}

/** The descriptor and its resolved graph are the source of both server and browser mounts. */
export class PluginHost implements ScopePort {
  private readonly catalog: PluginCatalog;
  private readonly entries: EntryTree;
  private readonly root: ReadonlyMap<string, string>;
  private readonly pluginRoutes: PluginRouteRegistry;
  private readonly imports: ReturnType<typeof bindPluginImports>;
  private scopes = new Map<ScopeKey, EntryGroup>();
  private started = false;
  private readonly scopeSources = new Map<
    string,
    { resolve: (id: string) => ScopeAddress | undefined; eager: boolean }
  >();
  private applying?: Promise<void>;
  private closing = false;

  constructor(
    readonly ctx: Context,
    private readonly directory: string,
    builtins: PluginDescriptor[],
    rootServices: string[],
    private readonly settings: () => PluginSettings,
    upgrade?: (path: string, handler: UpgradeHandler) => () => Promise<void>,
    devPlugin?: string,
    private readonly writePlugin?: (
      id: string,
      key: ScopeKey | undefined,
      patch: unknown,
      check: () => void,
    ) => Promise<void>,
    private readonly nativeEntries: readonly EntryOptions[] = [],
    owner = ctx,
    entries = new EntryTree(),
  ) {
    this.entries = entries;
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
          const { pluginId, scope } = pluginInstance(caller);
          ctx.harnessChanges.invalidate(
            'plugin:' + pluginId,
            scope.kind === 'session'
              ? { sessionId: scope.sessionId }
              : scope.kind === 'workspace'
                ? { workspaceId: scope.workspaceId }
                : undefined,
          );
        },
      }),
    };
    for (const [name, value] of Object.entries(services)) owner.provide(name, value);
    const provided = [...new Set([...rootServices, ...Object.keys(services)])];
    this.catalog = new PluginCatalog(directory, builtins, provided, devPlugin, ctx.get('harnessProfile'));
    this.root = new Map(provided.map((name) => [name, 'application']));
    this.imports = bindPluginImports([directory, ...(devPlugin ? [devPlugin] : [])]);
  }

  private browserState = publishBrowser([], [], () => false);
  private failures = new Map<string, string>();

  effective<Settings extends PluginSettings>(settings: Settings) {
    return this.catalog.effective(settings);
  }
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
      if (!active || !fiber || this.nativeEntries.some((entry) => entry.id === options.id)) return [];
      const identity = pluginInstance(fiber.ctx);
      const inject = Object.keys(fiber.inject);
      const services = Object.fromEntries(
        inject
          .filter((name) => !name.startsWith('entry:'))
          .flatMap((name) => {
            const provider = fiber.committed?.[name]?.ctx.fiber;
            return provider ? [[name, provider.entry?.options.id ?? 'application']] : [];
          }),
      );
      return [
        {
          id: options.id,
          services,
          requires: inject.filter((name) => name.startsWith('entry:')).map((name) => name.slice(6)),
          provides: [...fiber.provisions]
            .map(({ name }) => name)
            .filter((name) => !name.startsWith('entry:')),
          scope: identity.scope.kind,
          source: this.catalog.reserved(identity.pluginId) ? 'built-in' : 'local',
        },
      ];
    });
  }

  private configurationContext(key?: ScopeKey, scopes = this.scopes) {
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
      (id) => this.entries.get(id)?.active === true,
      (key) => this.configurationContext(key),
    );
  }
  reserved(id: string) {
    return this.catalog.reserved(id);
  }

  register(
    kind: ScopeAddress['scope']['kind'],
    resolve: (id: string) => ScopeAddress | undefined,
    eager = false,
  ) {
    if (this.scopeSources.has(kind)) throw new Error('Scope source already registered: ' + kind);
    this.scopeSources.set(kind, { resolve, eager });
    return () => {
      this.scopeSources.delete(kind);
    };
  }

  private scopeSource(key: ScopeKey) {
    return this.scopeSources.get(key.startsWith('workspace:') ? 'workspace' : 'session');
  }

  private lookup(key: ScopeKey) {
    const source = this.scopeSource(key);
    return source?.resolve(key.slice(key.indexOf(':') + 1));
  }

  private ancestry(key: ScopeKey) {
    const ancestors = new Set<ScopeKey>();
    for (let current: ScopeKey | undefined = key; current; ) {
      const address = this.lookup(current);
      if (!address) break;
      if (ancestors.has(current)) throw new Error('Cyclic scope ancestry: ' + current);
      ancestors.add(current);
      current = address.parent;
    }
    return [...ancestors].reverse();
  }

  context(key?: ScopeKey | null) {
    if (!key) return this.ctx;
    const ancestry = this.ancestry(key);
    if (!ancestry.length) throw new DomainError('not_found', 'Plugin scope not found: ' + key);
    const settings = this.settings();
    for (const ancestor of ancestry)
      if (hasComposition(settings.scopes[ancestor]) && !this.scopes.has(ancestor))
        throw new DomainError('unavailable', 'Plugin scope is not prepared: ' + ancestor);
    return this.configurationContext(key);
  }

  address(key: ScopeKey) {
    return this.ancestry(key);
  }

  require<Name extends keyof HostServices & string>(
    key: ScopeKey | null | undefined,
    service: Name,
  ): NonNullable<HostServices[Name]> {
    const value = this.context(key).get(service);
    if (value == null) {
      const settings = this.settings();
      for (const ancestor of key ? [...this.address(key)].reverse() : []) {
        const provider = settings.scopes[ancestor]?.providers?.[service];
        const failure = provider && this.failures.get(ancestor + '/' + provider);
        if (failure)
          throw new DomainError(
            'unavailable',
            'Provider ' + provider + ' failed in ' + ancestor + ': ' + failure,
          );
      }
      throw new Error('Required service is unavailable: ' + service + (key ? ' in ' + key : ''));
    }
    return value;
  }

  async prepare(key: ScopeKey, signal?: AbortSignal) {
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
    settings: PluginSettings,
    descriptors: ReturnType<PluginCatalog['descriptors']>,
    appProviders: ReadonlyMap<string, string>,
    unavailable: (id: string, error: unknown, key?: ScopeKey) => boolean,
    requestedIdentities: ReadonlySet<string>,
    preparing?: ScopeKey,
    released: ReadonlySet<ScopeKey> = new Set(),
    validating: readonly ScopeKey[] = [],
  ) {
    const contexts = new Map<ScopeKey, EntryGroup>();
    const entries: EntryOptions[] = [];
    const instances = new Map<string, { key: ScopeKey; plugin: string }>();
    const active = new Set([
      ...scopeKeys(settings).filter((key) => this.scopeSource(key)?.eager),
      ...this.scopes.keys(),
      ...validating,
      ...(preparing ? this.ancestry(preparing) : []),
    ]);
    for (const key of active)
      for (const ancestor of this.ancestry(key)) if (!released.has(ancestor)) active.add(ancestor);
    const planned = new Map<ScopeKey, { context: Context; providers: ReadonlyMap<string, string> }>();
    const root = { context: this.ctx, providers: appProviders };

    const visit = (key: ScopeKey): typeof root => {
      const cached = planned.get(key);
      if (cached) return cached;
      const address = this.lookup(key);
      const overrides = settings.scopes[key];
      if (released.has(key)) return root;
      if (!address) {
        for (const plugin of new Set([
          ...Object.entries(overrides?.plugins ?? {})
            .filter(([, enabled]) => enabled)
            .map(([id]) => id),
          ...Object.values(overrides?.providers ?? {}),
        ])) {
          const error = new Error('Configured scope does not exist: ' + key);
          if (!unavailable(plugin, error, key)) throw error;
        }
        return root;
      }
      const parent = address.parent ? visit(address.parent) : root;
      if (!hasComposition(overrides)) return parent;
      const enabled = descriptors.filter(
        ({ id, scope }) => scope === address.scope.kind && overrides.plugins?.[id],
      );
      let plans: ConfiguredPlugin[] = [];
      let providers = parent.providers;
      try {
        ({ plans, providers } = this.catalog.plans(
          settings,
          descriptors,
          address.scope.kind,
          parent.providers,
          overrides,
          (id, error) => unavailable(id, error, key),
        ));
      } catch (error) {
        if (error instanceof ProtectedProviderError) throw new DomainError('invalid_input', error.message);
        const selected = new Set([
          ...enabled.map(({ id }) => id),
          ...Object.values(overrides.providers ?? {}),
        ]);
        if (!selected.size) throw error;
        for (const id of selected) if (!unavailable(id, error, key)) throw error;
      }
      const isolated = new Set<string>();
      for (const [service, plugin] of Object.entries(overrides.providers ?? {})) {
        if (parent.providers.get(service) !== plugin || enabled.some(({ id }) => id === plugin))
          isolated.add(service);
      }
      for (const { id, provides } of enabled) {
        for (const service of provides ?? [])
          if (providers.get(service) === id || !parent.providers.has(service)) isolated.add(service);
        if (requestedIdentities.has(id)) isolated.add('entry:' + id);
      }
      const isolates = [...isolated].sort();
      const existing = this.scopes.get(key);
      const group = existing?.matches(parent.context, isolates)
        ? existing
        : new EntryGroup(parent.context, isolates);
      const { context } = group;
      if (active.has(key)) {
        contexts.set(key, group);
        for (const plan of plans) {
          const id = key + '/' + plan.id;
          entries.push(this.entry(plan, address.scope, requestedIdentities.has(plan.id), id, key, context));
          instances.set(id, { key, plugin: plan.id });
        }
      }
      const current = {
        context,
        providers: new Map([...providers, ...Object.entries(overrides.providers ?? {})]),
      };
      planned.set(key, current);
      return current;
    };
    for (const key of new Set([...scopeKeys(settings), ...active])) {
      this.ancestry(key); // validate domain ancestry before evaluating scope selections
      visit(key);
    }
    return { contexts, entries, instances };
  }

  private entry(
    plan: ConfiguredPlugin,
    scope: PluginScope,
    identity: boolean,
    id = plan.id,
    scopeKey?: ScopeKey,
    context = this.ctx,
  ): EntryOptions {
    const { source, descriptor } = plan;
    return {
      id,
      context,
      config: plan.config ?? {},
      module: (descriptor.module ?? plan.id) + (identity ? ':identity' : ''),
      inject: descriptor.requires?.map((dependency) => 'entry:' + dependency),
      live: descriptor.configChanges === 'live',
      load: () => descriptor.plugin ?? { apply() {} },
      prepare: (ctx) => {
        bindInstance(ctx.fiber.entry!, {
          pluginId: plan.id,
          scope,
          scopeKey,
          writableConfig: descriptor.configChanges === 'live' && descriptor.configSchema !== undefined,
          trusted: !source && descriptor.trustedContributor === true,
        });
        const changes = this.ctx.get('harnessChanges');
        if (changes) ctx.effect(() => changes.register('plugin:' + plan.id));
        this.catalog.validateConfig(
          descriptor,
          ctx.fiber.config,
          'mount',
          ctx,
          descriptor.validateConfig,
          id,
        );
      },
      verify: (ctx) => {
        const registered = new Set(
          [...ctx.fiber.provisions].map(({ name }) => name).filter((name) => name !== 'entry:' + plan.id),
        );
        const declared = descriptor.provides ?? [];
        const unexpected = [...registered].find((name) => !declared.includes(name));
        if (unexpected) throw new Error('Undeclared service: ' + unexpected);
        if (declared.some((name) => !registered.has(name)))
          throw new Error('Plugin did not publish all declared services: ' + id);
        if (identity) ctx.provide('entry:' + plan.id, true);
      },
    };
  }

  async requestScope(plugin: string, key: string, operation: string, input: unknown, signal: AbortSignal) {
    if (!isScopeKey(key) || !localPluginIdPattern.test(plugin) || !scopeOperation.test(operation))
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

  async start(settings: PluginSettings) {
    await this.apply({ ...settings, scopes: {} }, () => {}, true);
    await this.ctx.parallel('harness/ready');
    await this.apply(this.settings(), () => {}, true);
  }

  async configure(settings: PluginSettings, commit = () => {}, released?: ReadonlySet<ScopeKey>) {
    assertOutsideMountTransaction();
    while (this.applying) await this.applying.catch(() => {});
    if (this.closing) throw new Error('Plugin host is closing');
    await this.apply(settings, commit, false, undefined, released);
    if (released?.size) removeScopeData(join(dirname(this.directory), 'plugin-data'), released);
  }

  private apply(
    settings: PluginSettings,
    commit: () => void,
    starting: boolean,
    preparing?: ScopeKey,
    released?: ReadonlySet<ScopeKey>,
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
    settings: PluginSettings,
    commit: () => void,
    starting: boolean,
    preparing?: ScopeKey,
    released?: ReadonlySet<ScopeKey>,
  ) {
    const oldEntries = [...this.entries.values()];
    const nativeIds = new Set(this.nativeEntries.map(({ id }) => id));
    const previousActive = new Set(
      oldEntries
        .filter((entry) => entry.active && !nativeIds.has(entry.options.id))
        .map(({ options }) => options.id),
    );
    const previousEntries = oldEntries.map(({ options }) => options);
    const failures = new Map<string, string>();
    const previous = this.settings();
    const descriptors = await this.catalog.runtimeDescriptors(settings);
    const updating = !starting && !preparing && !released;
    const validations = updating ? this.catalog.changedConfig(descriptors, previous, settings) : [];
    const unavailable = (id: string, error: unknown, key?: ScopeKey) => {
      const instance = key ? key + '/' + id : id;
      const message = error instanceof Error ? error.message : String(error);
      if (updating && changedSelection(id, previous, settings, key))
        throw new DomainError(
          error instanceof DomainError ? error.code : 'invalid_input',
          'Plugin ' + instance + ': ' + message,
          { cause: error },
        );
      if (
        descriptors.some((row) => row.id === id && row.required) ||
        this.catalog.lockedPlugins.has(id) ||
        previousActive.has(instance)
      )
        return false;
      failures.set(instance, message);
      return true;
    };
    const { plans, providers } = this.catalog.plans(
      settings,
      descriptors,
      'application',
      this.root,
      undefined,
      unavailable,
    );
    const requiredScopes = new Set(
      updating
        ? scopeKeys(settings).filter((key) =>
            Object.values(settings.scopes[key]?.providers ?? {}).some((provider) =>
              changedSelection(provider, previous, settings, key),
            ),
          )
        : [],
    );
    const requestedIdentities = new Set(descriptors.flatMap((row) => row.requires ?? []));
    const scoped = this.scopedEntries(
      settings,
      descriptors,
      providers,
      unavailable,
      requestedIdentities,
      preparing,
      released,
      [...requiredScopes, ...validations.flatMap(({ key }) => (key ? [key] : []))],
    );
    const browser = planBrowser(
      plans,
      settings.browserProviders ?? {},
      this.catalog.requiredClientCapabilities,
    );
    const mounts = [
      ...plans
        .filter(({ id }) => !failures.has(id))
        .map((plan) => this.entry(plan, appScope, requestedIdentities.has(plan.id))),
      ...scoped.entries,
    ];
    const appChanged =
      !isDeepStrictEqual(previous.providers, settings.providers) ||
      descriptors.some((descriptor) => {
        const { id, configChanges, scope, plugin, source } = descriptor;
        if (scope !== 'application' || !(plugin || source)) return false;
        const enabled = this.catalog.enabled(descriptor, settings);
        return (
          enabled !== this.catalog.enabled(descriptor, previous) ||
          (enabled &&
            configChanges !== 'live' &&
            !isDeepStrictEqual(settings.pluginConfig[id], previous.pluginConfig[id]))
        );
      });
    const scopeChanges = new Set(
      [...scopeKeys(previous), ...scopeKeys(settings)].filter((key) => {
        const before = previous.scopes[key],
          after = settings.scopes[key];
        return (
          !isDeepStrictEqual(before?.plugins, after?.plugins) ||
          !isDeepStrictEqual(before?.providers, after?.providers) ||
          descriptors.some(
            ({ id, configChanges }) =>
              configChanges !== 'live' &&
              after?.plugins?.[id] &&
              (!isDeepStrictEqual(before?.pluginConfig?.[id], after.pluginConfig?.[id]) ||
                !isDeepStrictEqual(previous.pluginConfig[id], settings.pluginConfig[id])),
          )
        );
      }),
    );
    const release =
      !starting && !preparing && !released && (appChanged || scopeChanges.size)
        ? this.ctx.get('harnessMutations')?.protect(appChanged ? undefined : scopeChanges)
        : undefined;
    try {
      const activationErrors = await this.entries.update([...this.nativeEntries, ...mounts]);
      for (const mounted of mounts) {
        const entry = this.entries.get(mounted.id)!;
        if (entry.active && !entry.error) continue;
        const scope = scoped.instances.get(mounted.id);
        const missing = Object.keys(entry.fiber?.inject ?? {}).filter(
          (service) => entry.options.context.get(service) == null,
        );
        const error =
          activationErrors.get(mounted.id) ??
          new Error('No enabled provider for ' + missing.join(', ') + ' (' + mounted.id + ')');
        if (!(scope ? unavailable(scope.plugin, error, scope.key) : unavailable(mounted.id, error)))
          throw error;
      }
      for (const key of requiredScopes) {
        const context = this.configurationContext(key, scoped.contexts);
        for (const service of Object.keys(settings.scopes[key]?.providers ?? {}))
          if (context.get(service) == null)
            throw new DomainError('unavailable', 'Selected service ' + service + ' is unavailable in ' + key);
      }
      for (const { descriptor, config, key } of validations) {
        const instance = key ? key + '/' + descriptor.id : descriptor.id;
        this.catalog.validateConfig(
          descriptor,
          config,
          'write',
          this.configurationContext(key, scoped.contexts),
          descriptor.validateConfig,
          instance,
        );
      }
      {
        const browserState = publishBrowser(browser, plans, (id) => this.entries.get(id)?.active === true);
        const provided = new Set(browserState.entries.flatMap(({ provides }) => provides ?? []));
        for (const service of this.catalog.requiredClientCapabilities)
          if (!provided.has(service))
            throw new DomainError('unavailable', 'Required browser service is unavailable: ' + service);
        commit();
        this.started = true;
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
      if (!this.nativeEntries.length) await withMountTransaction(() => this.entries.close());
    } finally {
      this.imports.deregister();
      this.scopes.clear();
    }
  }
}
