import type { Context } from 'cordis';
import { registerRoutes } from './routes.js';
import { join } from 'node:path';
import { Runs } from './runs.js';
import { Checkpoints } from './checkpoints.js';

export function setup(ctx: Context) {
  const { harnessRegistry: catalog } = ctx;
  const checkpoints = new Checkpoints(join(ctx.harnessState.paths.home, 'runs.json'), (id) => Boolean(catalog.get(id)));
  const runs = new Runs(catalog, ctx.harnessPi, checkpoints, () => ctx.harnessSettings().model, ctx.harnessModels,
    (event) => ctx.emit('harness/observe', event));
  ctx.provide('harnessRuns', runs);
  ctx.effect(() => () => runs.stop());
  ctx.effect(() => catalog.beforeDelete({
    busy: (id) => runs.active(id),
    async quiesce(ids) {
      for (const id of ids) runs.cancel(id);
      await Promise.allSettled(ids.map((id) => runs.completion(id)));
    }
  }));
  ctx.effect(() => {
    const onChange = (event: CustomEvent<{ id: string; deleted: boolean }>) => {
      if (event.detail.deleted) checkpoints.remove(event.detail.id);
    };
    catalog.events.addEventListener('change', onChange);
    return () => catalog.events.removeEventListener('change', onChange);
  });
  registerRoutes(ctx);
}
