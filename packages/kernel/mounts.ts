import type { Context, Fiber } from 'cordis';
import { isDeepStrictEqual } from 'node:util';

/** Pure lifecycle plan. Discovery, settings, feature APIs and filesystem access belong to adapters. */
export interface MountPlan {
  id: string;
  requires: string[];
  signature: unknown;
  load(): Promise<{ inject: string[]; setup(ctx: Context): void | Promise<void> }>;
}

/** Cordis fiber composition and rollback, independent of any product capability. */
export class PluginMounts {
  private readonly mounted = new Map<string, { plan: MountPlan; fiber: Fiber }>();

  constructor(private readonly ctx: Context) {}

  plan(id: string) { return this.mounted.get(id)?.plan; }

  private async mount(plan: MountPlan) {
    let fiber: Fiber | undefined;
    try {
      const { inject, setup } = await plan.load();
      fiber = this.ctx.inject(inject, setup);
      await fiber.await();
      this.mounted.set(plan.id, { plan, fiber });
    } catch (error) {
      await fiber?.dispose();
      throw new Error('Plugin ' + plan.id + ': ' + (error instanceof Error ? error.message : String(error)), { cause: error });
    }
  }

  private async unmount(id: string) {
    const installed = this.mounted.get(id);
    if (!installed) return;
    this.mounted.delete(id);
    await installed.fiber.dispose();
  }

  configure(ordered: MountPlan[], commit: () => void = () => {}, beforeChange: (ids: string[]) => void = () => {},
    unavailable?: (id: string, error: unknown) => boolean) {
    const desired = new Map(ordered.map((plan) => [plan.id, plan]));
    const affected = new Set([...this.mounted.values()]
      .filter(({ plan }) => !isDeepStrictEqual(plan.signature, desired.get(plan.id)?.signature))
      .map(({ plan }) => plan.id));
    for (const plan of ordered) if (plan.requires.some((id) => affected.has(id))) affected.add(plan.id);
    const obsolete = [...this.mounted.values()].map(({ plan }) => plan).filter((plan) => affected.has(plan.id));
    const additions = ordered.filter((plan) => affected.has(plan.id) || !this.mounted.has(plan.id));
    if (!obsolete.length && !additions.length) { commit(); return; }
    beforeChange(obsolete.map(({ id }) => id));
    return this.apply(obsolete, additions, commit, unavailable);
  }

  private async apply(obsolete: MountPlan[], additions: MountPlan[], commit: () => void,
    unavailable?: (id: string, error: unknown) => boolean) {
    const unloaded: MountPlan[] = [];
    const loaded: string[] = [];
    try {
      for (const plan of obsolete.reverse()) {
        unloaded.unshift(plan);
        await this.unmount(plan.id);
      }
      for (const plan of additions) {
        try {
          const missing = plan.requires.find((id) => !this.mounted.has(id));
          if (missing) throw new Error('Required plugin is unavailable: ' + missing);
          await this.mount(plan);
          loaded.push(plan.id);
        } catch (error) { if (!unavailable?.(plan.id, error)) throw error; }
      }
      commit();
    } catch (error) {
      const failures: unknown[] = [];
      for (const id of loaded.reverse()) {
        try { await this.unmount(id); } catch (failure) { failures.push(failure); }
      }
      for (const plan of unloaded) {
        try { await this.mount(plan); } catch (failure) { failures.push(failure); }
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
