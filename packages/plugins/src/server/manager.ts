import type {} from '@mini-harness/transport/projection-api';
import type {} from '@mini-harness/settings/api';
import { assertOutsideMountTransaction, withMountTransaction } from '@mini-harness/kernel/mutation-api';
import { DomainError } from '@mini-harness/platform/errors';
import { dirname, join, relative } from 'node:path';
import { Context } from 'cordis';
import { createHash } from 'node:crypto';
import { localPluginIdPattern, scopeSettingsPattern } from '@mini-harness/plugin-api/selection';
import { isDeepStrictEqual } from 'node:util';
import { lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import type { HostServices, PluginScope, ScopeAddress, ScopeKey, ScopePort } from '@mini-harness/kernel/scopes';
import { planBrowser, publishBrowser } from './browser-assets.js';
import { addAbortListener } from 'node:events';
import type { UpgradeHandler } from '@mini-harness/transport/routes';
import type { PluginSettings } from '@mini-harness/plugin-api/configuration';
import { PluginMounts, type MountPlan } from '@mini-harness/kernel/mounts';
import { resolveScopes } from './scope-graph.js';
import { createPluginApi } from './api.js';
import { changedSelection, PluginCatalog, type ApplicationRequirements, type PluginPlan } from './catalog.js';

type MountedScope = { ctx: Context; parent: Context; isolates: string[] };

const appScope: PluginScope = { kind: 'application' };

/** The descriptor and its resolved graph are the source of both server and browser mounts. */
export class PluginHost implements ScopePort {
  private readonly catalog: PluginCatalog;
  private readonly mounts: PluginMounts;
  private readonly root: ReadonlyMap<string, string>;
  private readonly validators = new Map<string, NonNullable<PluginDescriptor['validateConfig']>>();
  private readonly requests = new Map<string, (input: unknown, signal: AbortSignal) => Promise<unknown>>();
  private scopes = new Map<string, MountedScope>();
  private started = false;
  private readonly scopeSources = new Map<string, { resolve: (id: string) => ScopeAddress | undefined; eager: boolean }>();
  private applying?: Promise<void>;
  private closing = false;

  constructor(readonly ctx: Context, private readonly directory: string, builtins: PluginDescriptor[], rootServices: string[],
    private readonly settings: () => PluginSettings,
    private readonly upgrade?: (path: string, handler: UpgradeHandler) => () => void, devPlugin?: string,
    private readonly writePlugin?: (id: string, key: string | undefined, patch: unknown, check: () => void) => Promise<void>,
    private readonly composition: ApplicationRequirements & { trustedContributors?: ReadonlySet<string> } = {}) {
    this.catalog = new PluginCatalog(directory, builtins, rootServices, devPlugin, composition);
    this.mounts = new PluginMounts(ctx);
    this.root = new Map(rootServices.map((name) => [name, 'application']));
  }

  private browserState = publishBrowser([], [], () => false);
  private failures = new Map<string, string>();
  private graph: ReturnType<PluginHost['describe']>[] = [];

  effective<Settings extends PluginSettings>(settings: Settings) { return this.catalog.effective(settings); }
  browser() { return structuredClone(this.browserState.entries); }

  async writeBrowserConfig(id: string, patch: unknown, signal: AbortSignal) {
    if (!this.writePlugin) throw new DomainError('unavailable', 'Plugin settings are unavailable');
    await this.writePlugin(id, undefined, patch, () => {
      signal.throwIfAborted();
      if (!this.browserState.configurable.has(id))
        throw new DomainError('not_found', 'Plugin settings are unavailable');
    });
  }

  diagnostics() { return structuredClone(this.graph); }
  private describe(plan: PluginPlan, id = plan.id, requires = plan.requires) {
    const { services, descriptor } = plan;
    return { id, requires, services, provides: descriptor.provides ?? [], optional: descriptor.optional ?? [],
      scope: descriptor.scope, source: descriptor.trustedCode ? 'local' : 'built-in' };
  }

  private configurationContext(key?: string, scopes = this.scopes) {
    if (!key) return this.ctx;
    const keys = this.ancestry(key);
    return keys.reverse().map((item) => scopes.get(item)).find(Boolean)?.ctx ?? this.ctx;
  }

  metadata() {
    return this.catalog.metadata(this.settings(), this.failures,
      (id) => Boolean(this.mounts.plan(id)), (key) => this.configurationContext(key));
  }
  reserved(id: string) { return this.catalog.reserved(id); }

  register(kind: ScopeAddress['scope']['kind'], resolve: (id: string) => ScopeAddress | undefined, eager = false) {
    if (this.scopeSources.has(kind)) throw new Error('Scope source already registered: ' + kind);
    this.scopeSources.set(kind, { resolve, eager });
    return () => { this.scopeSources.delete(kind); };
  }

  private lookup(key: string) {
    const separator = key.indexOf(':');
    return this.scopeSources.get(key.slice(0, separator))?.resolve(key.slice(separator + 1));
  }

  private ancestry(key: string) {
    const ancestors = new Set<string>();
    for (let current: string | undefined = key; current;) {
      const address = this.lookup(current);
      if (!address) break;
      if (ancestors.has(current)) throw new Error('Cyclic scope ancestry: ' + current);
      ancestors.add(current);
      current = address.parent;
    }
    return [...ancestors].reverse();
  }

  address(key: ScopeKey) { return this.ancestry(key); }

  require<Name extends keyof HostServices & string>(key: ScopeKey | null | undefined, service: Name): NonNullable<HostServices[Name]> {
    const value = this.optional(key, service);
    if (value == null) {
      const settings = this.settings();
      for (const ancestor of key ? [...this.address(key)].reverse() : []) {
        const provider = settings.scopes[ancestor]?.providers?.[service];
        const failure = provider && this.failures.get(ancestor + '/' + provider);
        if (failure) throw new DomainError('unavailable', 'Provider ' + provider + ' failed in ' + ancestor + ': ' + failure);
      }
      throw new Error('Required service is unavailable: ' + service + (key ? ' in ' + key : ''));
    }
    return value;
  }

  optional<Name extends keyof HostServices & string>(key: ScopeKey | null | undefined, service: Name): HostServices[Name] | undefined {
    const scope = key && this.address(key).reverse().map((ancestor) => this.scopes.get(ancestor)).find(Boolean);
    return ((scope || undefined)?.ctx ?? this.ctx).get(service) as HostServices[Name] | undefined;
  }

  async prepare(key: ScopeKey, signal?: AbortSignal) {
    assertOutsideMountTransaction();
    if (this.closing) throw new Error('Plugin host is closing');
    signal?.throwIfAborted();
    while (this.applying) {
      const current = this.applying.catch(() => {});
      if (!signal) { await current; continue; }
      let listener: ReturnType<typeof addAbortListener> | undefined;
      try {
        await Promise.race([current, new Promise<never>((_, reject) => {
          listener = addAbortListener(signal, () => reject(signal.reason));
        })]);
      } finally { listener?.[Symbol.dispose](); }
    }
    signal?.throwIfAborted();
    if (this.closing) throw new Error('Plugin host is closing');
    if (!this.started) return;
    const settings = this.settings();
    if (!this.ancestry(key).some((item) => Object.hasOwn(settings.scopes, item) && !this.scopes.has(item))) return;
    await this.apply(settings, () => {}, false, key);
    signal?.throwIfAborted();
  }

  private scopedMounts(settings: PluginSettings, descriptors: ReturnType<PluginCatalog['descriptors']>,
    appPlans: PluginPlan[], appProviders: ReadonlyMap<string, string>, unavailable: (id: string, error: unknown) => boolean,
    preparing?: string, released: ReadonlySet<string> = new Set(), validating: readonly string[] = []) {
    const scopes = new Map<string, MountedScope>();
    const mounts: MountPlan[] = [];
    const diagnostics: ReturnType<PluginHost['describe']>[] = [];
    const active = new Set([...Object.keys(settings.scopes).filter((key) => this.scopeSources.get(key.slice(0, key.indexOf(':')))?.eager), ...this.scopes.keys(), ...validating, ...(preparing ? this.ancestry(preparing) : [])]);
    for (const key of active)
      for (const ancestor of this.ancestry(key)) if (!released.has(ancestor)) active.add(ancestor);
    const graph = resolveScopes(settings, this.catalog.plans.bind(this.catalog), (key) => this.lookup(key),
      descriptors, appPlans, appProviders, active, released, unavailable);
    for (const { key, parent, scope, isolates, plugins } of graph) {
      const parentContext = parent ? scopes.get(parent)?.ctx : this.ctx;
      if (!parentContext) throw new Error('Scoped mount is missing its parent: ' + key);
      const existing = this.scopes.get(key);
      const reusable = existing?.parent === parentContext && isDeepStrictEqual(existing.isolates, isolates);
      let ctx = reusable ? existing.ctx : parentContext.extend();
      if (!reusable) for (const service of isolates) ctx = ctx.isolate(service);
      scopes.set(key, { ctx, parent: parentContext, isolates });
      for (const { plan, id, needs } of plugins) {
        mounts.push(this.mountPlan(plan, scope, id, key, ctx, needs));
        diagnostics.push(this.describe(plan, id, needs));
      }
    }
    return { scopes, mounts, diagnostics, graph };
  }

  private async load(plan: PluginPlan, scope: PluginScope, scopeKey?: string): ReturnType<MountPlan['load']> {
    const { descriptor, source } = plan;
    const mod = source ? await import(pathToFileURL(source).href + '?v=' + lstatSync(source).mtimeMs) : undefined;
    const validator = source ? mod.validateConfig : descriptor.validateConfig;
    if (validator !== undefined && (typeof validator !== 'function' || !descriptor.configSchema))
      throw new Error('Export a validateConfig function with a configSchema in plugin.json');
    const setup = source ? mod.default : descriptor.setup ?? (() => {});
    if (typeof setup !== 'function' || mod?.inject !== undefined || (source && setup.inject !== undefined))
      throw new Error('Export a default setup function and declare dependencies in plugin.json');
    return { inject: descriptor.inject ?? [], setup: async (ctx, lifetime, setDrain, setConfig) => {
      const changes = this.ctx.get('harnessChanges');
      const domain = 'plugin:' + plan.id;
      if (changes) ctx.effect(() => changes.register(domain));
      const runtime = createPluginApi(ctx, plan, { scope, scopeKey, lifetime,
        trusted: !source && this.composition.trustedContributors?.has(plan.id) === true,
        address: (id) => this.address(id),
        prepare: (id, signal) => this.prepare(id, signal),
        scopedService: (id, name) => this.require(id, name),
        routes: this.ctx.get('harnessRoutes'), upgrade: this.upgrade,
        dataRoot: join(dirname(this.directory), 'plugin-data'),
        readConfig: () => {
          const settings = this.settings();
          const values = scopeKey
            ? { ...settings.pluginConfig[plan.id], ...settings.scopes[scopeKey]?.pluginConfig?.[plan.id] }
            : settings.pluginConfig[plan.id];
          return this.catalog.configValues(plan.id, values, descriptor.configSchema);
        },
        subscribeConfig: (listener) => this.ctx.harnessSettingsStore.subscribe(listener),
        writeConfig: (patch, check) => {
          if (!this.writePlugin || !descriptor.configSchema) throw new Error('Plugin configuration schema is unavailable');
          return this.writePlugin(plan.id, scopeKey, patch, check);
        },
        registerScopeRequest: scopeKey ? (name, handler) => {
          const key = scopeKey + '/' + plan.id + '/' + name;
          if (this.requests.has(key)) throw new Error('Duplicate scoped request: ' + name);
          this.requests.set(key, handler);
          return () => { this.requests.delete(key); };
        } : undefined,
        invalidate: () => changes?.invalidate(domain, scope.kind === 'session' ? { sessionId: scope.sessionId } :
          scope.kind === 'workspace' ? { workspaceId: scope.workspaceId } : undefined)
      });
      setDrain(runtime.drain);
      const validatorKey = scopeKey ? scopeKey + '/' + plan.id : plan.id;
      if (validator) {
        this.catalog.validateConfig(descriptor, runtime.api.config, 'mount', ctx, validator, validatorKey);
        ctx.effect(() => {
          this.validators.set(validatorKey, validator);
          return () => { this.validators.delete(validatorKey); };
        });
      }
      const cleanup = await setup(ctx, runtime.api);
      if (typeof cleanup === 'function') ctx.effect(() => cleanup);
      runtime.checkPublications();
      if (descriptor.configChanges === 'live') setConfig(runtime.updateConfig);
    } };
  }

  private mountPlan(plan: PluginPlan, scope: PluginScope, key = plan.id, scopeKey?: string, context?: Context, requires = plan.requires): MountPlan {
    return {
      id: key, requires, context,
      signature: { source: plan.source, requires, inject: plan.descriptor.inject, provides: plan.descriptor.provides,
        optional: plan.descriptor.optional, services: plan.services,
        config: plan.descriptor.configChanges === 'live' ? undefined : plan.config },
      config: plan.descriptor.configChanges === 'live' ? plan.config ?? {} : undefined,
      load: () => this.load(plan, scope, scopeKey)
    };
  }

  async requestScope(plugin: string, key: string, operation: string, input: unknown, signal: AbortSignal) {
    if (!scopeSettingsPattern.test(key) || !localPluginIdPattern.test(plugin) ||
        !/^[a-z][a-z0-9-]{0,63}$/.test(operation))
      throw new DomainError('invalid_input', 'Invalid scoped plugin request');
    if (!this.lookup(key)) throw new DomainError('not_found', 'Plugin scope not found');
    await this.prepare(key as ScopeKey, signal);
    const instance = key + '/' + plugin;
    const handler = this.requests.get(instance + '/' + operation);
    if (!this.lookup(key) || !this.mounts.plan(instance) || !handler) {
      const failure = this.failures.get(instance);
      if (failure) throw new DomainError('unavailable', failure);
      throw new DomainError('not_found', 'Scoped plugin request is unavailable');
    }
    return handler(input, signal);
  }

  private removeScopeData(keys: ReadonlySet<string>) {
    const root = join(dirname(this.directory), 'plugin-data');
    const info = lstatSync(root, { throwIfNoEntry: false });
    if (!info) return;
    if (!info.isDirectory() || relative(root, realpathSync(root))) throw new Error('Plugin data directory has been redirected');
    const instances = [...keys].map((key) => createHash('sha256').update(key).digest('hex'));
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const instance of instances) rmSync(join(root, entry.name, instance), { recursive: true, force: true });
    }
  }

  browserAsset(url: string) { return this.browserState.assets.get(url); }

  async start(settings: PluginSettings) {
    await this.apply({ ...settings, scopes: {} }, () => {}, true);
    await this.ctx.parallel('harness/ready');
    await this.apply(this.settings(), () => {}, true);
  }

  async configure(settings: PluginSettings, commit = () => {}, released?: ReadonlySet<string>) {
    assertOutsideMountTransaction();
    while (this.applying) await this.applying.catch(() => {});
    if (this.closing) throw new Error('Plugin host is closing');
    await this.apply(settings, commit, false, undefined, released);
    if (released?.size) this.removeScopeData(released);
  }

  private apply(settings: PluginSettings, commit: () => void, starting: boolean, preparing?: string, released?: ReadonlySet<string>) {
    const work = withMountTransaction(() => Promise.resolve().then(() =>
      this.configureGraph(settings, commit, starting, preparing, released)));
    this.applying = work;
    return work.finally(() => { if (this.applying === work) this.applying = undefined; });
  }

  private async configureGraph(settings: PluginSettings, commit: () => void, starting: boolean, preparing?: string, released?: ReadonlySet<string>) {
    const failures = new Map<string, string>();
    const previous = this.settings();
    const descriptors = this.catalog.descriptors();
    const updating = !starting && !preparing && !released;
    const validations = updating ? this.catalog.changedConfig(descriptors, previous, settings) : [];
    const unavailable = (id: string, error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (updating && changedSelection(id, previous, settings))
        throw error instanceof DomainError ? error : new DomainError('invalid_input', message, { cause: error });
      if (this.catalog.fixedPlugins.has(id) || this.mounts.plan(id)) return false;
      failures.set(id, message);
      return true;
    };
    const { plans, providers } = this.catalog.plans(settings, descriptors, 'application', this.root, new Set(), undefined, unavailable);
    const requiredScopes = new Set(updating ? Object.entries(settings.scopes).filter(([key, scope]) =>
      Object.entries(scope.providers ?? {}).some(([service, provider]) =>
        this.catalog.requiredServices.has(service) && changedSelection(key + '/' + provider, previous, settings)))
      .map(([key]) => key) : []);
    const scoped = this.scopedMounts(settings, descriptors, plans, providers, unavailable, preparing, released,
      [...requiredScopes, ...validations.flatMap(({ key }) => key ? [key] : [])]);
    const browser = planBrowser(plans, settings.browserProviders ?? {}, unavailable, this.catalog.requiredBrowserServices, this.catalog.fixedPlugins);
    const mounts = [...plans.filter(({ id }) => !failures.has(id)).map((plan) => this.mountPlan(plan, appScope)), ...scoped.mounts];
    const appChanged = !isDeepStrictEqual(previous.providers, settings.providers) ||
      descriptors.some((descriptor) => {
        const { id, configChanges, scope, setup, source } = descriptor;
        if (scope !== 'application' || !(setup || source)) return false;
        const enabled = this.catalog.enabled(descriptor, settings);
        return enabled !== this.catalog.enabled(descriptor, previous) || enabled && configChanges !== 'live' &&
          !isDeepStrictEqual(settings.pluginConfig[id], previous.pluginConfig[id]);
      });
    const scopeChanges = new Set([...Object.keys(previous.scopes), ...Object.keys(settings.scopes)]
      .filter((key) => {
        const before = previous.scopes[key], after = settings.scopes[key];
        return !isDeepStrictEqual(before?.plugins, after?.plugins) ||
          !isDeepStrictEqual(before?.providers, after?.providers) ||
          descriptors.some(({ id, configChanges }) => configChanges !== 'live' && after?.plugins?.[id] &&
            (!isDeepStrictEqual(before?.pluginConfig?.[id], after.pluginConfig?.[id]) ||
             !isDeepStrictEqual(previous.pluginConfig[id], settings.pluginConfig[id])));
      }));
    const release = !starting && !preparing && !released && (appChanged || scopeChanges.size)
      ? this.ctx.get('harnessMutations')?.protect(appChanged ? undefined : scopeChanges) : undefined;
    try {
      await this.mounts.configure(mounts, () => {
        const browserState = publishBrowser(browser, plans, (id) => Boolean(this.mounts.plan(id)));
        const provided = new Set(browserState.entries.flatMap(({ provides }) => provides ?? []));
        for (const service of this.catalog.requiredBrowserServices)
          if (!provided.has(service)) throw new DomainError('unavailable', 'Required browser service is unavailable: ' + service);
        commit();
        this.started = true;
        this.scopes = scoped.scopes;
        this.failures = failures;
        this.browserState = browserState;
        this.graph = [...plans.map((plan) => this.describe(plan)), ...scoped.diagnostics]
          .filter(({ id }) => this.mounts.plan(id));
        this.ctx.get('harnessChanges')?.invalidate('plugins');
      }, unavailable, () => {
        for (const service of this.catalog.requiredServices) {
          const provider = providers.get(service);
          if (!provider || !this.mounts.plan(provider)) {
            const diagnostic = provider && failures.get(provider);
            throw new DomainError('unavailable', 'Required service ' + service + ' is unavailable' +
              (diagnostic ? ': ' + provider + ': ' + diagnostic : ''));
          }
        }
        for (const node of scoped.graph) if (requiredScopes.has(node.key)) {
          for (const service of this.catalog.requiredServices) {
            const owner = node.owners.get(service);
            if (!owner || !this.mounts.plan(owner))
              throw new DomainError('unavailable', 'Required service ' + service + ' is unavailable in ' + node.key);
          }
        }
        for (const { descriptor, config, key } of validations) {
          const instance = key ? key + '/' + descriptor.id : descriptor.id;
          this.catalog.validateConfig(descriptor, config, 'write', this.configurationContext(key, scoped.scopes),
            this.validators.get(instance), instance);
        }
      });
    } finally { release?.(); }
  }

  async close() {
    this.closing = true;
    await this.applying?.catch(() => {});
    try { await withMountTransaction(() => this.mounts.close()); }
    finally { this.scopes.clear(); }
  }
}
