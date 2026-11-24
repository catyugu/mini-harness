import type {} from '@mini-harness/transport/projection-api';
import type {} from '@mini-harness/settings/api';
import type {} from '@mini-harness/kernel/mutation-api';
import { DomainError } from '@mini-harness/platform/errors';
import { dirname, join } from 'node:path';
import { Context } from 'cordis';
import { isDeepStrictEqual } from 'node:util';
import { lstatSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import type { HostServices, PluginScope, ScopePort, ScopeDirectory } from '@mini-harness/kernel/scopes';
import { planBrowser, publishBrowser } from './browser-assets.js';
import { addAbortListener } from 'node:events';
import type { UpgradeHandler } from '@mini-harness/transport/routes';
import type { PluginSettings } from '@mini-harness/plugin-api/configuration';
import { PluginMounts, type MountPlan } from '@mini-harness/kernel/mounts';
import { resolveScopes } from './scope-graph.js';
import { createPluginApi } from './api.js';
import { changedSelection, PluginCatalog, type PluginPlan } from './catalog.js';

type MountedScope = { ctx: Context; parent: Context; isolates: string[] };

const appScope: PluginScope = { kind: 'application' };

/** The descriptor and its resolved graph are the source of both server and browser mounts. */
export class PluginHost implements ScopePort {
  private readonly catalog: PluginCatalog;
  private readonly mounts: PluginMounts;
  private readonly root: ReadonlyMap<string, string>;
  private scopes = new Map<string, MountedScope>();
  private started = false;
  private applying?: Promise<void>;
  private closing = false;

  constructor(readonly ctx: Context, private readonly directory: string, builtins: PluginDescriptor[], rootServices: string[],
    private readonly settings: () => PluginSettings,
    private readonly resolveAddress: ScopeDirectory['address'],
    private readonly upgrade?: (path: string, handler: UpgradeHandler) => () => void, devPlugin?: string,
    private readonly writePlugin?: (id: string, key: string | undefined, patch: unknown, check: () => void) => Promise<void>,
    private readonly authority: {
      defaultReadOnlyTools?: ReadonlyMap<string, ReadonlySet<string>>;
      protectedProviders?: ReadonlyMap<string, string>;
    } = {}) {
    this.catalog = new PluginCatalog(directory, builtins, rootServices, devPlugin, authority.protectedProviders);
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
    const keys = this.scopeAddress(key).map(({ key }) => key);
    return keys.reverse().map((item) => scopes.get(item)).find(Boolean)?.ctx ?? this.ctx;
  }

  metadata() {
    return this.catalog.metadata(this.settings(), this.failures,
      (id) => Boolean(this.mounts.plan(id)), (key) => this.configurationContext(key));
  }
  reserved(id: string) { return this.catalog.reserved(id); }

  private scopeAddress(key: string) {
    const address = this.resolveAddress(key);
    // Workspace addresses are roots and can be planned before application providers mount.
    if (!address.length && key.startsWith('workspace:'))
      return [{ key, scope: { kind: 'workspace' as const, workspaceId: key.slice('workspace:'.length) } }];
    return address;
  }

  address(id: string) {
    return this.scopeAddress('session:' + id).map(({ key }) => key);
  }

  require<Name extends keyof HostServices & string>(id: string | null | undefined, service: Name): NonNullable<HostServices[Name]> {
    const value = this.optional(id, service);
    if (value == null) {
      const settings = this.settings();
      for (const key of id ? [...this.address(id)].reverse() : []) {
        const provider = settings.scopes[key]?.providers?.[service];
        const failure = provider && this.failures.get(key + '/' + provider);
        if (failure) throw new DomainError('unavailable', 'Provider ' + provider + ' failed in ' + key + ': ' + failure);
      }
      throw new Error('Required service is unavailable: ' + service + (id ? ' in session ' + id : ''));
    }
    return value;
  }

  optional<Name extends keyof HostServices & string>(id: string | null | undefined, service: Name): HostServices[Name] | undefined {
    const scope = id && this.address(id).reverse().map((key) => this.scopes.get(key)).find(Boolean);
    return ((scope || undefined)?.ctx ?? this.ctx).get(service) as HostServices[Name] | undefined;
  }

  async prepare(id: string, signal?: AbortSignal) {
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
    if (!this.started) return;
    const settings = this.settings();
    if (!this.address(id).some((key) => Object.hasOwn(settings.scopes, key) && !this.scopes.has(key))) return;
    await this.apply(settings, () => {}, false, id);
  }

  private scopedMounts(settings: PluginSettings, descriptors: ReturnType<PluginCatalog['descriptors']>,
    appPlans: PluginPlan[], appProviders: ReadonlyMap<string, string>, unavailable: (id: string, error: unknown) => boolean,
    preparing?: string, released: ReadonlySet<string> = new Set(), validating: readonly string[] = []) {
    const scopes = new Map<string, MountedScope>();
    const mounts: MountPlan[] = [];
    const diagnostics: ReturnType<PluginHost['describe']>[] = [];
    const active = new Set([...Object.keys(settings.scopes).filter((key) => key.startsWith('workspace:')), ...this.scopes.keys(), ...validating, ...(preparing ? this.address(preparing) : [])]);
    for (const key of active)
      for (const ancestor of this.scopeAddress(key)) if (!released.has(ancestor.key)) active.add(ancestor.key);
    const graph = resolveScopes(settings, this.catalog.plans.bind(this.catalog), (key) => this.scopeAddress(key),
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
    return { scopes, mounts, diagnostics };
  }

  private async load(plan: PluginPlan, scope: PluginScope, scopeKey?: string): ReturnType<MountPlan['load']> {
    const { descriptor, source } = plan;
    const mod = source ? await import(pathToFileURL(source).href + '?v=' + lstatSync(source).mtimeMs) : undefined;
    const setup = source ? mod.default : descriptor.setup ?? (() => {});
    if (typeof setup !== 'function' || mod?.inject !== undefined || (source && setup.inject !== undefined))
      throw new Error('Export a default setup function and declare dependencies in plugin.json');
    return { inject: descriptor.inject ?? [], setup: async (ctx, lifetime, setDrain, setConfig) => {
      const changes = this.ctx.get('harnessChanges');
      const domain = 'plugin:' + plan.id;
      if (changes) ctx.effect(() => changes.register(domain));
      const runtime = createPluginApi(ctx, plan, { scope, scopeKey, lifetime,
        readOnlyGrant: (name) => source
          ? this.settings().readOnlyTools?.[plan.id]?.includes(name) === true
          : this.authority.defaultReadOnlyTools?.get(plan.id)?.has(name) === true,
        address: (id) => this.address(id),
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
        invalidate: () => changes?.invalidate(domain)
      });
      setDrain(runtime.drain);
      if (descriptor.validateConfig) this.catalog.validateConfig(descriptor, runtime.api.config, 'mount', ctx);
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

  browserAsset(url: string) { return this.browserState.assets.get(url); }

  start(settings: PluginSettings) { return this.apply(settings, () => {}, true); }

  async configure(settings: PluginSettings, commit = () => {}, released?: ReadonlySet<string>) {
    while (this.applying) await this.applying.catch(() => {});
    if (this.closing) throw new Error('Plugin host is closing');
    return this.apply(settings, commit, false, undefined, released);
  }

  private apply(settings: PluginSettings, commit: () => void, starting: boolean, preparing?: string, released?: ReadonlySet<string>) {
    const work = this.configureGraph(settings, commit, starting, preparing, released);
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
      if (this.catalog.builtins.get(id)?.required || this.mounts.plan(id)) return false;
      failures.set(id, message);
      return true;
    };
    const { plans, providers } = this.catalog.plans(settings, descriptors, 'application', this.root, new Set(), undefined, unavailable);
    const scoped = this.scopedMounts(settings, descriptors, plans, providers, unavailable, preparing, released, validations.flatMap(({ key }) => key ? [key] : []));
    const browser = planBrowser(plans, unavailable);
    const mounts = [...plans.filter(({ id }) => !failures.has(id)).map((plan) => this.mountPlan(plan, appScope)), ...scoped.mounts];
    const appChanged = !isDeepStrictEqual(previous.providers, settings.providers) ||
      descriptors.some(({ id, configChanges, scope, setup, source }) => scope === 'application' && (setup || source) &&
        (previous.plugins[id] !== settings.plugins[id] || configChanges !== 'live' && settings.plugins[id] &&
          !isDeepStrictEqual(settings.pluginConfig[id], previous.pluginConfig[id])));
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
        commit();
        this.started = true;
        this.scopes = scoped.scopes;
        this.failures = failures;
        this.browserState = publishBrowser(browser, plans, (id) => Boolean(this.mounts.plan(id)));
        this.graph = [...plans.map((plan) => this.describe(plan)), ...scoped.diagnostics]
          .filter(({ id }) => this.mounts.plan(id));
        this.ctx.get('harnessChanges')?.invalidate('plugins');
      }, unavailable, () => {
        for (const { descriptor, config, key } of validations)
          this.catalog.validateConfig(descriptor, config, 'write', this.configurationContext(key, scoped.scopes));
      });
    } finally { release?.(); }
  }

  async close() {
    this.closing = true;
    await this.applying?.catch(() => {});
    try { await this.mounts.close(); }
    finally { this.scopes.clear(); }
  }
}
