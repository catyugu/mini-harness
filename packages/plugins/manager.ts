import { HttpError } from '@mini-harness/contracts/routes';
import { dirname, join } from 'node:path';
import { Context } from 'cordis';
import { isDeepStrictEqual } from 'node:util';
import { lstatSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { ConfigValidationContext, PluginDescriptor, PluginMetadata } from '@mini-harness/contracts/plugins';
import type { HostServices, PluginScope, ScopePort } from '@mini-harness/contracts/capabilities';
import type { ServiceMap } from '@mini-harness/contracts/plugin-sdk';
import type { BrowserEntry } from '@mini-harness/contracts/browser';
import { addAbortListener } from 'node:events';
import type { SessionRecord } from '@mini-harness/contracts/conversation';
import type { UpgradeHandler } from '@mini-harness/contracts/routes';
import type { Settings } from '@mini-harness/contracts/config';
import { resolveCapabilities } from '@mini-harness/kernel/composition';
import { PluginMounts, type MountPlan } from '@mini-harness/kernel/mounts';
import { resolveScopes } from './scope-graph.js';
import { createPluginApi } from './api.js';
import { PluginCatalog, type PluginPlan } from './catalog.js';

type MountedScope = { ctx: Context; parent: Context; scope: PluginScope; isolates: string[] };

const appScope: PluginScope = { kind: 'application' };

/** The descriptor and its resolved graph are the source of both server and browser mounts. */
export class PluginHost implements ScopePort {
  private readonly catalog: PluginCatalog;
  private readonly mounts: PluginMounts;
  private readonly root: ReadonlyMap<string, string>;
  private readonly scopes = new Map<string, MountedScope>();
  private started = false;
  private applying?: Promise<void>;
  private closing = false;

  constructor(readonly ctx: Context, private readonly directory: string, builtins: PluginDescriptor[], rootServices: string[],
    private readonly settings: () => Settings,
    private readonly session: (id: string) => SessionRecord | undefined,
    private readonly upgrade?: (path: string, handler: UpgradeHandler) => () => void, devPlugin?: string,
    private readonly writePlugin?: (id: string, key: string | undefined, patch: unknown, check: () => void) => Promise<void>,
    private readonly authority: {
      trustedContributors?: ReadonlySet<string>;
      protectedProviders?: ReadonlyMap<string, string>;
    } = {}) {
    this.catalog = new PluginCatalog(directory, builtins, rootServices, devPlugin, authority.protectedProviders);
    this.mounts = new PluginMounts(ctx);
    this.root = new Map(rootServices.map((name) => [name, 'application']));
  }

  private configSchemas = new Set<string>();
  private assets = new Map<string, { path: string; mime: string }>();
  private published: BrowserEntry[] = [];
  private readonly failures = new Map<string, string>();
  private graph: ReturnType<PluginHost['describe']>[] = [];

  effective(settings: Settings) { return this.catalog.effective(settings); }
  browser() { return structuredClone(this.published); }

  async writeBrowserConfig(id: string, patch: unknown, signal: AbortSignal) {
    if (!this.writePlugin) throw new HttpError('unavailable', 'Plugin settings are unavailable');
    await this.writePlugin(id, undefined, patch, () => {
      signal.throwIfAborted();
      if (!this.published.some((entry) => entry.id === id && entry.browser) || !this.configSchemas.has(id))
        throw new HttpError('not_found', 'Plugin settings are unavailable');
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
    const keys = key.startsWith('session:') ? this.address(key.slice('session:'.length)) : [key];
    return keys.reverse().map((item) => scopes.get(item)).find(Boolean)?.ctx ?? this.ctx;
  }

  private validateConfig(descriptor: PluginDescriptor, config: Record<string, unknown>,
    operation: ConfigValidationContext['operation'], ctx: Context) {
    descriptor.validateConfig?.(Object.freeze(structuredClone(config)), {
      operation,
      service<Name extends keyof ServiceMap & string>(name: Name): NonNullable<ServiceMap[Name]> {
        if (!descriptor.inject?.includes(name) && !descriptor.optional?.includes(name))
          throw new Error('Configuration dependency is not declared by ' + descriptor.id + ': ' + name);
        const service = ctx.get(name) as ServiceMap[Name] | undefined;
        if (service == null) throw new HttpError('unavailable', 'Configuration dependency is unavailable to ' + descriptor.id + ': ' + name);
        return service;
      }
    });
  }

  metadata() {
    const settings = this.settings();
    const descriptors = new Map(this.catalog.descriptors().map((item) => [item.id, item]));
    return this.catalog.metadata([...descriptors.values()]).map((metadata): PluginMetadata => {
      const { id } = metadata;
      const descriptor = descriptors.get(id);
      const configurationError = (key?: string) => {
        try {
          const values = key ? { ...settings.pluginConfig[id], ...settings.scopes[key]?.pluginConfig?.[id] } : settings.pluginConfig[id];
          const config = this.catalog.configValues(id, values, descriptor?.configSchema);
          if (descriptor?.validateConfig) this.validateConfig(descriptor, config, 'inspect', this.configurationContext(key));
        } catch (error) { return error instanceof Error ? error.message : String(error); }
      };
      const scopes = metadata.scope === 'application'
        ? [{ scope: 'application', enabled: settings.plugins[id] === true }]
        : Object.entries(settings.scopes).flatMap(([scope, value]) => {
          if (!scope.startsWith(metadata.scope + ':')) return [];
          const enabled = value.plugins?.[id] === true || Object.values(value.providers ?? {}).includes(id);
          return enabled || Object.hasOwn(value.pluginConfig ?? {}, id) ? [{ scope, enabled }] : [];
        });
      const instances = scopes.map(({ scope, enabled }): NonNullable<PluginMetadata['instances']>[number] => {
        const key = scope === 'application' ? id : scope + '/' + id;
        const error = this.failures.get(key) ?? metadata.error ?? configurationError(scope === 'application' ? undefined : scope);
        const state = !enabled ? 'disabled' : error ? 'failed' : this.mounts.plan(key) ? 'ready' : 'inactive';
        return { scope, error, state };
      });
      const enabled = instances.filter(({ state }) => state !== 'disabled');
      const failed = enabled.find(({ state }) => state === 'failed');
      const ready = enabled.filter(({ state }) => state === 'ready').length;
      const state = ready ? ready === enabled.length ? 'ready' : 'partial' : failed ? 'failed' : enabled.length ? 'inactive' : 'disabled';
      return { ...metadata, instances, state,
        error: failed?.error ?? instances.find(({ error }) => error)?.error ?? metadata.error };
    });
  }
  reserved(id: string) { return this.catalog.reserved(id); }

  private lineage(id: string) {
    const records: SessionRecord[] = [];
    const seen = new Set<string>();
    let current = this.session(id);
    if (!current) return records;
    while (current) {
      if (seen.has(current.id) || (records.length && current.workspaceId !== records[0].workspaceId))
        throw new Error('Invalid session scope ancestry');
      records.unshift(current);
      seen.add(current.id);
      current = current.parentId ? this.session(current.parentId) : undefined;
    }
    return records;
  }

  address(id: string) {
    const records = this.lineage(id);
    if (!records.length) return [];
    return ['workspace:' + records[0].workspaceId, ...records.map(({ id }) => 'session:' + id)];
  }

  require<Name extends keyof HostServices & string>(id: string | null | undefined, service: Name): NonNullable<HostServices[Name]> {
    const value = this.optional(id, service);
    if (value == null) {
      const settings = this.settings();
      for (const key of id ? [...this.address(id)].reverse() : []) {
        const provider = settings.scopes[key]?.providers?.[service];
        const failure = provider && this.failures.get(key + '/' + provider);
        if (failure) throw new HttpError('unavailable', 'Provider ' + provider + ' failed in ' + key + ': ' + failure);
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

  async release(ids: string[], workspaceId?: string) {
    const released = [...ids.map((id) => 'session:' + id), ...(workspaceId ? ['workspace:' + workspaceId] : [])];
    while (this.applying) await this.applying.catch(() => {});
    if (this.closing || !released.some((key) => this.scopes.has(key))) return;
    await this.apply(this.settings(), () => {}, false, undefined, new Set(released));
  }

  private scopedMounts(settings: Settings, descriptors: ReturnType<PluginCatalog['descriptors']>,
    appPlans: PluginPlan[], appProviders: ReadonlyMap<string, string>, unavailable: (id: string, error: unknown) => boolean,
    preparing?: string, released = new Set<string>(), validating: readonly string[] = []) {
    const scopes = new Map<string, MountedScope>();
    const mounts: MountPlan[] = [];
    const diagnostics: ReturnType<PluginHost['describe']>[] = [];
    const active = new Set([...Object.keys(settings.scopes).filter((key) => key.startsWith('workspace:')), ...this.scopes.keys(), ...validating, ...(preparing ? this.address(preparing) : [])]);
    for (const key of active) if (key.startsWith('session:'))
      for (const ancestor of this.address(key.slice('session:'.length))) if (!released.has(ancestor)) active.add(ancestor);
    const graph = resolveScopes(settings, this.catalog.plans.bind(this.catalog), this.session,
      descriptors, appPlans, appProviders, active, released, unavailable);
    for (const { key, parent, scope, isolates, plugins } of graph) {
      const parentContext = parent ? scopes.get(parent)?.ctx : this.ctx;
      if (!parentContext) throw new Error('Scoped mount is missing its parent: ' + key);
      const existing = this.scopes.get(key);
      const reusable = existing?.parent === parentContext && isDeepStrictEqual(existing.isolates, isolates);
      let ctx = reusable ? existing.ctx : parentContext.extend();
      if (!reusable) for (const service of isolates) ctx = ctx.isolate(service);
      scopes.set(key, { ctx, parent: parentContext, scope, isolates });
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
      const runtime = createPluginApi(ctx, plan, { scope, scopeKey, lifetime,
        trusted: !source && this.authority.trustedContributors?.has(plan.id) === true,
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
        invalidate: () => this.ctx.harnessChanges.dispatchEvent(new CustomEvent('change', {
          detail: { domain: 'plugin:' + plan.id }
        }))
      });
      setDrain(runtime.drain);
      if (descriptor.validateConfig) this.validateConfig(descriptor, runtime.api.config, 'mount', ctx);
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

  browserAsset(url: string) { return this.assets.get(url); }

  private browserPlan(candidate: PluginPlan[], unavailable: (id: string, error: unknown) => boolean) {
    const browser = new Map(candidate.filter(({ browser, web }) => browser || web).map((plan) => [plan.id, plan]));
    const runtimeServices = ['miniProjections', 'miniSwitch', 'miniBrowserFailures'];
    const { ordered } = resolveCapabilities([...browser.values()].map((plan) => ({
      id: plan.id, provides: plan.descriptor.browserProvides, inject: plan.descriptor.browserInject,
      requires: [...new Set([...(plan.browserRequires ?? []),
        ...(plan.descriptor.requires ?? []).filter((dependency) => browser.has(dependency))])]
    })), new Map(runtimeServices.map((name) => [name, 'browser-runtime'])), {}, unavailable);
    return ordered.map(({ descriptor, requires }): BrowserEntry => {
      const plan = browser.get(descriptor.id);
      if (!plan) throw new Error('Composed browser capability is unavailable: ' + descriptor.id);
      const resources = plan.descriptor.resources;
      return { id: plan.id, requires: requires ?? [], inject: plan.descriptor.browserInject, browser: resources?.entry ?? plan.browser,
        styles: resources?.styles, preload: resources?.preload, config: plan.config ?? {}, liveConfig: plan.descriptor.configChanges === 'live', required: plan.descriptor.required };
    });
  }

  start(settings: Settings, commit?: () => void) { return this.configure(settings, commit, true); }

  async configure(settings: Settings, commit = () => {}, starting = false) {
    while (this.applying) await this.applying.catch(() => {});
    if (this.closing) throw new Error('Plugin host is closing');
    return this.apply(settings, commit, starting);
  }

  private apply(settings: Settings, commit: () => void, starting: boolean, preparing?: string, released?: Set<string>) {
    const work = this.configureGraph(settings, commit, starting, preparing, released);
    this.applying = work;
    return work.finally(() => { if (this.applying === work) this.applying = undefined; });
  }

  private async configureGraph(settings: Settings, commit: () => void, starting: boolean, preparing?: string, released?: Set<string>) {
    const failures = new Map<string, string>();
    const previous = this.settings();
    const descriptors = this.catalog.descriptors();
    const validations: { descriptor: PluginDescriptor; config: Record<string, unknown>; key?: string }[] = [];
    if (!starting && !preparing && !released) {
      for (const descriptor of descriptors) {
        const { id, configSchema, scope } = descriptor;
        const validate = (values: Record<string, unknown> | undefined, before: Record<string, unknown> | undefined, key?: string) => {
          if (isDeepStrictEqual(values, before)) return;
          const config = this.catalog.configValues(id, values, configSchema);
          if (descriptor.validateConfig) validations.push({ descriptor, config, key });
        };
        if (scope === 'application') validate(settings.pluginConfig[id], previous.pluginConfig[id]);
        else {
          validate(settings.pluginConfig[id], previous.pluginConfig[id]);
          for (const key of Object.keys(settings.scopes)) {
            if (!key.startsWith(scope + ':')) continue;
            const changed = settings.scopes[key]?.pluginConfig?.[id];
            const before = previous.scopes[key]?.pluginConfig?.[id];
            const selected = settings.scopes[key];
            if (changed === undefined && !selected.plugins?.[id] && !Object.values(selected.providers ?? {}).includes(id)) continue;
            validate({ ...settings.pluginConfig[id], ...changed }, { ...previous.pluginConfig[id], ...before }, key);
          }
        }
      }
    }
    const healthy = new Set<string>();
    const unavailable = (id: string, error: unknown) => {
      if (this.catalog.builtins.get(id)?.required || healthy.has(id) || this.mounts.plan(id)) return false;
      failures.set(id, error instanceof Error ? error.message : String(error));
      return true;
    };
    const planningUnavailable = (id: string, error: unknown) => {
      if (!starting && !preparing && !released && !this.failures.has(id)) {
        const separator = id.indexOf('/');
        if (separator < 0) {
          if (settings.plugins[id] !== previous.plugins[id] || !isDeepStrictEqual(previous.providers, settings.providers)) return false;
        } else {
          const key = id.slice(0, separator), plugin = id.slice(separator + 1);
          const before = previous.scopes[key], next = settings.scopes[key];
          if (before?.plugins?.[plugin] !== next?.plugins?.[plugin] ||
              !isDeepStrictEqual(before?.providers, next?.providers)) return false;
        }
      }
      return unavailable(id, error);
    };
    const { plans, providers } = this.catalog.plans(settings, descriptors, 'application', this.root, new Set(), undefined, planningUnavailable);
    const scoped = this.scopedMounts(settings, descriptors, plans, providers, planningUnavailable, preparing, released, validations.flatMap(({ key }) => key ? [key] : []));
    const browser = this.browserPlan(plans, planningUnavailable);
    const mounts = [...plans.filter(({ id }) => !failures.has(id)).map((plan) => this.mountPlan(plan, appScope)), ...scoped.mounts];
    for (const { id } of mounts) if (this.mounts.plan(id)) healthy.add(id);
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
        this.scopes.clear();
        for (const [key, state] of scoped.scopes) this.scopes.set(key, state);
        this.failures.clear();
        for (const [id, error] of failures) this.failures.set(id, error);
        const ready = new Set<string>();
        this.configSchemas = new Set(descriptors.filter(({ configSchema }) => configSchema).map(({ id }) => id));
        this.published = browser.filter(({ id, requires }) => {
          if (!this.mounts.plan(id) || (requires ?? []).some((dependency) => !ready.has(dependency))) return false;
          ready.add(id);
          return true;
        });
        this.assets = new Map(plans.filter(({ id }) => ready.has(id)).flatMap(({ descriptor }) =>
          [...(descriptor.resources?.urls ?? [])]));
        this.graph = [...plans.map((plan) => this.describe(plan)), ...scoped.diagnostics]
          .filter(({ id }) => this.mounts.plan(id));
        this.ctx.get('harnessChanges')?.dispatchEvent(new CustomEvent('change', { detail: { domain: 'plugins' } }));
      }, unavailable, () => {
        for (const { descriptor, config, key } of validations)
          this.validateConfig(descriptor, config, 'write', this.configurationContext(key, scoped.scopes));
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
