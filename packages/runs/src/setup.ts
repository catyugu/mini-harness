import type {} from '@mini-harness/kernel/observations';
import type {} from '@mini-harness/sessions/store';
import type {} from '@mini-harness/kernel/scopes';
import type {} from '@mini-harness/kernel/mutation-api';
import type { Context } from 'cordis';
import { registerRoutes } from './routes.js';
import { executionForPlugin } from './execution.js';
import { Runs } from './runs.js';

export function setup(ctx: Context) {
  const { harnessRegistry: catalog, harnessScopes: scopes, harnessMutations: mutations } = ctx;
  const runs = new Runs(catalog, scopes, mutations, (event, signal) => ctx.emit('harness/observe', event, signal),
    (source) => ctx.bail('harness/run-selection', source));
  ctx.provide('harnessRuns', runs);
  ctx.provide('harnessExecution', {
    [executionForPlugin]: {
      launch: runs.submit.bind(runs),
      info: (id: string) => runs.info(id),
      cancel: (id: string) => runs.cancel(id)
    }
  });
  ctx.effect(() => () => runs.stop());
  ctx.on('harness/quiesce', () => runs.stop());
  ctx.effect(() => mutations.guard((keys) => keys ? runs.activeInScope(keys) : runs.size > 0));
  ctx.effect(() => catalog.beforeDelete({
    busy: (id) => runs.active(id),
    async quiesce(ids) {
      for (const id of ids) runs.cancel(id);
      await Promise.allSettled(ids.map((id) => runs.completion(id)));
    }
  }));
  registerRoutes(ctx);
}
