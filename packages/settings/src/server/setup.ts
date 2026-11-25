import type { Context } from 'mini-harness/cordis';

export function setup(ctx: Context) {
  const changes = ctx.harnessChanges;
  ctx.effect(() => changes.register('settings'));
  ctx.effect(() => ctx.harnessProfileConfig.subscribe(() => changes.invalidate('settings')));
  const { harnessProfileConfig: store, harnessRoutes: routes } = ctx;
  ctx.effect(() => routes.register('GET', '/api/settings', () => store.settings));
  ctx.effect(() =>
    routes.register('PATCH', '/api/settings', async ({ body, signal }) => store.update(await body(), signal)),
  );
}
