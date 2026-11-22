import type { Context } from 'cordis';
import { navigationSnapshot } from '../../src/transport/navigation-events.js';
import { supportsIsolation } from '../../src/platform/isolation.js';

/** Web shell projection: one bootstrap view assembled from registered capability ports. */
export function setup(ctx: Context) {
  ctx.effect(() => ctx.harnessRoutes.register('GET', '/api/bootstrap', () => ({
    settings: ctx.harnessSettings(),
    ...navigationSnapshot({ registry: ctx.harnessRegistry, plugins: { ctx } }),
    models: ctx.harnessPi.availableModels(),
    plugins: ctx.harnessPluginCatalog.metadata(),
    isolation: supportsIsolation(),
    providers: ctx.harnessProviderCatalog()
  })));
}
