import { observe } from '@mini-harness/plugin-api/observations';
import type { Context } from 'mini-harness/cordis';
import { registerRoutes } from './routes.ts';
import { sessionExecution } from './execution.ts';
import { SessionRun } from './session-run.ts';
import { Runs } from './runs.ts';

export function setup(ctx: Context) {
  const { harnessSessions: catalog, harnessProfileScopes: scopes } = ctx;
  const runs = new Runs(
    catalog,
    scopes,
    (event, signal) => observe(ctx, event, signal, catalog.runScope(event.sessionId)),
    () => ctx.get('harnessModelPreference')?.recent(),
    new SessionRun(catalog),
  );
  ctx.provide('harnessRuns', runs);
  ctx.provide(
    'harnessExecution',
    sessionExecution(runs.submit.bind(runs), (id) => runs.info(id)),
  );
  ctx.effect(() => {
    const changed = (event: Event) => {
      if (event instanceof CustomEvent && event.detail.record)
        runs.branchChanged(event.detail.id, event.detail.record);
    };
    catalog.events.addEventListener('change', changed);
    return () => catalog.events.removeEventListener('change', changed);
  });
  ctx.effect(() => () => runs.stop());
  ctx.on('harness/quiesce', () => runs.stop());
  ctx.on('harness/seal', () => runs.seal());
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
