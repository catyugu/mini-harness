import type { Context } from 'cordis';
import type { RunAgentPort } from '@mini-harness/contracts/agent';
import { registerRoutes } from './routes.js';
import { Runs } from './runs.js';

export function setup(ctx: Context) {
  const { harnessRegistry: catalog, harnessScopes: scopes } = ctx;
  const selected = (id: string) => scopes.require(id, 'harnessAgent');
  const agent: RunAgentPort = {
    async prompt(record, text, emit, options) {
      await scopes.prepare(record.id, options.signal);
      return selected(record.id).prompt(record, text, emit, options);
    },
    async revisionTarget(id, source, leaf) {
      await scopes.prepare(id);
      return selected(id).revisionTarget(id, source, leaf);
    },
    messages: (id) => selected(id).messages(id),
    async compact(id, signal) { await scopes.prepare(id, signal); return selected(id).compact(id, signal); }
  };
  const runs = new Runs(catalog, agent,
    (event, signal) => ctx.emit('harness/observe', event, signal),
    (id) => scopes.address(id), (keys) => ctx.harnessMutations.admit(keys));
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
