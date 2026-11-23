import type { Context, Fiber } from 'cordis';
import { isDeepStrictEqual } from 'node:util';

/** Pure lifecycle plan. Discovery, settings, feature APIs and filesystem access belong to adapters. */
type Config = Record<string, unknown>;
type UpdateConfig = (next: Config) => Promise<void>;

export interface MountPlan {
  id: string;
  requires: string[];
  context?: Context;
  signature: unknown;
  config?: Config;
  load(): Promise<{ inject: string[]; setup(ctx: Context, signal: AbortSignal, setDrain: (drain: () => Promise<void>) => void, setConfig: (update: UpdateConfig) => void): void | Promise<void> }>;
}

type Loaded = Awaited<ReturnType<MountPlan['load']>>;
type Mounted = { plan: MountPlan; fiber: Fiber; loaded: Loaded; lifetime: AbortController;
  drain: () => Promise<void>; updateConfig?: UpdateConfig };
type ConfigUpdate = { mounted: Mounted; previous: Config; next: Config; plan: MountPlan };

/** Cordis fiber composition and rollback, independent of any product capability. */
export class PluginMounts {
  private readonly mounted = new Map<string, Mounted>();

  constructor(private readonly ctx: Context) {}

  plan(id: string) { return this.mounted.get(id)?.plan; }

  private async mount(plan: MountPlan, loaded: Loaded) {
    const lifetime = new AbortController();
    let fiber: Fiber | undefined;
    let drain = async () => {};
    let updateConfig: UpdateConfig | undefined;
    try {
      const { inject, setup } = loaded;
      fiber = (plan.context ?? this.ctx).inject(inject, (ctx) =>
        setup(ctx, lifetime.signal, (cleanup) => { drain = cleanup; }, (update) => { updateConfig = update; }));
      await fiber.await();
      this.mounted.set(plan.id, { plan, fiber, loaded, lifetime, drain, updateConfig });
    } catch (error) {
      lifetime.abort();
      try { await drain(); } finally { await fiber?.dispose(); }
      throw new Error('Plugin ' + plan.id + ': ' + (error instanceof Error ? error.message : String(error)), { cause: error });
    }
  }

  private async unmount(id: string) {
    const installed = this.mounted.get(id);
    if (!installed) return;
    this.mounted.delete(id);
    installed.lifetime.abort();
    try { await installed.drain(); } finally { await installed.fiber.dispose(); }
  }

  configure(ordered: MountPlan[], commit: () => void = () => {}, beforeChange: (ids: string[]) => void = () => {},
    unavailable?: (id: string, error: unknown) => boolean) {
    const desired = new Map(ordered.map((plan) => [plan.id, plan]));
    const affected = new Set([...this.mounted.values()]
      .filter(({ plan }) => plan.context !== desired.get(plan.id)?.context ||
        !isDeepStrictEqual(plan.signature, desired.get(plan.id)?.signature))
      .map(({ plan }) => plan.id));
    for (const plan of ordered) if (plan.requires.some((id) => affected.has(id))) affected.add(plan.id);
    const obsolete = [...this.mounted.values()].map(({ plan }) => plan).filter((plan) => affected.has(plan.id));
    const additions = ordered.filter((plan) => affected.has(plan.id) || !this.mounted.has(plan.id));
    const updates: ConfigUpdate[] = ordered.flatMap((plan) => {
      const value = this.mounted.get(plan.id);
      const previous = value?.plan.config;
      return value && previous && plan.config && !affected.has(plan.id) && !isDeepStrictEqual(previous, plan.config)
        ? [{ mounted: value, previous, next: plan.config, plan }] : [];
    });
    if (!obsolete.length && !additions.length && !updates.length) { commit(); return; }
    return this.apply(obsolete, additions, updates, commit, beforeChange, unavailable);
  }

  private async apply(obsolete: MountPlan[], additions: MountPlan[], updates: ConfigUpdate[], commit: () => void,
    beforeChange: (ids: string[]) => void, unavailable?: (id: string, error: unknown) => boolean) {
    const prepared = new Map<string, Loaded>();
    for (const plan of additions) {
      try { prepared.set(plan.id, await plan.load()); }
      catch (error) { if (!unavailable?.(plan.id, error)) throw error; }
    }
    const unloaded: { plan: MountPlan; loaded: Loaded }[] = [];
    const loaded: string[] = [];
    const applied: ConfigUpdate[] = [];
    try {
      beforeChange(obsolete.map(({ id }) => id));
      for (const plan of obsolete.reverse()) {
        const previous = this.mounted.get(plan.id);
        if (!previous) throw new Error('Cannot unmount missing plugin: ' + plan.id);
        unloaded.unshift(previous);
        await this.unmount(plan.id);
      }
      for (const plan of additions) {
        if (!prepared.has(plan.id)) continue;
        try {
          const missing = plan.requires.find((id) => !this.mounted.has(id));
          if (missing) throw new Error('Required plugin is unavailable: ' + missing);
          const preparedPlugin = prepared.get(plan.id);
          if (!preparedPlugin) throw new Error('Prepared plugin unavailable: ' + plan.id);
          await this.mount(plan, preparedPlugin);
          loaded.push(plan.id);
        } catch (error) { if (!unavailable?.(plan.id, error)) throw error; }
      }
      for (const update of updates) {
        if (!update.mounted.updateConfig) throw new Error('Missing live configuration handler: ' + update.plan.id);
        applied.push(update);
        await update.mounted.updateConfig(update.next);
      }
      commit();
      for (const update of applied) update.mounted.plan = update.plan;
    } catch (error) {
      const failures: unknown[] = [];
      for (const { mounted, previous } of applied.reverse()) {
        try { await mounted.updateConfig?.(previous); } catch (failure) { failures.push(failure); }
      }
      for (const id of loaded.reverse()) {
        try { await this.unmount(id); } catch (failure) { failures.push(failure); }
      }
      for (const { plan, loaded } of unloaded) {
        try { await this.mount(plan, plan.config ? await plan.load() : loaded); } catch (failure) { failures.push(failure); }
      }
      if (failures.length) throw new AggregateError([error, ...failures], 'Could not restore the previous plugin configuration');
      throw error;
    }
  }

  async close() {
    const failures: unknown[] = [];
    for (const id of [...this.mounted.keys()].reverse()) {
      try { await this.unmount(id); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Plugin cleanup failed');
  }
}
