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
import { pluginIdPattern, isScopeKey } from '@mini-harness/plugin-api/selection';
import { isDeepStrictEqual } from 'node:util';
import type { ResolvedPlugin } from '@mini-harness/plugin-api/descriptor';
import type {
  HostServices,
  PluginScope,
  ScopeAddress,
  ScopeKey,
  ScopePort,
  ScopeSettings,
} from '@mini-harness/plugin-api/scopes';
import { planBrowser, publishBrowser } from './browser-assets.ts';
import { addAbortListener } from 'node:events';
import type { UpgradeHandler } from '@mini-harness/transport/routes';
import { scopeKeys, type CompositionConfig } from '@mini-harness/plugin-api/configuration';
import { bindPluginImports } from './module-resolution.ts';
import { pluginData, pluginSecrets, removeScopeData } from './data.ts';
import { PluginRouteRegistry, scopeOperation } from './routes.ts';
import { pluginSettings } from './plugin-settings.ts';
import { pluginInstance } from '@mini-harness/plugin-api/instance';
import { changedSelection, PluginCatalog } from './catalog.ts';

const appScope: PluginScope = { kind: 'application' };

/** Permission-only settings do not require a separate plugin context. */
function hasComposition(scope: ScopeSettings | undefined): scope is ScopeSettings {
  return !!scope && Object.keys(scope.entries ?? {}).length > 0;
}

/** The descriptor and its resolved graph are the source of both server and browser mounts. */
export class PluginHost implements ScopePort {
  private readonly catalog: PluginCatalog;
  private readonly entries: EntryTree;
  private readonly ownsTree: boolean;
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
    builtins: ResolvedPlugin[],
    private readonly settings: () => CompositionConfig,
    upgrade?: (path: string, handler: UpgradeHandler) => () => Promise<void>,
    private readonly writePlugin?: (
      id: string,
      key: ScopeKey | undefined,
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
    for (const [name, value] of Object.entries(services)) this.owner.provide(name, value);
    this.catalog = new PluginCatalog(directory, builtins, ctx.get('harnessProfile'));
    this.imports = bindPluginImports([directory]);
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
      (id) =>
        this.entries.get(id)?.active === true || this.browserState.entries.some((entry) => entry.id === id),
    );
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
    settings: CompositionConfig,
    descriptors: ReturnType<PluginCatalog['descriptors']>,
    unavailable: (id: string, error: unknown, key?: ScopeKey) => boolean,
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
    const planned = new Map<ScopeKey, Context>();
    const root = this.ctx;

