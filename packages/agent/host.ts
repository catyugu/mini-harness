import type { Context } from 'cordis';
import { registerRoutes } from './routes.js';
import { modelAdmin } from './model-ports.js';
import { PiSessions } from './pi-sessions.js';

export async function setup(ctx: Context) {
  const { harnessRegistry: catalog, harnessTools: tools, harnessSettingsStore: settings } = ctx;
  const pi = new PiSessions(ctx.harnessState.paths, catalog, tools, () => ctx.get('harnessSkills'),
    () => settings.settings.model, (model) => settings.rememberModel(model), (id, signal) => ctx.harnessScopes.prepare(id, signal),
    (event) => ctx.emit('harness/observe', event),
    (projection) => ctx.waterfall('harness/tool-projection', projection, () => projection.content));
  await pi.start();
  ctx.provide('harnessPi', pi);
  ctx.provide('harnessModels', {
    list: () => pi.availableModels(),
    async available() { await pi.models.getAvailable(); return pi.availableModels(); },
    resolve: (choice) => {
      const model = pi.resolveModel(choice);
      return model && pi.modelInfo(model);
    }
  });
  ctx.provide('harnessModelAdmin', modelAdmin(pi.models, (id) => pi.invalidateProviderSessions(id)));
  ctx.effect(() => async () => {
    await Promise.allSettled(pi.pending);
    pi.close();
    await pi.models.settleCredentialWrites();
  });
  ctx.effect(() => settings.validate((next) => { pi.resolveModel(next.model); }));
  ctx.effect(() => catalog.beforeDelete({
    busy: (id) => Boolean(pi.openingSession(id)),
    async quiesce(ids) { await Promise.allSettled(ids.map((id) => pi.openingSession(id))); },
    release(ids) { for (const id of ids) pi.release(id); }
  }));
  registerRoutes(ctx);
}
