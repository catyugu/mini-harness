import type { Context } from 'cordis';
import { registerRoutes } from './routes.js';
import { PiSessions } from './pi-sessions.js';

export async function setup(ctx: Context) {
  const { harnessRegistry: catalog, harnessTools: tools, harnessSettingsStore: settings } = ctx;
  const pi = new PiSessions(ctx.harnessState.paths, catalog, tools, () => ctx.get('harnessSkills'),
    () => settings.settings.model, (model) => settings.rememberModel(model));
  await pi.start();
  ctx.provide('harnessPi', pi);
  ctx.provide('harnessModels', { list: () => pi.availableModels() });
  ctx.effect(() => settings.validate((next) => { pi.resolveModel(next.model); }));
  ctx.effect(() => catalog.beforeDelete({
    busy: (id) => Boolean(pi.openingSession(id)),
    async quiesce(ids) { await Promise.allSettled(ids.map((id) => pi.openingSession(id))); },
    release(ids) { for (const id of ids) pi.release(id); }
  }));
  registerRoutes(ctx);
}
