import type {} from '@mini-harness/kernel/observations';
import type {} from '@mini-harness/sessions/store';
import type {} from '@mini-harness/kernel/scopes';
import type {} from '@mini-harness/plugin-api/mutation-api';
import type { Context } from 'cordis';
import { registerRoutes } from './routes.js';
import { Runs } from './runs.js';

export function setup(ctx: Context) {
  const { harnessRegistry: catalog, harnessScopes: scopes, harnessMutations: mutations } = ctx;
  const runs = new Runs(catalog, scopes, mutations, (event, signal) => ctx.emit('harness/observe', event, signal));
  ctx.provide('harnessRuns', runs);
  ctx.effect(() => () => runs.stop());
  ctx.effect(() => catalog.beforeDelete({
    busy: (id) => runs.active(id),
    async quiesce(ids) {
      for (const id of ids) runs.cancel(id);
      await Promise.allSettled(ids.map((id) => runs.completion(id)));
    }
  }));
  registerRoutes(ctx);
}