    const visit = (key: ScopeKey): typeof root => {
      const cached = planned.get(key);
      if (cached) return cached;
      const address = this.lookup(key);
      const overrides = settings.scopes[key];
      if (released.has(key)) return root;
      if (!address) {
        for (const plugin of new Set([
          ...Object.entries(overrides?.entries ?? {})
            .filter(([, entry]) => entry.disabled === false)
            .map(([id]) => id),
        ])) {
          const error = new Error('Configured scope does not exist: ' + key);
          if (!unavailable(plugin, error, key)) throw error;
        }
        return root;
      }
      const parent = address.parent ? visit(address.parent) : root;
      if (!hasComposition(overrides)) return parent;
      const { plans, declared } = this.catalog.plans(
        settings,
        descriptors,
        address.scope.kind,
        overrides,
        (id, error) => unavailable(id, error, key),
      );
      const isolates = [...declared].sort();
      const existing = this.scopes.get(key);
      const group = existing?.matches(parent, isolates) ? existing : new EntryGroup(parent, isolates);
      const { context } = group;
      if (active.has(key)) {
        contexts.set(key, group);
        for (const plan of plans) {
          if (!plan.descriptor.plugin) continue;
          const id = key + '/' + plan.id;
          entries.push(this.catalog.entry(plan, context, address.scope, id, key));
          instances.set(id, { key, plugin: plan.id });
        }
      }
      planned.set(key, context);
      return context;
    };
    for (const key of new Set([...scopeKeys(settings), ...active])) {
      this.ancestry(key); // validate domain ancestry before evaluating scope selections
      visit(key);
    }
    return { contexts, entries, instances };
  }

  async requestScope(plugin: string, key: string, operation: string, input: unknown, signal: AbortSignal) {
    if (!isScopeKey(key) || !pluginIdPattern.test(plugin) || !scopeOperation.test(operation))
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

  async start(settings: CompositionConfig) {
    await this.apply({ ...settings, scopes: {} }, () => {}, true);
    await this.ctx.parallel('harness/ready');
    await this.apply(this.settings(), () => {}, true);
  }

  async configure(settings: CompositionConfig, commit = () => {}, released?: ReadonlySet<ScopeKey>) {
    assertOutsideMountTransaction();
    while (this.applying) await this.applying.catch(() => {});
    if (this.closing) throw new Error('Plugin host is closing');
    await this.apply(settings, commit, false, undefined, released);
    if (released?.size) removeScopeData(join(dirname(this.directory), 'plugin-data'), released);
  }

  private apply(
    settings: CompositionConfig,
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
    settings: CompositionConfig,
    commit: () => void,
    starting: boolean,
    preparing?: ScopeKey,
    released?: ReadonlySet<ScopeKey>,
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
    const unavailable = (id: string, error: unknown, key?: ScopeKey) => {
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
    const { plans } = this.catalog.plans(settings, descriptors, 'application', undefined, unavailable);
    const changedScopes = updating
      ? scopeKeys(settings).filter((key) =>
          Object.entries(settings.scopes[key]?.entries ?? {}).some(
            ([id, entry]) => entry.disabled === false && changedSelection(id, previous, settings, key),
          ),
        )
      : [];
    const scoped = this.scopedEntries(settings, descriptors, unavailable, preparing, released, changedScopes);
    const mounts = [
      ...plans
        .filter(({ id, descriptor }) => descriptor.plugin && !failures.has(id))
        .map((plan) => this.catalog.entry(plan, this.ctx, appScope)),
      ...scoped.entries,
    ];
    const appChanged = descriptors.some((descriptor) => {
      const { id, scope, plugin, source } = descriptor;
      if (scope !== 'application' || !(plugin || source)) return false;
      const enabled = this.catalog.enabled(descriptor, settings);
      return (
        enabled !== this.catalog.enabled(descriptor, previous) ||
        (enabled && settings.entries[id]?.live !== previous.entries[id]?.live) ||
        (enabled &&
          !settings.entries[id]?.live &&
          !isDeepStrictEqual(settings.entries[id]?.config, previous.entries[id]?.config))
      );
    });
    const scopeChanges = new Set(
      [...scopeKeys(previous), ...scopeKeys(settings)].filter((key) => {
        const before = previous.scopes[key],
          after = settings.scopes[key];
        return (
          !isDeepStrictEqual(
            Object.fromEntries(
              Object.entries(before?.entries ?? {})
                .filter(([, entry]) => entry.disabled !== undefined || entry.live !== undefined)
                .map(([id, entry]) => [id, [entry.disabled, entry.live]]),
            ),
            Object.fromEntries(
              Object.entries(after?.entries ?? {})
                .filter(([, entry]) => entry.disabled !== undefined || entry.live !== undefined)
                .map(([id, entry]) => [id, [entry.disabled, entry.live]]),
            ),
          ) ||
          descriptors.some(
            ({ id }) =>
              after?.entries?.[id]?.disabled === false &&
              ((before?.entries?.[id]?.live ?? previous.entries[id]?.live) !==
                (after.entries?.[id]?.live ?? settings.entries[id]?.live) ||
                (!(after.entries?.[id]?.live ?? settings.entries[id]?.live) &&
                  (!isDeepStrictEqual(before?.entries?.[id]?.config, after.entries?.[id]?.config) ||
                    !isDeepStrictEqual(previous.entries[id]?.config, settings.entries[id]?.config)))),
          )
        );
      }),
    );
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
        const clientOnly = new Set(plans.filter(({ descriptor }) => !descriptor.plugin).map(({ id }) => id));
        const browserState = publishBrowser(
          planBrowser(plans, (id) => this.entries.get(id)?.fiber?.effectiveConfig),
          plans,
          (id) => !failures.has(id) && (clientOnly.has(id) || this.entries.get(id)?.active === true),
        );
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
      if (this.ownsTree) await withMountTransaction(() => this.entries.close());
    } finally {
      this.imports.deregister();
      this.scopes.clear();
    }
  }
}
