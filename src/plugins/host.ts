import type { Context } from 'cordis';
import { lstatSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { BuiltinPlugin, PluginApi, SessionRecords } from '../contracts/plugins.js';
import type { Settings } from '../config.js';
import { PluginMounts, type MountPlan } from '../kernel/mounts.js';
import { PluginCatalog, type PluginPlan } from './catalog.js';

const publicServices = new Set(['harnessModels', 'harnessSessions']);

/** Product plugin adapter. The generic Cordis kernel never sees manifests or user settings. */
export class PluginHost {
  private readonly catalog: PluginCatalog;
  private readonly mounts: PluginMounts;

  constructor(readonly ctx: Context, directory: string, builtins: BuiltinPlugin[],
    private readonly sessionRecords: (sessionId: string, pluginId: string) => Promise<SessionRecords>) {
    this.catalog = new PluginCatalog(directory, builtins);
    this.mounts = new PluginMounts(ctx);
  }

  metadata() { return this.catalog.metadata(); }

  private async load(plan: PluginPlan): ReturnType<MountPlan['load']> {
    const builtin = this.catalog.builtins.get(plan.id);
    const mod = builtin || !plan.source ? undefined :
      await import(pathToFileURL(plan.source).href + '?v=' + lstatSync(plan.source).mtimeMs);
    const component = builtin ?? mod?.default ?? mod?.apply;
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

  configure(settings: Settings, commit = () => {}, beforeChange = () => {}) {
    const plans: MountPlan[] = this.catalog.plans(settings).map((plan) => ({
      id: plan.id, requires: plan.requires,
      signature: { id: plan.id, source: plan.source, requires: plan.requires, config: plan.config },
      load: () => this.load(plan)
    }));
    return this.mounts.configure(plans, commit, beforeChange);
  }

  configuration(id: string) {
    const signature = this.mounts.plan(id)?.signature as { config?: Record<string, unknown> } | undefined;
    return structuredClone(signature?.config ?? {});
  }

  close() { return this.mounts.close(); }
}
