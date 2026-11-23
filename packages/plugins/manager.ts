import { dirname, join } from 'node:path';
import { Context } from 'cordis';
import { isDeepStrictEqual } from 'node:util';
import { lstatSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { PluginDescriptor, SessionRecords } from '@mini-harness/contracts/plugins';
import type { HostServices, PluginScope, ScopePort } from '@mini-harness/contracts/capabilities';
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
    private readonly sessionRecords: (sessionId: string, pluginId: string) => SessionRecords,
    private readonly upgrade?: (path: string, handler: UpgradeHandler) => () => void, devPlugin?: string) {
    this.catalog = new PluginCatalog(directory, builtins, rootServices, devPlugin);
    this.mounts = new PluginMounts(ctx);
    this.root = new Map(rootServices.map((name) => [name, 'application']));
  }

  private failedConfig = new Map<string, Record<string, unknown> | undefined>();
  private assets = new Map<string, { path: string; mime: string }>();
  private published: BrowserEntry[] = [];
  private readonly failures = new Map<string, string>();
  private readonly draining = new Set<string>();
  private graph: ReturnType<PluginHost['describe']>[] = [];

  effective(settings: Settings) { return this.catalog.effective(settings); }
  browser() { return structuredClone(this.published); }
  diagnostics() { return structuredClone(this.graph); }
  private describe(plan: PluginPlan, id = plan.id, requires = plan.requires) {
    const { services, descriptor } = plan;
    return { id, requires, services, provides: descriptor.provides ?? [], optional: descriptor.optional ?? [],
      scope: descriptor.scope, source: descriptor.trustedCode ? 'local' : 'built-in' };
  }

  metadata() {
    return this.catalog.metadata().map((metadata) => {
      const { id } = metadata;
      const error = metadata.error ?? (this.mounts.plan(id) ? undefined : this.failures.get(id));
      const scopedReady = [...this.scopes.keys()].some((key) => this.mounts.plan(key + '/' + id));
      const state = this.draining.has(id) ? 'draining' : this.mounts.plan(id) || scopedReady ? 'ready' : error ? 'failed' : 'discovered';
      return { ...metadata, error, state } as const;
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
    if (value == null) throw new Error('Required service is unavailable: ' + service + (id ? ' in session ' + id : ''));
    return value;
  }

  optional<Name extends keyof HostServices & string>(id: string | null | undefined, service: Name): HostServices[Name] | undefined {
    const scope = id && this.address(id).reverse().map((key) => this.scopes.get(key)).find(Boolean);
    return ((scope || undefined)?.ctx ?? this.ctx).get(service) as HostServices[Name] | undefined;
  }

  allowsTool(id: string, tool: string) {
    if (!this.started) return true;
    const { scopes } = this.settings();
    return this.address(id).every((key) => !scopes[key]?.disabledTools?.includes(tool));
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
    appPlans: PluginPlan[], appProviders: ReadonlyMap<string, string>, preparing?: string, released = new Set<string>()) {
    const scopes = new Map<string, MountedScope>();
    const mounts: MountPlan[] = [];
    const diagnostics: ReturnType<PluginHost['describe']>[] = [];
    const active = new Set([...this.scopes.keys(), ...(preparing ? this.address(preparing) : [])]);
    for (const key of active) if (key.startsWith('session:'))
      for (const ancestor of this.address(key.slice('session:'.length))) if (!released.has(ancestor)) active.add(ancestor);
    const graph = resolveScopes(settings, this.catalog.plans.bind(this.catalog), this.session,
      descriptors, appPlans, appProviders, active, released);
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
        address: (id) => this.address(id), records: (id) => this.sessionRecords(id, plan.id),
        routes: this.ctx.get('harnessRoutes'), upgrade: this.upgrade,
        dataRoot: join(dirname(this.directory), 'plugin-data'),
        invalidate: () => this.ctx.harnessChanges.dispatchEvent(new CustomEvent('change', {
          detail: { domain: 'plugin:' + plan.id }
        }))
      });
      setDrain(runtime.drain);
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
        styles: resources?.styles, preload: resources?.preload, config: plan.config ?? {}, required: plan.descriptor.required };
    });
  }

  start(settings: Settings) { return this.configure(settings, undefined, true); }

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
    const failedConfig = new Map<string, Record<string, unknown> | undefined>();
    const unavailable = (id: string, error: unknown) => {
      if (this.catalog.builtins.get(id)?.required || Object.values(settings.providers).includes(id)) return false;
      const config = settings.pluginConfig[id];
      const canSkip = starting || (this.failedConfig.has(id) && isDeepStrictEqual(config, this.failedConfig.get(id)));
      if (canSkip) {
        failedConfig.set(id, config);
        failures.set(id, error instanceof Error ? error.message : String(error));
      }
      return canSkip;
    };
    const descriptors = this.catalog.descriptors();
    const { plans, providers } = this.catalog.plans(settings, descriptors, 'application', this.root, new Set(), undefined, unavailable);
    const scoped = this.scopedMounts(settings, descriptors, plans, providers, preparing, released);
    const browser = this.browserPlan(plans, unavailable);
    const mounts = [...plans.filter(({ id }) => !failures.has(id)).map((plan) => this.mountPlan(plan, appScope)), ...scoped.mounts];
    try {
      await this.mounts.configure(mounts, () => {
        commit();
        this.started = true;
        this.scopes.clear();
        for (const [key, state] of scoped.scopes) this.scopes.set(key, state);
        this.failedConfig = failedConfig;
        this.failures.clear();
        for (const [id, error] of failures) this.failures.set(id, error);
        const ready = new Set<string>();
        this.published = browser.filter(({ id, requires }) => {
          if (!this.mounts.plan(id) || (requires ?? []).some((dependency) => !ready.has(dependency))) return false;
          ready.add(id);
          return true;
        });
        this.assets = new Map(plans.filter(({ id }) => ready.has(id)).flatMap(({ descriptor }) =>
          [...(descriptor.resources?.urls ?? [])]));
        this.graph = [...plans.map((plan) => this.describe(plan)), ...scoped.diagnostics]
          .filter(({ id }) => this.mounts.plan(id));
      }, (ids) => { for (const id of ids) this.draining.add(id); }, unavailable);
    } finally { this.draining.clear(); }
  }

  async close() {
    this.closing = true;
    await this.applying?.catch(() => {});
    try { await this.mounts.close(); }
    finally { this.scopes.clear(); }
  }
}
