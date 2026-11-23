import type { Context } from 'cordis';
import { browserEntries } from './manifest.js';

/** Web shell projection: one bootstrap view assembled from registered capability ports. */
export function setup(ctx: Context) {
  ctx.effect(() => ctx.harnessRoutes.register('GET', '/api/bootstrap', () => ({
    settings: ctx.harnessSettings(),
    ui: browserEntries,
    ...ctx.harnessNavigation(),
    models: ctx.harnessPi.availableModels(),
    plugins: ctx.harnessPluginCatalog.metadata(),
    providers: ctx.harnessProviderCatalog()
  })));
}
