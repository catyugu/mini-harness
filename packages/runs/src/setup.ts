import { observe } from '@mini-harness/plugin-api/observations';
import { DomainError } from '@mini-harness/platform/errors';
import type { Context } from 'mini-harness/cordis';
import { registerRoutes } from './routes.ts';
import { sessionExecution } from './execution.ts';
import { Runs } from './runs.ts';

export function setup(ctx: Context) {
  const { harnessRegistry: catalog, harnessProfileScopes: scopes, harnessMutations: mutations } = ctx;
  const runs = new Runs(
    catalog,
    scopes,
    mutations,
    (event, signal) => observe(ctx, event, signal, catalog.runScope(event.sessionId)),
    ctx.harnessModelPreference,
  );
  ctx.provide('harnessRuns', runs);
  ctx.provide(
    'harnessExecution',
    sessionExecution(runs.submit.bind(runs), (id) => runs.info(id)),
  );
  ctx.effect(() => {
    const changed = (event: Event) => {
      if (event instanceof CustomEvent && event.detail.records) runs.branchChanged(event.detail.id);
    };
    catalog.events.addEventListener('change', changed);
    return () => catalog.events.removeEventListener('change', changed);
  });
  ctx.effect(() => () => runs.stop());
  ctx.on('harness/quiesce', () => runs.stop());
  ctx.effect(() =>
    mutations.guard((keys) => {
      if (keys ? runs.activeInScope(keys) : runs.size > 0)
        throw new DomainError(
          'conflict',
          'Stop the affected conversations before changing their providers or plugins',
        );
    }),
  );
  ctx.effect(() =>
    catalog.beforeDelete({
      busy: (id) => runs.active(id),
      async quiesce(ids) {
        for (const id of ids) runs.cancel(id);
        await Promise.allSettled(ids.map((id) => runs.completion(id)));
      },
    }),
  );
  ctx.inject(['harnessRoutes'], registerRoutes);
}
