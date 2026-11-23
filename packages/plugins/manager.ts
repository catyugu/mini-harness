import { Context } from 'cordis';
import { isDeepStrictEqual } from 'node:util';
import { lstatSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { PluginDescriptor, PluginApi, SessionRecords } from '../contracts/plugins.js';
import type { PluginScope, ScopePort } from '../contracts/capabilities.js';
import type { BrowserEntry } from '../contracts/browser.js';
import { addAbortListener } from 'node:events';
import type { SessionRecord } from '../contracts/conversation.js';
import type { Settings } from '../contracts/config.js';
import { resolveCapabilities } from '../kernel/composition.js';
import { PluginMounts, type MountPlan } from '../kernel/mounts.js';
import { PluginCatalog, type PluginPlan } from './catalog.js';

const appScope: PluginScope = { kind: 'application' };

/** The descriptor and its resolved graph are the source of both server and browser mounts. */
export class PluginHost implements ScopePort {
  private readonly catalog: PluginCatalog;
  private readonly mounts: PluginMounts;
  private readonly root: ReadonlyMap<string, string>;
  private readonly scopes = new Map<string, { ctx: Context; parent: Context; scope: PluginScope }>();
  private started = false;
  private applying?: Promise<void>;
  private closing = false;

  constructor(readonly ctx: Context, directory: string, builtins: PluginDescriptor[], rootServices: string[],
    private readonly settings: () => Settings,
    private readonly session: (id: string) => SessionRecord | undefined,
    private readonly sessionRecords: (sessionId: string, pluginId: string) => SessionRecords) {
    this.catalog = new PluginCatalog(directory, builtins, rootServices);
    this.mounts = new PluginMounts(ctx);
    this.root = new Map(rootServices.map((name) => [name, 'application']));
  }

  private failedConfig = new Map<string, Record<string, unknown> | undefined>();
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
      scope: descriptor.scope, protocol: descriptor.protocol, source: descriptor.trustedCode ? 'local' : 'built-in' };
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
      let listener: ReturnType<typeof addAbortListener>;
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
    const scopes = new Map([...this.scopes].filter(([key]) => !released.has(key)));
    const mounts: MountPlan[] = [];
    const diagnostics: ReturnType<PluginHost['describe']>[] = [];
    const allKeys = Object.keys(settings.scopes).filter((key) => !released.has(key));
    const appIds = new Map(appPlans.map(({ id }) => [id, id]));
    const graph = new Map<string, { ctx: Context; providers: ReadonlyMap<string, string>; ids: ReadonlyMap<string, string> }>();
    const app: { ctx: Context; providers: ReadonlyMap<string, string>; ids: ReadonlyMap<string, string> } =
      { ctx: this.ctx, providers: appProviders, ids: appIds };

    const visiting = new Set<string>();
    const visit = (key: string): typeof app => {
      if (graph.has(key)) return graph.get(key);
      if (visiting.has(key)) throw new Error('Cyclic scope ancestry: ' + key);
      visiting.add(key);
      const [kind, id] = key.split(':');
      const record = kind === 'session' ? this.session(id) : undefined;
      if (kind === 'session' && !record) { visiting.delete(key); return app; }
      const scope: PluginScope = record ? { kind: 'session', workspaceId: record.workspaceId, sessionId: id } :
        { kind: 'workspace', workspaceId: id };
      const parentKey = record && (record.parentId ? 'session:' + record.parentId : 'workspace:' + record.workspaceId);
      const parent = parentKey ? visit(parentKey) : app;
      visiting.delete(key);
      if (released.has(key)) return parent;
      const overrides = settings.scopes[key];
      if (!overrides) { scopes.delete(key); return parent; }
      const { plans, providers } = this.catalog.plans(settings, descriptors, scope.kind, parent.providers, new Set(parent.ids.keys()), overrides);
      const ids = new Map<string, string>([...parent.ids, ...plans.map(({ id }) => [id, key + '/' + id] as const)]);
      let ctx = parent.ctx;
      if (scopes.has(key) || (preparing && this.address(preparing).includes(key))) {
        const existing = scopes.get(key);
        ctx = existing?.parent === parent.ctx ? existing.ctx : parent.ctx.extend();
        for (const { descriptor } of plans) for (const service of descriptor.provides ?? [])
          if (!existing || existing.ctx !== ctx || !Object.hasOwn(ctx[Context.isolate], service))
            ctx = ctx.isolate(service);
        scopes.set(key, { ctx, parent: parent.ctx, scope });
        for (const plan of plans) {
          const needs = [...new Set([...(descriptors.find(({ id }) => id === plan.id)?.requires ?? []), ...Object.values(plan.services)])]
            .flatMap((id) => ids.has(id) ? [ids.get(id)] : []);
          const id = ids.get(plan.id);
          mounts.push(this.mountPlan(plan, scope, id, key, ctx, needs));
          diagnostics.push(this.describe(plan, id, needs));
        }
      }
      const current = { ctx, ids, providers };
      graph.set(key, current);
      return current;
    };
    for (const key of new Set([...allKeys, ...scopes.keys()])) visit(key);
    return { scopes, mounts, diagnostics };
  }

  private async load(plan: PluginPlan, scope: PluginScope, scopeKey?: string): ReturnType<MountPlan['load']> {
    const { descriptor, source } = plan;
    const mod = source ? await import(pathToFileURL(source).href + '?v=' + lstatSync(source).mtimeMs) : undefined;
    const setup = source ? mod.default : descriptor.setup ?? (() => {});
    if (typeof setup !== 'function' || mod?.inject !== undefined || (source && setup.inject !== undefined))
      throw new Error('Export a default setup function and declare dependencies in plugin.json');
    return { inject: descriptor.inject ?? [], setup: async (ctx: Context, lifetime: AbortSignal) => {
      const values = Object.freeze(structuredClone(plan.config ?? {}));
      const provided = new Set<string>();
      const use = <T>(name: string): T | undefined => {
        if (!descriptor.inject?.includes(name) && !descriptor.optional?.includes(name))
          throw new Error('Service is not declared by ' + plan.id + ': ' + name);
        return ctx.get(name) as T | undefined;
      };
      const inScope = (id: string) => !scopeKey || this.address(id).includes(scopeKey);
      const checkSession = (id: string) => {
        if (!inScope(id)) throw new Error('Conversation outside plugin scope');
      };
      const cleanup = await setup(ctx, {
        scope: Object.freeze({ ...scope }), signal: lifetime, config: values, service: use,
        observe: (handler) => ctx.on('harness/observe', (event) => {
          if (lifetime.aborted || (event.type === 'session-deleted'
            ? scopeKey && !event.scopeKeys.includes(scopeKey)
            : !inScope(event.sessionId))) return;
          void Promise.resolve().then(() => {
            if (!lifetime.aborted) return handler(structuredClone(event));
          }).catch(() => ctx.logger.warn('Plugin observer failed: ' + plan.id));
        }),
        decideTool: (handler) => ctx.on('harness/tool-decision', async (request) => {
          if (lifetime.aborted || !inScope(request.sessionId)) return;
          const signal = AbortSignal.any([lifetime, request.signal]);
          signal.throwIfAborted();
          const decision = await handler({ ...request, signal });
          signal.throwIfAborted();
          return decision;
        }),
        transformTool: (handler) => ctx.on('harness/tool-projection', (request, next) => {
          const content = next();
          if (lifetime.aborted || !inScope(request.sessionId)) return content;
          try { return handler(structuredClone({ ...request, content })) ?? content; }
          catch { ctx.logger.warn('Plugin tool projection failed: ' + plan.id); return content; }
        }),
        provide(name, service) {
          if (!descriptor.provides?.includes(name) || provided.has(name)) throw new Error('Undeclared or duplicate service: ' + name);
          ctx.provide(name, service);
          provided.add(name);
        },
        registerTool: (tool) => {
          const tools = use<Context['harnessTools']>('harnessTools');
          return ctx.effect(() => tools.register(tool.name, () => tool, undefined, false, scopeKey));
        },
        registerRoute: (method, path, handler) => {
          if (scopeKey || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ||
              !/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/.test(path)) throw new Error('Invalid plugin route');
          const routes = use<Context['harnessRoutes']>('harnessRoutes');
          return ctx.effect(() => routes.register(method, '/api/extensions/' + plan.id + path, handler));
        },
        records: {
          list: async (sessionId) => { checkSession(sessionId); return this.sessionRecords(sessionId, plan.id).list(); },
          append: async (sessionId, data) => { checkSession(sessionId); return this.sessionRecords(sessionId, plan.id).append(data); }
        },
        onDispose: (dispose) => ctx.effect(() => dispose)
      } satisfies PluginApi);
      if (typeof cleanup === 'function') ctx.effect(() => cleanup);
      if (descriptor.trustedCode && descriptor.provides?.some((service) => !provided.has(service)))
        throw new Error('Plugin did not publish all declared services: ' + plan.id);
    } };
  }

  private mountPlan(plan: PluginPlan, scope: PluginScope, key = plan.id, scopeKey?: string, context?: Context, requires = plan.requires): MountPlan {
    return {
      id: key, requires, context,
      signature: { source: plan.source, requires, inject: plan.descriptor.inject, provides: plan.descriptor.provides,
        optional: plan.descriptor.optional, services: plan.services,
        config: plan.descriptor.configChanges === 'read-on-use' ? undefined : plan.config },
      load: () => this.load(plan, scope, scopeKey)
    };
  }

  private browserPlan(candidate: PluginPlan[], unavailable: (id: string, error: unknown) => boolean) {
    const browser = new Map(candidate.filter(({ browser, web }) => browser || web).map((plan) => [plan.id, plan]));
    const runtimeServices = ['harnessBrowser', 'miniSelection', 'miniSessions',
      'miniWorkspaces', 'miniSettingsData', 'miniModels', 'miniPluginData', 'miniApprovals', 'miniSwitch'];
    const { ordered } = resolveCapabilities([...browser.values()].map((plan) => ({
      id: plan.id, provides: plan.descriptor.browserProvides, inject: plan.descriptor.browserInject,
      requires: [...new Set([...(plan.browserRequires ?? []),
        ...(plan.descriptor.requires ?? []).filter((dependency) => browser.has(dependency))])]
    })), new Map(runtimeServices.map((name) => [name, 'browser-runtime'])), {}, unavailable);
    return ordered.map(({ descriptor, requires }): BrowserEntry => {
      const plan = browser.get(descriptor.id);
      return { id: plan.id, requires, inject: descriptor.inject, browser: plan.browser, web: plan.web,
        config: plan.config, required: plan.descriptor.required };
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
          if (!this.mounts.plan(id) || requires.some((dependency) => !ready.has(dependency))) return false;
          ready.add(id);
          return true;
        });
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
