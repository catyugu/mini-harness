import { observe } from '@mini-harness/plugin-api/observations';
import type { Context } from 'mini-harness/cordis';
import { registerRoutes } from './routes.ts';
import { SessionRun } from './session-run.ts';
import { Runs } from './runs.ts';

export function setup(ctx: Context) {
  const { harnessSessions: catalog, harnessProfileScopes: scopes } = ctx;
  const runs = new Runs(
    catalog,
    ctx.harnessTasks,
    scopes,
    (event, signal) => observe(ctx, event, signal, catalog.runScope(event.sessionId)),
    () => ctx.get('harnessModelPreference')?.recent(),
    new SessionRun(catalog),
  );
  ctx.provide('harnessRuns', runs);
  ctx.effect(() => {
    const changed = (event: Event) => {
      if (event instanceof CustomEvent && event.detail.record)
        runs.branchChanged(event.detail.id, event.detail.record);
    };
    catalog.events.addEventListener('change', changed);
    return () => catalog.events.removeEventListener('change', changed);
  });
  ctx.inject(['harnessRoutes'], registerRoutes);
}
