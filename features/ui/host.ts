import type { Context } from 'cordis';
import { navigationSnapshot } from '../sessions/navigation.js';

/** Web shell projection: one bootstrap view assembled from registered capability ports. */
export function setup(ctx: Context) {
  ctx.effect(() => ctx.harnessRoutes.register('GET', '/api/bootstrap', () => ({
    settings: ctx.harnessSettings(),
    ...navigationSnapshot({ registry: ctx.harnessRegistry, plugins: { ctx } }),
    models: ctx.harnessPi.availableModels(),
    plugins: ctx.harnessPluginCatalog.metadata(),
    providers: ctx.harnessProviderCatalog()
  })));
}
