import type { Context } from 'cordis';

/** Web shell projection: one bootstrap view assembled from registered capability ports. */
export function setup(ctx: Context) {
  ctx.effect(() => ctx.harnessRoutes.register('GET', '/api/bootstrap', () => ({
    settings: ctx.harnessSettings(),
    ...ctx.harnessNavigation(),
    models: ctx.harnessPi.availableModels(),
    plugins: ctx.harnessPluginCatalog.metadata(),
    providers: ctx.harnessProviderCatalog()
  })));
}
