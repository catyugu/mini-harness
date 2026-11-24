import type { Context } from 'cordis';

export function setup(ctx: Context) {
  const { harnessSettingsStore: store, harnessPluginCatalog: plugins, harnessMutations: mutations, harnessRoutes: routes } = ctx;
  ctx.effect(() => routes.register('GET', '/api/settings', () => store.settings));
  ctx.effect(() => routes.register('PATCH', '/api/settings/plugins/:id', async ({ body, params, signal }) => {
    const patch = await body();
    return mutations.run(async () => {
      await plugins.writeBrowserConfig(params.id, patch, signal);
      return { ok: true };
    });
  }));
  ctx.effect(() => routes.register('PATCH', '/api/settings', async ({ body }) => {
    const patch = await body();
    return mutations.run(() => store.update(patch));
  }));
}
