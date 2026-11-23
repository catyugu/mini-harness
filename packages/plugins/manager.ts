import type { Context } from 'cordis';
import { isDeepStrictEqual } from 'node:util';
import { lstatSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { BuiltinPlugin, PluginApi, SessionRecords } from '../contracts/plugins.js';
import type { BrowserEntry } from '../contracts/browser.js';
import type { Settings } from '../contracts/config.js';
import { PluginMounts, type MountPlan } from '../kernel/mounts.js';
import { PluginCatalog, type PluginPlan } from './catalog.js';

const publicServices = new Set(['harnessModels', 'harnessSessions']);

/** Product plugin adapter. The generic Cordis kernel never sees manifests or user settings. */
export class PluginHost {
  private readonly catalog: PluginCatalog;
  private readonly mounts: PluginMounts;

  constructor(readonly ctx: Context, directory: string, builtins: BuiltinPlugin[], rootServices: string[],
    private readonly sessionRecords: (sessionId: string, pluginId: string) => Promise<SessionRecords>) {
    this.catalog = new PluginCatalog(directory, builtins, rootServices);
    this.mounts = new PluginMounts(ctx);
  }

  private failedConfig = new Map<string, Record<string, unknown> | undefined>();
  private published: BrowserEntry[] = [];
  private readonly failures = new Map<string, string>();
  private readonly draining = new Set<string>();

  effective(settings: Settings) { return this.catalog.effective(settings); }
  browser() { return structuredClone(this.published); }
  metadata() {
    return this.catalog.metadata().map((metadata) => {
      const { id } = metadata;
      const error = metadata.error ?? (this.mounts.plan(id) ? undefined : this.failures.get(id));
      const state = this.draining.has(id) ? 'draining' : this.mounts.plan(id) ? 'ready' : error ? 'failed' : 'discovered';
      return { ...metadata, error, state } as const;
    });
  }
  reserved(id: string) { return this.catalog.reserved(id); }

  private async load(plan: PluginPlan): ReturnType<MountPlan['load']> {
    const builtin = this.catalog.builtins.get(plan.id);
    const mod = builtin || !plan.source ? undefined :
      await import(pathToFileURL(plan.source).href + '?v=' + lstatSync(plan.source).mtimeMs);
    const component = builtin ?? mod?.default;
    const setup = builtin || !plan.source
      ? (builtin?.setup ?? (() => {}))
      : (typeof component === 'function' ? component : component?.apply?.bind(component));
    if (typeof setup !== 'function') throw new Error('Expected a setup function or a Cordis component');
    const inject = [...new Set<string>(component?.inject ?? mod?.inject ?? [])];
    if (!builtin && inject.some((service) => !publicServices.has(service)))
      throw new Error('Unknown harness service dependency');
    return { inject, setup: async (ctx: Context) => {
      const values = Object.freeze(structuredClone(plan.config ?? {}));
      const cleanup = await setup(ctx, {
        config: values,
        defineConfig(defaults, validate) {
          const config = Object.freeze({ ...structuredClone(defaults), ...values });
          validate?.(config);
          return config;
        },
        registerTool: (tool) => ctx.effect(() => this.ctx.harnessTools.register(tool.name, () => tool)),
        registerRoute: (method, path, handler) => {
          if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ||
              !/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/.test(path)) throw new Error('Invalid plugin route');
          return ctx.effect(() => this.ctx.harnessRoutes.register(method, '/api/extensions/' + plan.id + path, handler));
        },
        records: {
          list: async (sessionId) => (await this.sessionRecords(sessionId, plan.id)).list(),
          append: async (sessionId, data) => (await this.sessionRecords(sessionId, plan.id)).append(data)
        },
        onDispose: (dispose) => { ctx.effect(() => dispose); }
      } satisfies PluginApi);
      if (typeof cleanup === 'function') ctx.effect(() => cleanup);
    } };
  }

  start(settings: Settings) { return this.configure(settings, undefined, true); }

  async configure(settings: Settings, commit = () => {}, starting = false) {
    const previouslyFailed = new Set(this.failures.keys());
    const failedConfig = new Map<string, Record<string, unknown> | undefined>();
    const unavailable = (id: string, error: unknown) => {
      this.failures.set(id, error instanceof Error ? error.message : String(error));
      if (this.catalog.builtins.get(id)?.required) return false;
      const config = settings.pluginConfig[id];
      const canSkip = starting || (this.failedConfig.has(id) && isDeepStrictEqual(config, this.failedConfig.get(id)));
      if (canSkip) failedConfig.set(id, config);
      return canSkip;
    };
    const candidate = this.catalog.plans(settings, unavailable);
    const plans: MountPlan[] = candidate.map((plan) => ({
      id: plan.id, requires: plan.requires,
      signature: { source: plan.source, requires: plan.requires, config: this.catalog.builtins.get(plan.id)?.configChanges === 'read-on-use' ? undefined : plan.config },
      load: async () => {
        const component = await this.load(plan).catch((error) => { unavailable(plan.id, error); throw error; });
        return { ...component, setup: async (ctx) => {
          try { await component.setup(ctx); this.failures.delete(plan.id); }
          catch (error) { this.failures.set(plan.id, String(error)); throw error; }
        } };
      }
    }));
    try {
      await this.mounts.configure(plans, () => {
        commit();
        this.failedConfig = failedConfig;
        for (const id of previouslyFailed) if (!settings.plugins[id]) this.failures.delete(id);
        this.published = candidate.filter(({ id }) => this.mounts.plan(id)).map(({ id, browser, web, browserRequires, config }) => ({
          id, browser, web, requires: browserRequires, config: browser || web ? config : {}, required: this.catalog.builtins.get(id)?.required
        }));
      }, (ids) => { for (const id of ids) this.draining.add(id); }, unavailable);
    } finally { this.draining.clear(); }
  }

  close() { return this.mounts.close(); }
}
