import type { Context } from 'cordis';
import { Runs } from './runs.js';

/** Active work, streaming and cancellation are owned by Runs. */
export function setup(ctx: Context) {
  const runs = new Runs(ctx.harnessRegistry, ctx.harnessPi,
    () => ctx.harnessSettings().model,
    (id) => ctx.harnessOperations.assertAvailable(id),
    (record, task, signal) => ctx.harnessDelegation?.schedule(record, task, signal) ?? task());
  ctx.provide('harnessRuns', runs);
  ctx.provide('harnessRevision', { reviseAndStart: (id, input) => runs.reviseAndStart(id, input) });
}
